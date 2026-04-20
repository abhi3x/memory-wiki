#!/usr/bin/env bash
#
# wiki-dream.sh — Claude dreams.
#
# The periodic consolidation ritual that keeps the three-tier memory model
# coherent. Run manually when you feel like it; add to cron once you trust
# the behavior.
#
# Pipeline:
#
#   1. MECHANICAL (wiki-consolidate.js, pure Node, always auto-applied):
#       (ii) Replace MEMORY.md entries that have been promoted to the wiki
#            with a one-line stub.
#       (iv) Regenerate CLAUDE.md pointer manifests from current wiki state.
#
#   2. LLM PROMOTE (claude -p, auto-applied):
#       (i) For MEMORY.md entries NOT yet promoted: Claude reads them and,
#           if worth promoting, creates the wiki page (including
#           promoteFromMemory: <basename> frontmatter so future dreams prune).
#
#   3. LLM LINT (claude -p, PROPOSE-ONLY):
#       (iii) Duplicate pages to merge, oversized pages to split.
#       (v)   Contradictions, orphan pages, concept gaps, suggested sources.
#       Written to ~/.claude/wiki/_dream-report-YYYY-MM-DD.md for triage.
#       Destructive changes land only after human approval.
#
# Usage:
#   wiki-dream.sh [--exclude-project <substr>]... [--include-project <substr>]...
#                 [--skip-llm]          # Only mechanical pass (safe, offline)
#                 [--dry-run]           # Show mechanical pass, skip writes and LLM
#                 [--report-only]       # Only generate the lint report; no promotion pass

set -euo pipefail

WIKI="${HOME}/.claude/wiki"
CONSOLIDATE="${WIKI}/scripts/wiki-consolidate.js"
EXTRACT="${WIKI}/scripts/wiki-extract.js"

DRY_RUN=0
SKIP_LLM=0
REPORT_ONLY=0
FILTER_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --skip-llm) SKIP_LLM=1; shift ;;
    --report-only) REPORT_ONLY=1; shift ;;
    --exclude-project|--include-project) FILTER_ARGS+=("$1" "$2"); shift 2 ;;
    -h|--help) sed -n '3,32p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

if [[ ! -x "$(command -v node)" ]]; then echo "node not on PATH" >&2; exit 1; fi
if [[ ! -f "$CONSOLIDATE" ]]; then echo "wiki-consolidate.js not found at $CONSOLIDATE" >&2; exit 1; fi

DATE=$(date +%Y-%m-%d)
REPORT="${WIKI}/_dream-report-${DATE}.md"

echo
echo "════════════════════════════════════════════════════════════════════"
echo "  Claude dreams ($(date '+%H:%M:%S'))"
echo "════════════════════════════════════════════════════════════════════"

# ── Step 1: mechanical consolidation ────────────────────────────────────────
echo
echo "── 1. Mechanical pass (prune promoted MEMORY.md, regen CLAUDE.md manifests) ──"
if [[ $DRY_RUN -eq 1 ]]; then
  node "$CONSOLIDATE" --dry-run "${FILTER_ARGS[@]}"
else
  node "$CONSOLIDATE" "${FILTER_ARGS[@]}"
fi

if [[ $SKIP_LLM -eq 1 || $DRY_RUN -eq 1 ]]; then
  echo
  echo "Skipping LLM passes (flag set). Done."
  exit 0
fi

if [[ ! -x "$(command -v claude)" ]]; then
  echo "claude CLI not on PATH — cannot run LLM passes." >&2
  exit 0
fi

