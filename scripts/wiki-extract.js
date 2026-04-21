#!/usr/bin/env node
'use strict';

/**
 * wiki-extract.js
 *
 * Parses Claude Code JSONL conversations into clean text summaries
 * that Claude can read and synthesize into wiki pages.
 *
 * Usage:
 *   node wiki-extract.js --list                         # List all sessions with status
 *   node wiki-extract.js --list-pending                 # Print pending session paths (one per line)
 *   node wiki-extract.js --session <path>               # Process single JSONL file
 *   node wiki-extract.js --bootstrap                    # Process all unprocessed sessions (single dump — may blow context)
 *   node wiki-extract.js --mark-processed <path>        # Mark a session as processed
 *   node wiki-extract.js --mark-all-processed           # Mark all sessions as processed
 *
 * Project filters (apply to --list, --list-pending, --bootstrap, --mark-all-processed):
 *   --include-project <substr>   Only include sessions whose sanitized project dir contains <substr>.
 *                                May be repeated. If used, ALL other sessions are excluded.
 *   --exclude-project <substr>   Skip sessions whose sanitized project dir contains <substr>.
 *                                May be repeated. Useful when multiple users share one machine.
 *
 * Size filters (apply to --list, --list-pending, --bootstrap):
 *   --min-turns N                Skip sessions with fewer than N user turns. Default: 0 (no filter).
 *                                Sessions with 0 or 1 turns are typically trivial (skill-injections, pings)
 *                                and waste a full claude -p round-trip — recommend --min-turns 3 for bootstrap.
 *   --min-size-kb K              Skip sessions smaller than K KB on disk. Default: 0.
 *
 * Iterative bootstrap (recommended for long histories — avoids blowing Claude's context):
 *   for s in $(node wiki-extract.js --list-pending --exclude-project suhani); do
 *     node wiki-extract.js --session "$s" | claude -p "Update the wiki per CLAUDE.md"
 *     node wiki-extract.js --mark-processed "$s"
 *   done
 *
 * Output goes to stdout. Claude reads it and creates wiki pages.
 * The script parses. The LLM synthesizes.
 */

const fs = require('fs');
const path = require('path');
const {
  WIKI_ROOT,
  CLAUDE_PROJECTS: CLAUDE_ROOT,
  assertPathInside,
  walkSafe,
} = require('./lib/wiki-utils');

const PROCESSED_PATH = path.join(WIKI_ROOT, '_processed.json');
const MAX_TURNS_PER_SESSION = 100;
const MAX_TEXT_PER_TURN = 1500;

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) {
  process.stderr.write(`[wiki-extract] ${msg}\n`);
}

function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

const { writeFileAtomic } = require('./lib/wiki-utils');
function writeJSON(filePath, data) {
  writeFileAtomic(filePath, JSON.stringify(data, null, 2));
}

function getProcessed() {
  return readJSON(PROCESSED_PATH) || { sessions: {} };
}

function markProcessed(sessionPath) {
  const data = getProcessed();
  data.sessions[sessionPath] = {
    processedAt: new Date().toISOString(),
    size: fs.statSync(sessionPath).size
  };
  writeJSON(PROCESSED_PATH, data);
}

function truncate(text, max) {
  if (!text || text.length <= max) return text || '';
  return text.slice(0, max) + '\n[... truncated]';
}

// ── Project name from path ───────────────────────────────────────────────────

function projectFromDir(dirName) {
  // Convert "-Users-abhishek-chaudhary-claude-machine-code-reviewer" → project path
  const cleaned = dirName
    .replace(/^-Users-[^-]+-[^-]+-/, '')  // Remove user prefix
    .replace(/^-Users-[^-]+-/, '')         // Shorter user prefix
    .replace(/-/g, '/');

  if (!cleaned || cleaned === dirName) {
    // Fallback: extract last meaningful segment
    const parts = dirName.split('-').filter(p => p && p !== 'Users');
    return parts.slice(-2).join('/') || 'home';
  }
  return cleaned;
}

// ── JSONL parsing ────────────────────────────────────────────────────────────

function extractText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  return content
    .filter(b => b.type === 'text' && b.text)
    .map(b => b.text.trim())
    .join('\n\n');
}

function extractTools(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter(b => b.type === 'tool_use')
    .map(b => {
      const name = b.name || '?';
      const input = b.input || {};
      let brief = input.command || input.file_path || input.pattern ||
                  input.query || input.skill || '';
      if (!brief && input.prompt) brief = input.prompt.slice(0, 60);
      if (!brief) {
        try { brief = JSON.stringify(input).slice(0, 60); } catch { brief = ''; }
      }
      return `${name}: ${brief}`;
    });
}

