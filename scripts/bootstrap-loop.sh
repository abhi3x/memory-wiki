#!/usr/bin/env bash
#
# bootstrap-loop.sh
#
# Iteratively processes pending Claude Code sessions, one at a time, through a
# fresh `claude -p` invocation per session. Each turn fits in one context window —
# no single-dump context overflow.
#
# Usage:
#   bootstrap-loop.sh [--exclude-project <substr>]... [--include-project <substr>]...
#                     [--limit N]                  # Stop after N sessions (useful for piloting)
#                     [--after dream]              # Run wiki-dream.sh after the loop finishes
#                     [--model MODEL]              # Claude model for each ingest subprocess
#                                                  #   Default: claude-haiku-4-5-20251001 (~5× cheaper than Opus,
#                                                  #   ~3× faster; ingest is pattern extraction, not deep reasoning)
#                     [--include-trivial]          # Don't skip 0/1/2-turn sessions. Default skips <3 turns.
#                     [--min-turns N]              # Override the trivial-skip threshold (default 3)
#                     [--dry-run]                  # Show what would run
#
# Assumes wiki-extract.js is installed at ~/memory-wiki/scripts/wiki-extract.js
# and a working `claude` CLI is on PATH.
#
# Each iteration:
#   1. Extract next pending session's clean text summary
#   2. Pipe it into `claude -p "<wiki-update prompt>"` — Claude reads + updates wiki
#   3. Mark the session as processed
#   4. Sleep briefly so Ctrl-C has a window to land
#
# The prompt given to Claude instructs it to follow ~/memory-wiki/_schema.md for
# structure, page types, and rules.

set -euo pipefail

EXTRACT="${HOME}/memory-wiki/scripts/wiki-extract.js"
DREAM="${HOME}/memory-wiki/scripts/wiki-dream.sh"
DRY_RUN=0
LIMIT=0
AFTER=""
MODEL="claude-haiku-4-5-20251001"
MIN_TURNS=3
INCLUDE_TRIVIAL=0
FILTER_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --after) AFTER="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --min-turns) MIN_TURNS="$2"; shift 2 ;;
    --include-trivial) INCLUDE_TRIVIAL=1; shift ;;
    --exclude-project|--include-project) FILTER_ARGS+=("$1" "$2"); shift 2 ;;
    -h|--help)
      sed -n '3,28p' "$0"
      exit 0
      ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

# Compose the full filter arg list — project filters + trivial-skip
SIZE_ARGS=()
if [[ $INCLUDE_TRIVIAL -eq 0 ]]; then
  SIZE_ARGS+=(--min-turns "$MIN_TURNS")
fi
ALL_FILTER_ARGS=("${FILTER_ARGS[@]}" "${SIZE_ARGS[@]}")

if [[ ! -x "$(command -v node)" ]]; then
  echo "node not on PATH" >&2; exit 1
fi
if [[ ! -f "$EXTRACT" ]]; then
  echo "wiki-extract.js not found at $EXTRACT" >&2; exit 1
fi
if [[ ! -x "$(command -v claude)" ]]; then
  echo "claude CLI not on PATH" >&2; exit 1
fi

# Gather pending session paths (while-read loop for bash 3.2 compatibility — macOS default)
SESSIONS=()
while IFS= read -r line; do
  [[ -n "$line" ]] && SESSIONS+=("$line")
done < <(node "$EXTRACT" --list-pending "${ALL_FILTER_ARGS[@]}")

COUNT=${#SESSIONS[@]}
if (( LIMIT > 0 && LIMIT < COUNT )); then
  SESSIONS=("${SESSIONS[@]:0:LIMIT}")
  echo "Found $COUNT pending session(s); limiting to first $LIMIT"
  COUNT=$LIMIT
else
  echo "Found $COUNT pending session(s)"
fi
[[ $COUNT -eq 0 ]] && exit 0

if [[ $DRY_RUN -eq 1 ]]; then
  printf '%s\n' "${SESSIONS[@]}"
  echo
  echo "[dry-run] would process $COUNT sessions"
  exit 0
fi

PROMPT='Read the session summary on stdin and update the personal memory wiki per ~/memory-wiki/_schema.md.

Rules:
- Create/update pages under global/ or projects/ as the schema directs.
- Update _index.md after any page changes; append an entry to _log.md for this ingest.
- Skip trivial/transient content.
- Redact any credentials or secrets.
- When done, commit to git with message "ingest: <session-id> (<N> pages touched)" if the wiki is a git repo.
- Then print a ONE-LINE summary of what changed (created X, updated Y) — nothing else.
- If you cannot create any pages (e.g. permission blocks), say so clearly and do NOT commit.'

WIKI_DIR="${HOME}/memory-wiki"

# Resolve "wiki HEAD" used for side-effect detection. Script only marks a session
# processed when HEAD actually advances — silent failures (blocked writes, no-op
# runs) leave the session pending for retry rather than being marked done.
wiki_head() {
  git -C "$WIKI_DIR" rev-parse HEAD 2>/dev/null || echo "no-git"
}

INDEX=0
for s in "${SESSIONS[@]}"; do
  INDEX=$((INDEX + 1))
  echo
  echo "─── [$INDEX/$COUNT] $(basename "$s") ───"

  HEAD_BEFORE=$(wiki_head)

  # --add-dir makes ~/memory-wiki a trusted working dir for the subprocess.
  # --permission-mode bypassPermissions allows the fully-autonomous loop to
  # write the wiki without interactive prompts. The wiki is local-only and
  # under git, so the worst-case cost of a bad ingest is a git reset --hard.
  if ! node "$EXTRACT" --session "$s" | \
       claude -p --model "$MODEL" --add-dir "$WIKI_DIR" --permission-mode bypassPermissions "$PROMPT"; then
    echo "WARN: claude invocation failed for $s — leaving unprocessed, moving on." >&2
    sleep 1
    continue
  fi

  HEAD_AFTER=$(wiki_head)
  if [[ "$HEAD_BEFORE" == "$HEAD_AFTER" ]]; then
    echo "WARN: wiki HEAD did not advance for $s — no commit made. Leaving unprocessed for retry." >&2
    sleep 1
    continue
  fi

  node "$EXTRACT" --mark-processed "$s" >/dev/null
  sleep 1
done

echo
echo "Done. Processed $INDEX session(s)."

if [[ "$AFTER" == "dream" ]]; then
  if [[ -x "$DREAM" ]]; then
    echo
    echo "── Post-loop: running dream ──"
    "$DREAM" "${FILTER_ARGS[@]}"
  else
    echo "WARN: --after dream requested but $DREAM not executable" >&2
  fi
fi
