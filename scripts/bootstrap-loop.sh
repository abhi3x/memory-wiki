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
#                     [--limit N]                 # Stop after N sessions (useful for piloting)
#                     [--dry-run]                 # Show what would run
#
# Assumes wiki-extract.js is installed at ~/.claude/wiki/scripts/wiki-extract.js
# and a working `claude` CLI is on PATH.
#
# Each iteration:
#   1. Extract next pending session's clean text summary
#   2. Pipe it into `claude -p "<wiki-update prompt>"` — Claude reads + updates wiki
#   3. Mark the session as processed
#   4. Sleep briefly so Ctrl-C has a window to land
#
# The prompt given to Claude instructs it to follow ~/.claude/wiki/_schema.md for
# structure, page types, and rules.

set -euo pipefail

EXTRACT="${HOME}/.claude/wiki/scripts/wiki-extract.js"
DRY_RUN=0
LIMIT=0
FILTER_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --exclude-project|--include-project) FILTER_ARGS+=("$1" "$2"); shift 2 ;;
    -h|--help)
      sed -n '3,25p' "$0"
      exit 0
      ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

if [[ ! -x "$(command -v node)" ]]; then
  echo "node not on PATH" >&2; exit 1
fi
if [[ ! -f "$EXTRACT" ]]; then
  echo "wiki-extract.js not found at $EXTRACT" >&2; exit 1
fi
if [[ ! -x "$(command -v claude)" ]]; then
  echo "claude CLI not on PATH" >&2; exit 1
fi

# Gather pending session paths
mapfile -t SESSIONS < <(node "$EXTRACT" --list-pending "${FILTER_ARGS[@]}")

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

PROMPT='Read the session summary on stdin and update the personal memory wiki per ~/.claude/wiki/_schema.md.

Rules:
- Create/update pages under global/ or projects/ as the schema directs.
- Update _index.md after any page changes; append an entry to _log.md for this ingest.
- Skip trivial/transient content.
- Redact any credentials or secrets.
- When done, commit to git with message "ingest: <session-id> (<N> pages touched)" if the wiki is a git repo.
- Then print a ONE-LINE summary of what changed (created X, updated Y) — nothing else.'

INDEX=0
for s in "${SESSIONS[@]}"; do
  INDEX=$((INDEX + 1))
  echo
  echo "─── [$INDEX/$COUNT] $(basename "$s") ───"

  if ! node "$EXTRACT" --session "$s" | claude -p "$PROMPT"; then
    echo "WARN: claude invocation failed for $s — leaving unprocessed, moving on." >&2
    sleep 1
    continue
  fi

  node "$EXTRACT" --mark-processed "$s" >/dev/null
  sleep 1
done

echo
echo "Done. Processed $INDEX session(s)."