function isToolResult(content) {
  return Array.isArray(content) && content.some(b => b.type === 'tool_result');
}

function parseJSONL(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  const turns = [];
  let current = null;

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    if (entry.type === 'user') {
      const msgContent = entry.message?.content;
      if (isToolResult(msgContent)) continue;

      current = {
        timestamp: entry.timestamp || null,
        cwd: entry.cwd || null,
        branch: entry.gitBranch || null,
        user: truncate(extractText(msgContent), MAX_TEXT_PER_TURN),
        assistant: '',
        tools: []
      };
      turns.push(current);
    }

    if (entry.type === 'assistant' && current) {
      const msgContent = entry.message?.content;
      const text = extractText(msgContent);
      if (text) {
        current.assistant = current.assistant
          ? current.assistant + '\n\n' + truncate(text, MAX_TEXT_PER_TURN)
          : truncate(text, MAX_TEXT_PER_TURN);
      }
      current.tools.push(...extractTools(msgContent));
    }
  }

  return turns;
}

// ── Session metadata ─────────────────────────────────────────────────────────

function getSessionMeta(filePath, turns) {
  const stat = fs.statSync(filePath);
  const dirName = path.basename(path.dirname(filePath));
  const sessionId = path.basename(filePath, '.jsonl');
  const project = projectFromDir(dirName);
  const firstTimestamp = turns[0]?.timestamp || stat.mtime.toISOString();
  const lastTimestamp = turns[turns.length - 1]?.timestamp || stat.mtime.toISOString();
  const cwd = turns[0]?.cwd || 'unknown';
  const branch = turns.find(t => t.branch)?.branch || null;

  // Collect unique tools used
  const toolSet = new Set();
  for (const t of turns) {
    for (const tool of t.tools) {
      toolSet.add(tool.split(':')[0].trim());
    }
  }

  return {
    sessionId,
    project,
    cwd,
    branch,
    firstTimestamp,
    lastTimestamp,
    turnCount: turns.length,
    fileSize: stat.size,
    toolsUsed: [...toolSet],
    filePath
  };
}

// ── Output formatting ────────────────────────────────────────────────────────

