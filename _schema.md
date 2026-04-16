# Memory Wiki Schema

You maintain a persistent knowledge wiki at `~/.claude/wiki/`. This is a compounding knowledge base — not a cache, not a log. Every session makes it richer.

## Architecture

Two layers:

1. **Raw source** — Claude Code's JSONL conversations at `~/.claude/projects/`. These are the source of truth. Never modified.
2. **Wiki** (`global/`, `projects/`) — Synthesized knowledge pages you maintain. Cross-referenced. Compounding.

The wiki synthesizes from raw conversations. Knowledge is compiled once and kept current — not re-derived every query.

## Directory Layout

```
~/.claude/wiki/
  _schema.md              # This file (the rules)
  _index.md               # Master content catalog
  _log.md                 # Chronological operations record
  _processed.json         # Tracks which sessions have been extracted
  scripts/                # Extraction and hook scripts

  global/                 # Cross-project knowledge
    entities/             # People, tools, services, APIs
    decisions/            # Architectural choices with rationale
    patterns/             # Recurring solutions, workflows
    preferences/          # User coding style, tool preferences
    troubleshooting/      # Known issues and fixes

  projects/               # Project-scoped knowledge
    <project-name>/
      _index.md
      entities/
      decisions/
      patterns/
      troubleshooting/
      context/            # Codebase mental model
```

## Extraction Workflow

### Bootstrap (one-time)
Seed the wiki from all existing conversations:
```bash
node ~/.claude/wiki/scripts/wiki-extract.js --bootstrap
```
Read the output, create wiki pages, then mark all processed:
```bash
node ~/.claude/wiki/scripts/wiki-extract.js --mark-all-processed
```

### Incremental (per-session)
On session start, check for unprocessed sessions:
```bash
node ~/.claude/wiki/scripts/wiki-extract.js --list
```
Process new ones:
```bash
node ~/.claude/wiki/scripts/wiki-extract.js --session <path>
```
Read the output, update the wiki, then mark processed:
```bash
node ~/.claude/wiki/scripts/wiki-extract.js --mark-processed <path>
```

### What to extract

When reading extraction output, create wiki pages for:

1. **Decisions** — architectural/technical choices with context and rationale. Why X over Y.
2. **Entities** — tools, services, APIs, libraries discussed in depth. What they are, how they're used.
3. **Patterns** — recurring approaches, workflows, solutions. How we do X.
4. **Preferences** — user corrections, style choices, explicit instructions. Always/never do X.
5. **Troubleshooting** — errors encountered and their fixes. When X breaks, do Y.
6. **Context** — project architecture, conventions, key modules. The onboarding doc.

### What NOT to extract

- Trivial exchanges ("ls", "what's in this file")
- Information derivable from the codebase itself
- Temporary debugging steps
- Sensitive data (API keys, passwords)
- One-off conversations with no reusable knowledge

## Page Format

```markdown
---
id: kebab-case-unique-id
type: entity | decision | pattern | preference | troubleshooting | context
scope: global | project
project: project-name (if scope: project)
created: YYYY-MM-DD
updated: YYYY-MM-DD
confidence: 0.0-1.0
tags: [tag1, tag2]
related: [other-page-id]
---

# Page Title

## Summary
One paragraph. What and why.

## Details
Extended explanation. Code snippets, file paths, config.

## Evidence
- YYYY-MM-DD: What happened that created/updated this

## See Also
- [[related-page-id]] — relationship description
```

## Page Rules

1. Search `_index.md` before creating — UPDATE existing pages over creating new ones
2. Every page needs complete YAML frontmatter
3. Filename = `id` field + `.md`
4. Cross-reference with `[[page-id]]` wikilinks (Obsidian-compatible)
5. Update `_index.md` after any page changes
6. Log every operation to `_log.md`

## Confidence Scale

| Score | Meaning |
|-------|---------|
| 0.3 | Single observation, tentative |
| 0.5 | Confirmed or observed twice |
| 0.7 | Applied successfully multiple times |
| 0.9 | Core, well-established |
| 1.0 | Explicit user declaration |

Decay: -0.05/month without access. Below 0.15 = prune candidate. Decision pages never decay.

## Conflict Resolution

1. Higher confidence + more recent wins
2. If unclear, add a `## Conflicts` section
3. Never silently overwrite confidence >0.7

## Index File (_index.md)

Regenerated from actual files. Each entry = one line with `[[page-id]]` and description.

## Log File (_log.md)

Append-only. Format: `## [YYYY-MM-DD HH:MM] OPERATION | Subject`

Operations: CREATE, UPDATE, LINK, MERGE, PRUNE, LINT
