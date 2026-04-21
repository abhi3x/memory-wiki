#!/usr/bin/env bash
#
# install.sh — one-shot installer for memory-wiki.
#
# Copies scripts + schema + starter files into ~/memory-wiki/, wires up the
# Stop hook in ~/.claude/settings.json (idempotent), and offers to run the
# first sync. Safe to re-run — skips steps that are already done.
#
# Usage (from the repo root):
#   bash scripts/install.sh            # interactive (prompts for optional steps)
#   bash scripts/install.sh --yes      # non-interactive; accept every optional step
#   bash scripts/install.sh --no-hook  # skip Stop hook injection
#   bash scripts/install.sh --no-sync  # skip first sync
#
# Env equivalents (useful for CI / piped installs where stdin isn't a TTY):
#   MEMORY_WIKI_YES=1           same as --yes
#   MEMORY_WIKI_INSTALL_HOOK=1  inject the Stop hook without prompting
#   MEMORY_WIKI_RUN_SYNC=1      run first sync without prompting
#
# When stdin is not a TTY and none of the above are set, optional steps are
# skipped rather than left hanging on a `read` prompt.

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WIKI_DIR="${HOME}/memory-wiki"
CLAUDE_SETTINGS="${HOME}/.claude/settings.json"

YES=0
HOOK_FLAG="ask"   # ask | yes | no
SYNC_FLAG="ask"   # ask | yes | no
for arg in "$@"; do
  case "$arg" in
    --yes|-y) YES=1 ;;
    --no-hook) HOOK_FLAG="no" ;;
    --hook) HOOK_FLAG="yes" ;;
    --no-sync) SYNC_FLAG="no" ;;
    --sync) SYNC_FLAG="yes" ;;
    -h|--help)
      sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done
[[ "${MEMORY_WIKI_YES:-0}" == "1" ]] && YES=1
[[ "${MEMORY_WIKI_INSTALL_HOOK:-0}" == "1" ]] && HOOK_FLAG="yes"
[[ "${MEMORY_WIKI_RUN_SYNC:-0}" == "1" ]] && SYNC_FLAG="yes"

# Resolve ask-mode decisions now, so every prompt has a deterministic answer
# when stdin isn't a TTY. Default when non-interactive: skip (safer).
interactive=0; [[ -t 0 ]] && interactive=1

echo
echo "════════════════════════════════════════════════════════════════════"
echo "  memory-wiki installer"
echo "  Repo: $REPO_ROOT"
echo "  Install target: $WIKI_DIR"
echo "════════════════════════════════════════════════════════════════════"
echo

# ── 1. Required commands ────────────────────────────────────────────────────
for cmd in node git claude; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "✗ '$cmd' not found on PATH." >&2
    case "$cmd" in
      node) echo "  → Install Node.js 18+ via https://nodejs.org/ or your package manager." >&2 ;;
      git) echo "  → Install git (usually already present on macOS/Linux)." >&2 ;;
      claude) echo "  → Install Claude Code via https://claude.com/claude-code." >&2 ;;
    esac
    exit 1
  fi
done
echo "✓ node, git, claude — all on PATH"

NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if (( NODE_MAJOR < 18 )); then
  echo "✗ Node.js version is $(node -v); 18+ required." >&2
  exit 1
fi
echo "✓ Node $(node -v) (≥18)"
echo

# ── 2. Create wiki directory structure ──────────────────────────────────────
mkdir -p "$WIKI_DIR"/{global/{entities,decisions,patterns,preferences,troubleshooting},projects,scripts}
echo "✓ Directory structure ready at $WIKI_DIR"

