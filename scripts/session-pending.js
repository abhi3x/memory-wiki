#!/usr/bin/env node
'use strict';

/**
 * Session Pending Tracker — Stop Hook (no-op as of security-hardening pass).
 *
 * Previously this hook appended one line per session to ~/memory-wiki/_pending.jsonl.
 * Nothing ever read that file — the wiki-sync.js `extractPending()` pass walks
 * ~/.claude/projects/ directly and compares against ~/memory-wiki/_processed.json
 * to find sessions that need ingest. The append-only writer grew unbounded.
 *
 * This version keeps the hook contract (read stdin, exit 0) so existing
 * ~/.claude/settings.json installations don't break, but does no disk writes.
 * The `_pending.jsonl` entry is removed from the installer's .gitignore
 * because the file is no longer produced.
 *
 * Hook event: Stop
 * Input: JSON on stdin with { session_id, transcript_path, cwd }
 */

async function main() {
  try {
    // Drain stdin so Claude Code's hook runner doesn't block on a closed pipe.
    for await (const _chunk of process.stdin) { /* discard */ }
  } catch { /* ignore */ }
  process.exit(0);
}

main();
