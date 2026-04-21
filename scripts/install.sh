#!/usr/bin/env bash
#
# install.sh — one-shot installer for memory-wiki.
#
# Copies scripts + schema + starter files into ~/memory-wiki/, wires up the
# Stop hook in ~/.claude/settings.json (idempotent), and offers to run the
# first sync. Safe to re-run — skips steps that are already done.
#
# Usage (from the repo root):
#   bash scripts/install.sh

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WIKI_DIR="${HOME}/memory-wiki"
CLAUDE_SETTINGS="${HOME}/.claude/settings.json"

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
cp "$REPO_ROOT"/scripts/*.js "$WIKI_DIR"/scripts/
cp "$REPO_ROOT"/scripts/*.sh "$WIKI_DIR"/scripts/
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
_pending.jsonl
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

# Check if hook already present
if grep -q "memory-wiki/scripts/session-pending.js" "$CLAUDE_SETTINGS"; then
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
  read -r -p "Add hook automatically via node+fs? [y/N] " ANSWER
  if [[ "$ANSWER" =~ ^[Yy]$ ]]; then
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
read -r -p "Run 'wiki-sync.js --sync-only' now to generate CLAUDE.md pointer manifests? [Y/n] " ANSWER
if [[ ! "$ANSWER" =~ ^[Nn]$ ]]; then
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