# ── Step 2: LLM promotion pass ──────────────────────────────────────────────
if [[ $REPORT_ONLY -eq 0 ]]; then
  echo
  echo "── 2. LLM promotion pass (MEMORY.md → wiki for entries worth promoting) ──"

  # Collect unpromoted memory files across all projects (respecting filters).
  # A memory file is "unpromoted" if it has no `<!-- promoted-to-wiki -->` marker.
  PROMOTION_INPUT=$(mktemp -t wiki-dream-promote.XXXXXX)
  node -e '
    const fs = require("fs"), path = require("path"), os = require("os");
    const ROOT = path.join(os.homedir(), ".claude", "projects");
    const args = process.argv.slice(1);
    const excl = []; const incl = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--exclude-project") excl.push(args[i+1]);
      if (args[i] === "--include-project") incl.push(args[i+1]);
    }
    try {
      const dirs = fs.readdirSync(ROOT, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .filter(d => {
          if (incl.length && !incl.some(p => d.name.includes(p))) return false;
          if (excl.some(p => d.name.includes(p))) return false;
          return true;
        });
      for (const d of dirs) {
        const memDir = path.join(ROOT, d.name, "memory");
        let files = [];
        try { files = fs.readdirSync(memDir).filter(f => f.endsWith(".md") && f !== "MEMORY.md"); }
        catch { continue; }
        for (const f of files) {
          const full = path.join(memDir, f);
          const body = fs.readFileSync(full, "utf-8");
          if (body.includes("<!-- promoted-to-wiki -->")) continue;
          console.log("===== " + full + " =====");
          console.log(body);
          console.log();
        }
      }
    } catch {}
  ' "${FILTER_ARGS[@]}" > "$PROMOTION_INPUT"

  if [[ -s "$PROMOTION_INPUT" ]]; then
    PROMOTE_PROMPT='You are in the LLM promotion pass of Claude dreams. On stdin is a concatenation of unpromoted MEMORY.md entries from across all project memory dirs.

For EACH entry:

1. Decide if it is worth promoting to the wiki. Worth promoting means: durable knowledge (not session scratch), recurring (shows up more than once across projects), or explicitly marked critical by Abhishek.

2. For entries worth promoting:
   - Create/update the wiki page under ~/.claude/wiki/ per ~/.claude/wiki/_schema.md.
   - Include `promoteFromMemory: <basename-without-md>` in the frontmatter so a future dream can prune the source stub.
   - Set `alwaysLoad: true` ONLY if this is genuinely critical-in-every-session (identity, non-negotiable rules, core comms). Otherwise leave false.
   - Do NOT modify the source MEMORY.md entry — the next dream cycle will prune it mechanically.

3. For entries not worth promoting, skip silently.

4. Commit any wiki changes to git with a message like "dream: promote <N> memory entr(ies) to wiki".

5. Print a brief summary of what you created/updated.'

    claude -p --add-dir "$WIKI" --permission-mode bypassPermissions "$PROMOTE_PROMPT" < "$PROMOTION_INPUT" || echo "WARN: promotion pass exited non-zero" >&2
  else
    echo "No unpromoted MEMORY.md entries found. Skipping promotion pass."
  fi
  rm -f "$PROMOTION_INPUT"

  # After promotion, re-run mechanical so newly-promoted entries get pruned + manifests refreshed.
  echo
  echo "── Re-running mechanical pass to catch newly-promoted entries ──"
  node "$CONSOLIDATE" "${FILTER_ARGS[@]}"
fi

# ── Step 3: LLM lint (propose only) ─────────────────────────────────────────
echo
echo "── 3. LLM lint — write proposed destructive changes to $REPORT ──"
LINT_PROMPT="You are running the lint pass of Claude dreams. Inspect ~/.claude/wiki/ and produce a report at ~/.claude/wiki/_dream-report-${DATE}.md.

Rules:
- Do NOT apply any destructive changes. Write proposals only.
- Report format: a markdown file with sections: ## Duplicates, ## Oversized pages, ## Contradictions, ## Orphans, ## Concept gaps, ## Suggested sources to seek out, ## Applied (non-destructive only).
- For each proposed destructive change, include: the affected files, what to do, and why.
- Safe non-destructive changes (adding missing [[related]] links, normalizing frontmatter, fixing typos) — apply those directly AND also list under Applied.
- Commit any safe changes to git with message \"dream: lint pass YYYY-MM-DD (N safe fixes, M proposals)\".
- When done, print ONE LINE: the relative path to the report + a short summary."

  claude -p --add-dir "$WIKI" --permission-mode bypassPermissions "$LINT_PROMPT" || echo "WARN: lint pass exited non-zero" >&2

echo
echo "════════════════════════════════════════════════════════════════════"
echo "  Dream complete. Report: $REPORT"
echo "  Review proposals, then re-run with destructive changes if you approve."
echo "════════════════════════════════════════════════════════════════════"