# ── 3. Copy scripts + schema ────────────────────────────────────────────────
# install.sh is a setup tool, not a runtime script — keep it out of the
# installed wiki dir so users only see things they actually run day-to-day.
cp "$REPO_ROOT"/scripts/*.js "$WIKI_DIR"/scripts/
for sh in "$REPO_ROOT"/scripts/*.sh; do
  base="$(basename "$sh")"
  [[ "$base" == "install.sh" ]] && continue
  cp "$sh" "$WIKI_DIR"/scripts/
done
chmod +x "$WIKI_DIR"/scripts/*.js "$WIKI_DIR"/scripts/*.sh

# Schema is always overwritten (source of truth). Index + log are seeded only if missing.
cp "$REPO_ROOT"/_schema.md "$WIKI_DIR"/_schema.md
[[ -f "$WIKI_DIR/_index.md" ]] || cp "$REPO_ROOT"/_index.md "$WIKI_DIR"/_index.md
[[ -f "$WIKI_DIR/_log.md" ]] || cp "$REPO_ROOT"/_log.md "$WIKI_DIR"/_log.md

# Config: copy example if no user config yet. Never overwrite existing config.
if [[ ! -f "$WIKI_DIR/wiki-config.json" ]]; then
  cp "$REPO_ROOT"/wiki-config.example.json "$WIKI_DIR"/wiki-config.json
  echo "✓ Seeded $WIKI_DIR/wiki-config.json from example — edit before first --migrate"
else
  echo "✓ Existing wiki-config.json preserved"
fi
echo "✓ Scripts + schema installed"

# ── 4. Init git in the wiki (if not already a repo) ─────────────────────────
if [[ ! -d "$WIKI_DIR/.git" ]]; then
  (cd "$WIKI_DIR" && git init -q && {
    cat > .gitignore <<'EOF'
.DS_Store
_processed.json
_dream-report-*.md
wiki-config.json
EOF
    git add -A && git commit -q -m "chore: baseline from memory-wiki installer"
  })
  echo "✓ Git repo initialized at $WIKI_DIR"
else
  echo "✓ Git repo already exists"
fi

# ── 5. Wire up Stop hook in ~/.claude/settings.json ─────────────────────────
if [[ ! -f "$CLAUDE_SETTINGS" ]]; then
  echo "✗ $CLAUDE_SETTINGS not found. Install Claude Code first, run once to create it, then re-run this installer." >&2
  exit 1
fi

# Check if hook already present. `|| true` so set -e doesn't kill us if grep
# exits 1 on no-match or the file is transiently unreadable.
hook_present=0
if grep -q "memory-wiki/scripts/session-pending.js" "$CLAUDE_SETTINGS" 2>/dev/null; then
  hook_present=1
fi

if (( hook_present == 1 )); then
  echo "✓ Stop hook already wired into $CLAUDE_SETTINGS"
else
  echo
  echo "The installer can add a Stop hook to $CLAUDE_SETTINGS so new sessions"
  echo "are flagged for later ingest. This is a small, reversible edit."
  echo
  cat <<'EOF'
Add (manually or via this installer) to ~/.claude/settings.json:

  "hooks": {
    "Stop": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "node ~/memory-wiki/scripts/session-pending.js" }]
    }]
  }
EOF
  echo

  # Resolve decision: explicit flag > --yes > TTY prompt > skip (non-interactive).
  do_hook="no"
  case "$HOOK_FLAG" in
    yes) do_hook="yes" ;;
    no)  do_hook="no" ;;
    ask)
      if (( YES == 1 )); then
        do_hook="yes"
      elif (( interactive == 1 )); then
        read -r -p "Add hook automatically via node+fs? [y/N] " ANSWER
        [[ "$ANSWER" =~ ^[Yy]$ ]] && do_hook="yes"
      else
        echo "  → Non-interactive shell; skipping hook injection. Re-run with --hook or MEMORY_WIKI_INSTALL_HOOK=1 to enable."
      fi
      ;;
  esac

  if [[ "$do_hook" == "yes" ]]; then
    node - "$CLAUDE_SETTINGS" <<'NODE'
const fs = require('fs');
const p = process.argv[2];
const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
cfg.hooks = cfg.hooks || {};
cfg.hooks.Stop = cfg.hooks.Stop || [];
const already = JSON.stringify(cfg.hooks.Stop).includes('memory-wiki/scripts/session-pending.js');
if (!already) {
  cfg.hooks.Stop.push({
    matcher: "",
    hooks: [{ type: "command", command: "node ~/memory-wiki/scripts/session-pending.js" }]
  });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
  console.log("✓ Stop hook added to", p);
} else {
  console.log("✓ Stop hook already present");
}
NODE
  else
    echo "  → Skipped. Add the snippet yourself to enable new-session tracking."
  fi
fi

# ── 6. Optional: first sync ─────────────────────────────────────────────────
echo
# Default behavior differs from the hook prompt: first sync is safe and
# non-destructive, so the interactive default is [Y/n]. Non-interactive still
# skips unless explicitly opted in, to keep CI-style runs predictable.
do_sync="no"
case "$SYNC_FLAG" in
  yes) do_sync="yes" ;;
  no)  do_sync="no" ;;
  ask)
    if (( YES == 1 )); then
      do_sync="yes"
    elif (( interactive == 1 )); then
      read -r -p "Run 'wiki-sync.js --sync-only' now to generate CLAUDE.md pointer manifests? [Y/n] " ANSWER
      [[ ! "$ANSWER" =~ ^[Nn]$ ]] && do_sync="yes"
    else
      echo "  → Non-interactive shell; skipping first sync. Re-run with --sync or MEMORY_WIKI_RUN_SYNC=1 to enable."
    fi
    ;;
esac

if [[ "$do_sync" == "yes" ]]; then
  node "$WIKI_DIR"/scripts/wiki-sync.js --sync-only
fi

echo
echo "════════════════════════════════════════════════════════════════════"
echo "  Install complete."
echo
echo "  Next steps:"
echo "    1. Edit $WIKI_DIR/wiki-config.json — add your project keyword rules."
echo "    2. (Optional) Migrate existing Claude memory files into the wiki:"
echo "         node $WIKI_DIR/scripts/wiki-sync.js --migrate --dry-run"
echo "         node $WIKI_DIR/scripts/wiki-sync.js --migrate"
echo "    3. Bootstrap your history:"
echo "         $WIKI_DIR/scripts/bootstrap-loop.sh --limit 2        # pilot"
echo "         $WIKI_DIR/scripts/bootstrap-loop.sh                  # full run"
echo "    4. Periodic consolidation:"
echo "         $WIKI_DIR/scripts/wiki-dream.sh"
echo "════════════════════════════════════════════════════════════════════"
