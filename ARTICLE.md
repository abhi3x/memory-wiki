# I Built a Memory System for Claude Code Using Just Markdown Files

*No vector database. No embeddings. No server. Just a wiki that gets smarter every session.*

---

I've been using Claude Code as my daily driver for a few months now. It's great — except every morning it wakes up with absolutely no idea who I am.

It doesn't remember that I prefer immutable data patterns. It doesn't know we spent two hours last week debugging a Gradle build issue. It doesn't know my project structure or that I've told it three times to stop using `var` in my Kotlin code.

So I went looking for memory solutions.

---

## The Obvious Answers

The first things I found were [agentmemory](https://github.com/rohitg00/agentmemory) and [mem0](https://github.com/mem0ai/mem0). These are proper memory layers for AI agents — embeddings, vector databases, semantic search, the whole stack.

They're impressive. mem0 gives you a full memory graph with automatic extraction. agentmemory hooks into Claude Code's lifecycle events.

But I kept thinking: do I really need Qdrant running in a Docker container just so Claude can remember I like small files?

I actually tried to set up mem0 self-hosted with Ollama. Fully offline, no cloud calls. It works, but you're still running an embedding model, a vector store, and managing that stack. For a personal memory system, this felt like overkill.

Also — I looked at agentmemory's npm package more carefully. No source repo linked, compiled-only distribution, very new. Not comfortable running that with access to my conversations.

Then something happened that changed my thinking.

---

## Wait, Claude Already Has Memory

Turns out Claude Code has a built-in memory system. Per-project `MEMORY.md` files at `~/.claude/projects/{slug}/memory/`. It can store user profiles, feedback, project context, and references.

But here's what I discovered when I investigated: **auto-save never actually triggers.**

I went through 2,000+ turns across 28 conversations. Every single one of my 9 memory files traced back to a session where I explicitly asked Claude to save something. The auto-save feature — the thing that's supposed to learn about you over time — never fired once.

And even when memories exist, they're project-scoped. My preferences in one project are invisible to another. Start a new project, and Claude is back to square one.

The built-in memory also eagerly loads everything into context. 9 small files? Fine. But if you're trying to build something richer, you're burning context window on every session whether you need it or not.

---

## The Self-Critical Moment

This is where most builders would start coding a solution. I almost did — I built a session archiver that converted Claude's JSONL conversations into pretty markdown files.

Then I stopped and asked myself an uncomfortable question:

**Claude Code already saves every conversation as JSONL. Why am I duplicating that data?**

The session archiver was cosmetic. It made conversations readable, but the data was already there. I was building a translation layer, not a knowledge layer.

So I threw it out. All of it. And started over with a different question:

**What if the value isn't in storing conversations, but in synthesizing them?**

---

## The LLM Wiki Idea

I'd been playing with this concept I call an "LLM Wiki." The core idea:

Instead of RAG — where you embed everything and re-discover knowledge from scratch every query — you let the LLM incrementally build and maintain a persistent wiki. Markdown files. Cross-referenced. Compounding over time.

The key insight: memory isn't a retrieval problem. It's a **synthesis problem**.

You don't need cosine similarity to find "what coding style does this user prefer." You need a well-organized wiki page called `coding-preferences.md` that gets richer every time the topic comes up. First session, it notes I like immutable patterns. Second session, it adds that I want files under 800 lines. Third session, it records I prefer feature-based directory organization.

Each session makes the page better. That's not retrieval. That's knowledge compounding.

---

## What I Actually Built

Three things:

### 1. An Extraction Script

A Node.js script that reads Claude Code's existing JSONL conversations and outputs clean, structured text. It doesn't try to be smart — it just parses and formats. The intelligence comes later.

```bash
# See all your past sessions
node wiki-extract.js --list

# Output: 
# PENDING | 2026-04-16 | 20 turns | 574KB | my-project
# PENDING | 2026-04-15 | 47 turns | 1.4MB | code-reviewer
# DONE    | 2026-04-14 | 8 turns  | 27KB  | home
```

Two modes:
- **Bootstrap** (`--bootstrap`): Process all past conversations at once. Run once to seed your wiki.
- **Single session** (`--session <path>`): Process one conversation. For incremental updates.

The script outputs formatted text to stdout. Claude reads it and decides what's worth keeping.

### 2. A Wiki of Synthesized Knowledge

```
~/.claude/wiki/
  global/
    decisions/          # Why we chose X over Y
    patterns/           # How we do things
    preferences/        # My coding style, tool choices  
    entities/           # Tools, APIs, services
    troubleshooting/    # When X breaks, do Y
  projects/
    my-app/
      context/          # Architecture, conventions
      decisions/        # Project-specific choices
```

Every page has YAML frontmatter:

```yaml
---
id: memory-wiki-over-vector-db
type: decision
confidence: 0.9
tags: [memory, architecture, markdown]
related: [llm-wiki-pattern, zero-infrastructure-preference]
---
```

Pages cross-reference each other with `[[wikilinks]]`. The wiki forms a graph. Obsidian can visualize it. Git tracks its history.

### 3. A Smart MEMORY.md Pointer

This is the bridge between the wiki and Claude Code's built-in system. Instead of duplicating data in MEMORY.md, every project gets a slim pointer (~20 lines) that:

- Summarizes what the wiki knows (page counts by type)
- **Inlines critical preferences** — your communication style, coding preferences — things Claude needs every session
- Points to project-specific wiki pages with "READ THESE FIRST"
- Tells Claude where to find the full wiki when it needs more

A sync script updates this pointer across all 16+ projects. Run it via cron, or manually after wiki updates.

The magic: **lazy loading.** Claude always sees the slim pointer. It only reads actual wiki pages when the conversation needs them. No context waste.

---

## Migration: Existing Memories to Wiki

If you already have Claude Code memory files, the sync script can migrate them:

```bash
# Preview what would happen
node wiki-sync.js --migrate --dry-run

# Output:
# WOULD MIGRATE: user_abhishek.md → global/entities/abhishek-profile.md (entity)
# WOULD MIGRATE: feedback_communication.md → global/preferences/communication-style.md (preference)
# WOULD MIGRATE: project_embeddai.md → projects/embeddai/context/embeddai-overview.md (context)

# Actually migrate
node wiki-sync.js --migrate
```

The script:
1. Scans all `~/.claude/projects/*/memory/` directories for non-MEMORY.md files
2. Classifies each by type (user → entity/preference, feedback → preference, project → context, reference → entity/decision)
3. Detects project scope from content keywords
4. Converts frontmatter to wiki format
5. Writes to the appropriate wiki directory
6. Updates the index
7. Re-syncs all MEMORY.md pointers to reflect the new state

After migration, your MEMORY.md files are clean pointers. All knowledge lives in one place.

---

## The Deduplication Discussion

One thing I wrestled with: where does Claude Code's memory end and the wiki begin?

The built-in MEMORY.md system is project-scoped. The wiki is global. There's natural overlap — my communication preferences exist in both.

The answer I landed on: **the wiki is the source of truth.** MEMORY.md becomes a read-only view — a generated pointer that Claude Code's system loads automatically, with the most critical preferences inlined.

This means:
- No data duplication
- One place to update preferences (the wiki)
- Changes propagate to all projects via the sync script
- Claude Code's built-in loading mechanism still works — it loads MEMORY.md like normal, but what it finds is a doorway to the wiki

---

## How Extraction Works

Here's the full flow:

1. **Claude Code saves conversations** — it already does this, as JSONL files under `~/.claude/projects/`
2. **The extraction script** parses JSONL into clean text, grouped by project
3. **Claude reads the output** and creates wiki pages — decisions, patterns, preferences, fixes
4. **A Stop hook** marks each session as "pending extraction"
5. **The sync script** loads the wiki index into every project's MEMORY.md
6. **Claude starts every session already knowing what it knows**

The critical design choice: **the script parses, the LLM synthesizes.** No heuristic extraction. No keyword matching. Claude reads the conversations and uses judgment about what's worth a wiki page.

---

## Why Markdown Over Embeddings

**What you get:**
- **Zero infrastructure.** No Qdrant. No Ollama. No Docker. Files on disk.
- **Human readable.** Open the wiki in Obsidian and browse the graph view.
- **Git friendly.** Diff what Claude "learned" between sessions.
- **LLM native.** Claude reads markdown, writes markdown. No translation layer.
- **Compounds.** Pages get richer over time. Knowledge is synthesized, not just stored.
- **Global.** One wiki, all projects. Preferences carry everywhere.

**What you don't get:**

This won't scale to 10,000 pages. The index file approach means scanning a table of contents, not vector similarity search. But for a personal memory system — one developer, a handful of projects — the index and grep are plenty.

---

## What's Next

- **Confidence decay** — pages lose relevance over time if not accessed. Stale knowledge fades naturally.
- **Lint commands** — health-check for broken wikilinks, orphan pages, contradictions.
- **Automatic consolidation** — merge small related pages into richer ones.
- **Multi-machine sync** — git-based sync for the wiki directory itself.

But even now, with just the extraction script, the migration tool, and a growing wiki, sessions feel different. Claude starts knowing things. Context carries over. The tool gets better at working with me.

---

## Try It Yourself

The setup is minimal:

1. Clone the repo and copy the scripts to `~/.claude/wiki/scripts/`
2. Copy `_schema.md` (the rules Claude follows) 
3. Add the Stop hook to `settings.json`
4. Run `--migrate` if you have existing memory files
5. Run `--bootstrap` to extract from your past conversations
6. Tell Claude to read the output and create wiki pages

No npm install. No docker-compose up. No API keys. Just markdown files that get smarter every time you use them.

**GitHub**: [github.com/abhishek-chaudhary/memory-wiki](https://github.com/abhishek-chaudhary/memory-wiki)

---

*If you build on this or find interesting ways to extend it, I'd love to hear about it.*
