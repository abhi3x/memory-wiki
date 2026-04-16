#!/usr/bin/env node
'use strict';

/**
 * Session Pending Tracker — Stop Hook
 *
 * Lightweight hook that records the current session's JSONL path
 * so the next session knows there are unprocessed conversations.
 * Does NOT extract knowledge — that's Claude's job.
 *
 * Hook event: Stop
 * Input: JSON on stdin with { session_id, transcript_path, cwd }
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const PENDING_PATH = path.join(os.homedir(), '.claude', 'wiki', '_pending.jsonl');

function log(msg) {
  process.stderr.write(`[SessionPending] ${msg}\n`);
}

async function main() {
  try {
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; }

    let data = {};
    try { data = JSON.parse(input); } catch { return; }

    const { session_id, transcript_path, cwd } = data;
    if (!session_id || !transcript_path) return;

    // Check if already in processed list
    const processedPath = path.join(os.homedir(), '.claude', 'wiki', '_processed.json');
    try {
      const processed = JSON.parse(fs.readFileSync(processedPath, 'utf-8'));
      if (processed.sessions && processed.sessions[transcript_path]) {
        return; // Already processed, skip
      }
    } catch { /* no processed file yet */ }

    // Append to pending list (deduped on next read)
    const entry = JSON.stringify({
      session_id,
      transcript_path,
      cwd,
      timestamp: new Date().toISOString()
    });

    fs.appendFileSync(PENDING_PATH, entry + '\n', 'utf-8');
    log(`Recorded pending: ${session_id}`);

  } catch (err) {
    log(`Error: ${err.message}`);
  }

  process.exit(0);
}

main();
