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

1. **Bootstrap**: A script parses all your past Claude Code conversations and outputs clean summaries
2. **Claude reads** the summaries and creates wiki pages (decisions, patterns, preferences, troubleshooting)
3. **Per session**: New sessions are flagged as "pending", and Claude can extract knowledge incrementally
4. **On session start**: A hook loads the wiki index + your preferences into the conversation context

## Architecture

```
~/.claude/wiki/
  _schema.md              # Rules for how Claude maintains the wiki
  _index.md               # Master catalog of all pages
  _log.md                 # Chronological operations record
  _processed.json         # Tracks which sessions have been extracted
  scripts/
    wiki-extract.js       # Parses JSONL → clean text for Claude
    wiki-sync.js          # Syncs wiki pointer to all MEMORY.md + migration
    session-start-wiki.js # Loads wiki context on session start
    session-pending.js    # Tracks new sessions for later extraction

  global/                 # Cross-project knowledge
    entities/             # Tools, services, APIs
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

## Quick Start

### 1. Copy files

```bash
# Create the wiki directory
mkdir -p ~/.claude/wiki/{global/{entities,decisions,patterns,preferences,troubleshooting},projects,scripts}

# Copy scripts and schema
cp scripts/* ~/.claude/wiki/scripts/
cp _schema.md ~/.claude/wiki/_schema.md
cp _index.md ~/.claude/wiki/_index.md
cp _log.md ~/.claude/wiki/_log.md

chmod +x ~/.claude/wiki/scripts/*.js
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
            "command": "node ~/.claude/wiki/scripts/session-pending.js"
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
node ~/.claude/wiki/scripts/wiki-sync.js --migrate --dry-run

# Run migration — moves memory files to wiki, updates index, re-syncs MEMORY.md
node ~/.claude/wiki/scripts/wiki-sync.js --migrate
```

### 4. Bootstrap from existing conversations

```bash
# See all your sessions
node ~/.claude/wiki/scripts/wiki-extract.js --list

# Extract all conversations (outputs text for Claude to read)
node ~/.claude/wiki/scripts/wiki-extract.js --bootstrap
```

Then tell Claude: "Read the output above and create wiki pages for the key knowledge — decisions, patterns, preferences, troubleshooting."

### 5. Mark as processed

```bash
node ~/.claude/wiki/scripts/wiki-extract.js --mark-all-processed
```

## Commands

### wiki-extract.js

| Command | What it does |
|---------|-------------|
| `--list` | Show all sessions with processed/pending status |
| `--bootstrap` | Extract all unprocessed sessions |
| `--session <path>` | Extract a single session |
| `--mark-processed <path>` | Mark a session as done |
| `--mark-all-processed` | Mark everything as done |

### wiki-sync.js

| Command | What it does |
|---------|-------------|
| *(no flags)* | Sync MEMORY.md pointers + check pending extraction |
| `--sync-only` | Just sync MEMORY.md pointers across all projects |
| `--extract-only` | Just check for pending extraction sessions |
| `--migrate` | Migrate existing Claude Code memory files into the wiki |
| `--migrate --dry-run` | Preview migration without writing any files |

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

## Smart MEMORY.md Pointer

The sync script (`wiki-sync.js`) injects a slim pointer into every project's `MEMORY.md`:

- Summarizes wiki page counts by type
- **Inlines critical preferences** — communication style, coding prefs — always in context
- Points to project-specific wiki pages
- Tells Claude where to find the full wiki on demand

This bridges the wiki with Claude Code's built-in memory loading. MEMORY.md becomes a generated view, not a data store. The wiki is the source of truth.

Run sync manually or via cron:

```bash
# Manual
node ~/.claude/wiki/scripts/wiki-sync.js

# Cron (nightly)
42 23 * * * node ~/.claude/wiki/scripts/wiki-sync.js >> ~/.claude/wiki/_sync.log 2>&1
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
