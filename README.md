# Memory Wiki

A persistent, markdown-based knowledge system for Claude Code. No vector database. No embeddings. No server. Just a wiki that gets smarter every session.

## What is this?

Memory Wiki gives Claude Code a persistent memory that compounds over time. Instead of embedding conversations and vector-searching them (like mem0 or agentmemory), it takes a different approach:

**The LLM builds and maintains a wiki.** Knowledge is extracted from conversations and synthesized into cross-referenced markdown pages. Each session makes the wiki richer.

This is based on the [LLM Wiki](https://github.com/tobi/llm-wiki) pattern — the idea that knowledge should be compiled once and kept current, not re-derived on every query.

## How it works

```
Conversations (JSONL)     →     Extraction Script     →     Claude reads + synthesizes
    (source of truth)           (parses, formats)           (creates wiki pages)
```

1. **Bootstrap**: Iteratively parse past Claude Code sessions — one per Claude turn — so long histories don't blow the context window.
2. **Per session**: A Stop hook flags new sessions as "pending"; the next dream cycle or a manual run promotes durable content.
3. **Dream (consolidation)**: A ritual that promotes recurring MEMORY.md entries to the wiki, prunes promoted stubs, regenerates CLAUDE.md pointer manifests, and lints for duplicates/orphans/gaps.
4. **On session start**: Claude Code's built-in loader pulls `~/.claude/CLAUDE.md` + project `CLAUDE.md` automatically — these hold pointers to wiki pages flagged `alwaysLoad: true`. The full content lives in the wiki, read on demand.

## Three-tier memory architecture

The wiki plugs into Claude Code's native memory loading via three layers:

| Tier | File | Scope | Holds | Written by |
|------|------|-------|-------|------------|
| 1 | `~/.claude/CLAUDE.md` | Every session, every cwd | Pointer manifest to `alwaysLoad: true` wiki pages + your hand-curated hard rules | `wiki-sync.js` (marker block) + you (outside the block) |
| 1 | `<project>/CLAUDE.md` | That project only | Pointer manifest to `wiki/projects/<name>/**` pages + project rules | `wiki-sync.js` + you |
| 2 | `~/.claude/projects/<cwd>/memory/MEMORY.md` | That cwd only | Dynamic Claude-recorded observations + `see wiki/...` stubs for promoted content | Claude (auto-memory) + `wiki-consolidate.js` (pruning) |
| 3 | `~/memory-wiki/**` | Source of truth | Full content: synthesized, cross-referenced, versioned | Claude (during dreams + ingest) |

**Why this works:**
- **CLAUDE.md carries pointers, not content** — small (~1–3 KB), auto-loaded by Claude Code at every session start, zero context bloat.
- **MEMORY.md holds only dynamic observations** — what Claude noticed mid-session that isn't worth a wiki page yet. Promoted content gets replaced with a one-line stub on the next dream.
- **Wiki is the source of truth** — ever-growing, but only referenced on demand via the pointers.

## Architecture

```
~/.claude/CLAUDE.md       # Global pointer manifest (auto-loaded everywhere)
<project>/CLAUDE.md       # Per-project pointer manifest (auto-loaded in that project)

~/memory-wiki/
  _schema.md              # Rules, frontmatter, dreams workflow
  _index.md               # Master catalog of all pages
  _log.md                 # Chronological operations record
  _processed.json         # Tracks which sessions have been extracted
  scripts/
    wiki-extract.js       # Parses JSONL → clean text for Claude (with project filters)
    wiki-sync.js          # Syncs pointer manifests into CLAUDE.md + MEMORY.md stubs
    wiki-consolidate.js   # Mechanical consolidation (prune promoted memories, regen manifests)
    wiki-dream.sh         # Full dream ritual: mechanical + LLM promotion + LLM lint
    bootstrap-loop.sh     # Iterative history ingest, one session per claude -p invocation
    session-pending.js    # Stop hook — flags each session for later extraction

  global/                 # Cross-project knowledge
    entities/             # Tools, services, people, APIs
    decisions/            # Architectural choices + rationale
    patterns/             # Recurring solutions
    preferences/          # User style, corrections
    troubleshooting/      # Known issues + fixes

  projects/               # Project-scoped knowledge
    <name>/
      context/            # Codebase mental model
      decisions/
      patterns/
      troubleshooting/
```

## Dreams — the consolidation ritual

Dreams keep the three tiers coherent. Run manually via `wiki-dream.sh` (or add to cron once you trust behavior).

Pipeline:

1. **Mechanical pass** (`wiki-consolidate.js`, pure Node, always auto-applied):
   - Prune MEMORY.md entries already promoted to wiki — replace with a `see wiki/...` stub.
   - Regenerate pointer manifests in `~/.claude/CLAUDE.md` and every project's `CLAUDE.md`.
2. **LLM promotion pass** (auto-applied): Claude reads unpromoted MEMORY.md entries, creates wiki pages for durable ones, stamps `promoteFromMemory: <basename>` in frontmatter so the next dream prunes the source.
3. **LLM lint pass** (PROPOSE-ONLY): Writes proposed destructive changes (merges, splits, deletes) to `~/memory-wiki/_dream-report-YYYY-MM-DD.md`. Safe non-destructive fixes (missing `[[related]]` links, frontmatter normalization) are applied directly. You approve destructive changes manually.

**Safety:**
- Wiki is under git (`~/memory-wiki/.git/`). Worst case: `git reset --hard`.
- LLM subprocesses run with `--add-dir ~/memory-wiki --permission-mode bypassPermissions` — trusted because the wiki is local-only and versioned.
- Destructive changes never auto-apply. Only pointers + manifests + stubs regen automatically.

## Quick Start

### 1. Copy files

```bash
# Create the wiki directory
mkdir -p ~/memory-wiki/{global/{entities,decisions,patterns,preferences,troubleshooting},projects,scripts}

# Copy scripts and schema
cp scripts/* ~/memory-wiki/scripts/
cp _schema.md ~/memory-wiki/_schema.md
cp _index.md ~/memory-wiki/_index.md
cp _log.md ~/memory-wiki/_log.md

chmod +x ~/memory-wiki/scripts/*.js
```

### 2. Add hooks to settings.json

Add to your `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/memory-wiki/scripts/session-pending.js"
          }
        ]
      }
    ]
  }
}
```

### 3. Migrate existing memory files (optional)

If you already have Claude Code memory files (`user_*.md`, `feedback_*.md`, etc.):

```bash
# Preview what would be migrated
node ~/memory-wiki/scripts/wiki-sync.js --migrate --dry-run

# Run migration — moves memory files to wiki, updates index, re-syncs MEMORY.md
node ~/memory-wiki/scripts/wiki-sync.js --migrate
```

### 4. Bootstrap from existing conversations

```bash
# See all your sessions with status
node ~/memory-wiki/scripts/wiki-extract.js --list
```

**Recommended — iterative bootstrap (handles long histories without blowing Claude's context):**

Synthesizing every past session in a single Claude turn doesn't scale — a few months of history will exceed the context window. Instead, process one session at a time:

```bash
# Loop: one session per Claude invocation
for s in $(node ~/memory-wiki/scripts/wiki-extract.js --list-pending); do
  node ~/memory-wiki/scripts/wiki-extract.js --session "$s" | \
    claude -p "Read this session and update the wiki per ~/memory-wiki/_schema.md"
  node ~/memory-wiki/scripts/wiki-extract.js --mark-processed "$s"
done
```

Each iteration fits in one context window, synthesizes incrementally, commits (if you wire a git-commit step into your schema), moves on. Leave it running overnight.

**Shared machines — filter out other users' sessions:**

```bash
# Exclude any project dir whose name contains "partner"
node ~/memory-wiki/scripts/wiki-extract.js --list-pending --exclude-project partner
```

`--exclude-project` and `--include-project` are both repeatable and match by substring against the sanitized project directory name (the subdirectories of `~/.claude/projects/`).

**Single-dump alternative (only for small histories):**

```bash
node ~/memory-wiki/scripts/wiki-extract.js --bootstrap
```

Dumps everything unprocessed into one output blob. Only viable if your total history fits in one Claude context.

### 5. Mark as processed

```bash
# Mark everything processed (declare bootstrap bankruptcy — start fresh from today)
node ~/memory-wiki/scripts/wiki-extract.js --mark-all-processed

# Or with filters
node ~/memory-wiki/scripts/wiki-extract.js --mark-all-processed --exclude-project partner
```

## Commands

### wiki-extract.js

| Command | What it does |
|---------|-------------|
| `--list` | Show all sessions with processed/pending status |
| `--list-pending` | Print pending session paths (one per line — for shell loops) |
| `--session <path>` | Extract a single session |
| `--bootstrap` | Extract all unprocessed sessions as one dump (only for small histories) |
| `--mark-processed <path>` | Mark a session as done |
| `--mark-all-processed` | Mark everything as done |

**Project filters** (apply to `--list`, `--list-pending`, `--bootstrap`, `--mark-all-processed`; repeatable):

| Flag | What it does |
|------|-------------|
| `--include-project <substr>` | Only include sessions whose sanitized project dir contains `<substr>` |
| `--exclude-project <substr>` | Skip sessions whose sanitized project dir contains `<substr>` |

### wiki-sync.js

| Command | What it does |
|---------|-------------|
| *(no flags)* | Sync: inject pointer manifests into `~/.claude/CLAUDE.md` + per-project `CLAUDE.md` files + shrunk stub into every project's `MEMORY.md`. Also check pending extraction. |
| `--sync-only` | Just the three-surface sync, skip pending-extraction check |
| `--extract-only` | Just check for pending extraction sessions |
| `--migrate` | Migrate existing Claude Code memory files into the wiki |
| `--migrate --dry-run` | Preview migration without writing any files |

### wiki-consolidate.js

Mechanical half of dreams — pure Node, no LLM involvement, safe to run any time.

| Command | What it does |
|---------|-------------|
| *(no flags)* | Full mechanical pass: prune promoted MEMORY.md entries + regen CLAUDE.md manifests |
| `--dry-run` | Report what would change, write nothing |
| `--prune-only` | Just the MEMORY.md prune pass |
| `--manifest-only` | Just regen CLAUDE.md manifests (delegates to `wiki-sync.js --sync-only`) |

### wiki-dream.sh

The full dream ritual — mechanical + LLM promotion + LLM lint.

| Flag | What it does |
|------|-------------|
| *(no flags)* | Run all three passes (mechanical, LLM promotion, LLM lint) |
| `--skip-llm` | Only the mechanical pass (safe, offline, no claude subprocess) |
| `--report-only` | Skip promotion pass; only generate the lint report |
| `--dry-run` | Show mechanical pass, write nothing, skip LLM |
| `--include-project <s>` / `--exclude-project <s>` | Project filters (repeatable) |

### bootstrap-loop.sh

| Flag | What it does |
|------|-------------|
| *(no flags)* | Process all pending sessions, one per `claude -p` invocation |
| `--limit N` | Stop after N sessions (piloting) |
| `--after dream` | Run `wiki-dream.sh` automatically once the loop finishes |
| `--dry-run` | List what would be processed, exit |
| `--include-project <s>` / `--exclude-project <s>` | Project filters (repeatable) |

## Wiki Page Format

Every page uses YAML frontmatter + structured markdown:

```markdown
---
id: kebab-case-id
type: decision | pattern | preference | troubleshooting | entity | context
scope: global | project
confidence: 0.0-1.0
tags: [tag1, tag2]
related: [other-page-id]
alwaysLoad: true | false         # Promote this page into CLAUDE.md pointer manifest
promoteFromMemory: <basename>    # Provenance — which MEMORY.md entry spawned this page (set by dreams)
---

# Page Title

## Summary
What and why.

## Details
Extended explanation.

## Evidence
- 2026-04-16: What happened

## See Also
- [[related-page-id]] — relationship
```

Pages are Obsidian-compatible — `[[wikilinks]]`, YAML frontmatter, and the directory structure all work with Obsidian's graph view.

**`alwaysLoad: true`** — only set this on pages that must be in Claude's context at EVERY session (identity, non-negotiable rules, core comms). Everything else is discoverable via `_index.md` on demand. Flip this flag sparingly — the global CLAUDE.md manifest grows with every flagged page and auto-loads on every session.

**`promoteFromMemory`** — set by the dreams LLM pass when a MEMORY.md entry is promoted to the wiki. The next mechanical pass (`wiki-consolidate.js`) uses this to prune the source memory entry, replacing it with a stub. This creates a safe promotion loop: MEMORY.md stays small, wiki grows with verified-worthy content.

## Smart CLAUDE.md manifests

The sync script injects a pointer manifest into both global and per-project `CLAUDE.md` files, scoped by the `alwaysLoad` frontmatter flag:

```
<!-- wiki-pointer-manifest -->
# Wiki — always-loaded context

Pointers to wiki pages marked `alwaysLoad: true`. Full content is at ~/memory-wiki/ — read specific pages on demand.

Last synced: 2026-04-20 · 8 page(s)

## Preferences
- `~/memory-wiki/global/preferences/abhishek-time-scale.md` — Never quote estimates in weeks. 1:1 substitution to hours.
- ...
<!-- wiki-pointer-manifest -->
```

Content outside the marker block is preserved (so your hand-curated rules sit alongside the generated pointers). MEMORY.md becomes small — only dynamic Claude-recorded observations.

Run sync manually or via cron:

```bash
# Manual
node ~/memory-wiki/scripts/wiki-sync.js

# Cron (nightly)
42 23 * * * node ~/memory-wiki/scripts/wiki-sync.js >> ~/memory-wiki/_sync.log 2>&1
```

## Why markdown over embeddings?

| | Memory Wiki | Vector DB approach |
|---|---|---|
| Infrastructure | None | Qdrant/Chroma + embedding model |
| Human readable | Yes (Obsidian, VS Code, any editor) | No (opaque vectors) |
| Git friendly | Yes (plain text, diffable) | No |
| Knowledge quality | Synthesized, cross-referenced | Raw chunks, similarity-matched |
| Scale limit | ~100s of pages | Millions of documents |
| Setup time | 2 minutes | 15-30 minutes |

This is for personal memory — one developer, a handful of projects. If you need to search across millions of documents, use a vector database. This is something different.

## Philosophy

> "The tedious part of maintaining a knowledge base is not the reading or the thinking — it's the bookkeeping. LLMs don't get bored, don't forget to update a cross-reference, and can touch 15 files in one pass."

The wiki is a compounding artifact. The human curates and directs. The LLM does the bookkeeping.

## License

MIT