function formatSessionSummary(meta, turns) {
  const lines = [];
  const date = new Date(meta.firstTimestamp).toISOString().slice(0, 10);

  lines.push(`${'='.repeat(70)}`);
  lines.push(`SESSION: ${meta.sessionId}`);
  lines.push(`Date: ${date} | Project: ${meta.project} | Turns: ${meta.turnCount}`);
  if (meta.cwd) lines.push(`Working dir: ${meta.cwd}`);
  if (meta.branch) lines.push(`Branch: ${meta.branch}`);
  if (meta.toolsUsed.length > 0) lines.push(`Tools: ${meta.toolsUsed.join(', ')}`);
  lines.push(`${'='.repeat(70)}`);
  lines.push('');

  // Cap turns for very long sessions
  const cappedTurns = turns.slice(0, MAX_TURNS_PER_SESSION);
  if (turns.length > MAX_TURNS_PER_SESSION) {
    lines.push(`[Showing first ${MAX_TURNS_PER_SESSION} of ${turns.length} turns]\n`);
  }

  for (let i = 0; i < cappedTurns.length; i++) {
    const t = cappedTurns[i];
    lines.push(`--- Turn ${i + 1} ---`);
    if (t.user) lines.push(`User: ${t.user}`);
    if (t.assistant) lines.push(`Assistant: ${t.assistant}`);
    if (t.tools.length > 0) lines.push(`Tools: ${t.tools.join(' | ')}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ── Find all JSONL sessions ──────────────────────────────────────────────────

function findAllSessions() {
  const sessions = [];
  // walkSafe refuses symlinks (security review finding #4) and confines
  // the walk to CLAUDE_ROOT so a stray symlink can't tunnel it out.
  walkSafe(CLAUDE_ROOT, (fullPath) => {
    if (fullPath.includes(`${path.sep}subagents${path.sep}`)) return;
    sessions.push(fullPath);
  }, {
    fileFilter: (name) => name.endsWith('.jsonl'),
    confineTo: CLAUDE_ROOT,
  });
  return sessions.sort((a, b) => {
    const statA = fs.statSync(a).mtime;
    const statB = fs.statSync(b).mtime;
    return statA - statB;
  });
}

// Validate a user-supplied session path before reading or marking it.
// Must live under ~/.claude/projects/ and exist as a regular (non-symlink)
// .jsonl file.
function validateSessionPath(raw) {
  const abs = assertPathInside(raw, CLAUDE_ROOT, 'session');
  let lst;
  try { lst = fs.lstatSync(abs); }
  catch { throw new Error(`session: ${abs} does not exist`); }
  if (lst.isSymbolicLink()) throw new Error(`session: ${abs} is a symlink — refusing`);
  if (!lst.isFile()) throw new Error(`session: ${abs} is not a regular file`);
  if (!abs.endsWith('.jsonl')) throw new Error(`session: ${abs} is not a .jsonl file`);
  return abs;
}

// ── Project filters ──────────────────────────────────────────────────────────

function applyProjectFilters(sessions, { include, exclude }) {
  return sessions.filter(sessionPath => {
    const dirName = path.basename(path.dirname(sessionPath));
    if (include.length > 0 && !include.some(p => dirName.includes(p))) return false;
    if (exclude.some(p => dirName.includes(p))) return false;
    return true;
  });
}

function applySizeFilters(sessions, { minTurns, minSizeKb }) {
  if (minTurns <= 0 && minSizeKb <= 0) return sessions;
  return sessions.filter(sessionPath => {
    try {
      const stat = fs.statSync(sessionPath);
      if (minSizeKb > 0 && stat.size < minSizeKb * 1024) return false;
      if (minTurns > 0) {
        // Quick count without full parse — count "type":"user" markers.
        const content = fs.readFileSync(sessionPath, 'utf-8');
        const turnCount = (content.match(/"type":"user"/g) || []).length;
        if (turnCount < minTurns) return false;
      }
      return true;
    } catch {
      return false;
    }
  });
}

function parseProjectFilters(args) {
  const include = [];
  const exclude = [];
  let minTurns = 0;
  let minSizeKb = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--include-project' && args[i + 1]) { include.push(args[i + 1]); i++; }
    else if (args[i] === '--exclude-project' && args[i + 1]) { exclude.push(args[i + 1]); i++; }
    else if (args[i] === '--min-turns' && args[i + 1]) { minTurns = parseInt(args[i + 1], 10) || 0; i++; }
    else if (args[i] === '--min-size-kb' && args[i + 1]) { minSizeKb = parseInt(args[i + 1], 10) || 0; i++; }
  }
  return { include, exclude, minTurns, minSizeKb };
}

// ── Commands ─────────────────────────────────────────────────────────────────

function cmdList(filters) {
  const all = findAllSessions();
  const afterProject = applyProjectFilters(all, filters);
  const sessions = applySizeFilters(afterProject, filters);
  const processed = getProcessed();
  const skipped = all.length - sessions.length;

  console.log(`Found ${sessions.length} sessions${skipped ? ` (${skipped} filtered out)` : ''}:\n`);
  console.log('Status    | Date       | Turns | Size     | Project');
  console.log('-'.repeat(70));

  for (const s of sessions) {
    const isProcessed = !!processed.sessions[s];
    const stat = fs.statSync(s);
    const date = stat.mtime.toISOString().slice(0, 10);
    const sizeKB = Math.round(stat.size / 1024);
    const dirName = path.basename(path.dirname(s));
    const project = projectFromDir(dirName);
    const status = isProcessed ? 'DONE' : 'PENDING';

    // Quick turn count without full parse
    const content = fs.readFileSync(s, 'utf-8');
    const turnCount = (content.match(/"type":"user"/g) || []).length;

    console.log(`${status.padEnd(9)} | ${date} | ${String(turnCount).padStart(5)} | ${String(sizeKB + 'KB').padStart(8)} | ${project}`);
  }

  const pending = sessions.filter(s => !processed.sessions[s]);
  console.log(`\n${pending.length} pending, ${sessions.length - pending.length} processed`);
}

function cmdListPending(filters) {
  const all = findAllSessions();
  const afterProject = applyProjectFilters(all, filters);
  const sessions = applySizeFilters(afterProject, filters);
  const processed = getProcessed();
  for (const s of sessions) {
    if (!processed.sessions[s]) console.log(s);
  }
}

function cmdBootstrap(filters) {
  const all = findAllSessions();
  const afterProject = applyProjectFilters(all, filters);
  const sessions = applySizeFilters(afterProject, filters);
  const processed = getProcessed();
  const pending = sessions.filter(s => !processed.sessions[s]);

  if (pending.length === 0) {
    console.log('All sessions already processed. Nothing to do.');
    return;
  }

  log(`Bootstrap: ${pending.length} sessions to process`);

  // Group by project
  const byProject = {};
  for (const s of pending) {
    const dirName = path.basename(path.dirname(s));
    const project = projectFromDir(dirName);
    if (!byProject[project]) byProject[project] = [];
    byProject[project].push(s);
  }

  console.log(`# Wiki Extraction — Bootstrap`);
  console.log(`# ${pending.length} sessions across ${Object.keys(byProject).length} projects`);
  console.log(`# Generated: ${new Date().toISOString()}`);
  console.log('');
  console.log('Read through these conversation summaries and create wiki pages for:');
  console.log('1. Key decisions made (with rationale) → global/decisions/ or projects/*/decisions/');
  console.log('2. Entities discussed in depth (tools, services, APIs) → entities/');
  console.log('3. Patterns identified (recurring approaches) → patterns/');
  console.log('4. User preferences/corrections observed → global/preferences/');
  console.log('5. Troubleshooting solutions found → troubleshooting/');
  console.log('6. Project context (architecture, conventions) → projects/*/context/');
  console.log('');
  console.log('After creating pages, run: node ~/memory-wiki/scripts/wiki-extract.js --mark-all-processed');
  console.log('');

  for (const [project, files] of Object.entries(byProject)) {
    console.log(`\n${'#'.repeat(70)}`);
    console.log(`# PROJECT: ${project}`);
    console.log(`# ${files.length} sessions`);
    console.log(`${'#'.repeat(70)}\n`);

    for (const filePath of files) {
      try {
        const turns = parseJSONL(filePath);
        if (turns.length === 0) continue;

        const meta = getSessionMeta(filePath, turns);
        console.log(formatSessionSummary(meta, turns));
      } catch (err) {
        log(`Error processing ${filePath}: ${err.message}`);
      }
    }
  }
}

function cmdSession(sessionPath) {
  let validated;
  try { validated = validateSessionPath(sessionPath); }
  catch (err) { log(err.message); process.exit(1); }

  const turns = parseJSONL(validated);
  if (turns.length === 0) {
    console.log('No turns found in session.');
    return;
  }

  const meta = getSessionMeta(validated, turns);

  console.log('# Wiki Extraction — Single Session');
  console.log(`# Generated: ${new Date().toISOString()}`);
  console.log('');
  console.log('Read this conversation and update the wiki:');
  console.log('- Create new pages for significant new knowledge');
  console.log('- Update existing pages if this adds to known topics');
  console.log('- Skip trivial/transient content');
  console.log('');
  console.log(formatSessionSummary(meta, turns));
}

function cmdMarkProcessed(sessionPath, filters) {
  if (sessionPath === '--all' || sessionPath === 'all') {
    const all = findAllSessions();
    const sessions = applyProjectFilters(all, filters);
    for (const s of sessions) {
      markProcessed(s);
    }
    const skipped = all.length - sessions.length;
    log(`Marked ${sessions.length} sessions as processed${skipped ? ` (${skipped} filtered out)` : ''}`);
  } else {
    let validated;
    try { validated = validateSessionPath(sessionPath); }
    catch (err) { log(err.message); process.exit(1); }
    markProcessed(validated);
    log(`Marked as processed: ${validated}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];
const filters = parseProjectFilters(args);

try {
  switch (command) {
    case '--bootstrap':
      cmdBootstrap(filters);
      break;
    case '--session':
      cmdSession(args[1]);
      break;
    case '--list':
      cmdList(filters);
      break;
    case '--list-pending':
      cmdListPending(filters);
      break;
    case '--mark-processed':
      cmdMarkProcessed(args[1], filters);
      break;
    case '--mark-all-processed':
      cmdMarkProcessed('all', filters);
      break;
    default:
      console.log('Usage:');
      console.log('  node wiki-extract.js --list                   # List sessions and status');
      console.log('  node wiki-extract.js --list-pending           # Print pending session paths (one per line)');
      console.log('  node wiki-extract.js --session <path.jsonl>   # Extract single session');
      console.log('  node wiki-extract.js --bootstrap              # Extract ALL unprocessed (single dump — may blow context)');
      console.log('  node wiki-extract.js --mark-processed <path>  # Mark session as processed');
      console.log('  node wiki-extract.js --mark-all-processed     # Mark all sessions as processed');
      console.log('');
      console.log('Project filters (repeatable):');
      console.log('  --include-project <substr>   Only include sessions whose dir contains <substr>');
      console.log('  --exclude-project <substr>   Skip sessions whose dir contains <substr>');
      console.log('');
      console.log('Iterative bootstrap (recommended — see README):');
      console.log('  for s in $(node wiki-extract.js --list-pending --exclude-project <her-dir>); do');
      console.log('    node wiki-extract.js --session "$s" | claude -p "Update the wiki per CLAUDE.md"');
      console.log('    node wiki-extract.js --mark-processed "$s"');
      console.log('  done');
      break;
  }
} catch (err) {
  log(`Error: ${err.message}`);
  process.exit(1);
}
