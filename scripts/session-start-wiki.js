#!/usr/bin/env node
'use strict';

/**
 * Session Start Hook — Wiki Context Loader
 *
 * Loads wiki index, pending extraction count, project context,
 * and recent log into the session as additional context.
 *
 * Hook event: SessionStart
 * Input: JSON on stdin with { session_id, cwd }
 * Output: JSON on stdout with { hookSpecificOutput: { additionalContext: "..." } }
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const WIKI_ROOT = path.join(os.homedir(), '.claude', 'wiki');
const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const MAX_LOG_LINES = 20;
const MAX_CONTEXT_PAGES = 5;

function log(msg) {
  process.stderr.write(`[WikiStart] ${msg}\n`);
}

function readSafe(filePath) {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
}

function countPendingSessions() {
  const processedPath = path.join(WIKI_ROOT, '_processed.json');
  let processed = {};
  try {
    processed = JSON.parse(fs.readFileSync(processedPath, 'utf-8')).sessions || {};
  } catch { /* no processed file yet */ }

  let total = 0;
  let pending = 0;

  function walk(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && !e.name.startsWith('.') && !full.includes('/subagents/')) {
          walk(full);
        } else if (e.isFile() && e.name.endsWith('.jsonl')) {
          if (!full.includes('/subagents/')) {
            total++;
            if (!processed[full]) pending++;
          }
        }
      }
    } catch { /* skip */ }
  }

  walk(CLAUDE_PROJECTS);
  return { total, pending };
}

function detectProject(cwd) {
  if (!cwd) return null;
  const projectsDir = path.join(WIKI_ROOT, 'projects');
  if (!fs.existsSync(projectsDir)) return null;

  try {
    const projects = fs.readdirSync(projectsDir);
    const basename = path.basename(cwd);
    if (projects.includes(basename)) return basename;
  } catch { /* ignore */ }
  return null;
}

function loadProjectPages(projectName) {
  if (!projectName) return '';
  const dir = path.join(WIKI_ROOT, 'projects', projectName);
  if (!fs.existsSync(dir)) return '';

  const parts = [];
  const index = readSafe(path.join(dir, '_index.md'));
  if (index) parts.push(index);

  // Load context pages
  const ctxDir = path.join(dir, 'context');
  if (fs.existsSync(ctxDir)) {
    try {
      const files = fs.readdirSync(ctxDir).filter(f => f.endsWith('.md')).slice(0, MAX_CONTEXT_PAGES);
      for (const f of files) {
        const content = readSafe(path.join(ctxDir, f));
        if (content) parts.push(content);
      }
    } catch { /* ignore */ }
  }

  return parts.join('\n\n');
}

function loadGlobalPreferences() {
  const prefsDir = path.join(WIKI_ROOT, 'global', 'preferences');
  if (!fs.existsSync(prefsDir)) return '';

  try {
    const files = fs.readdirSync(prefsDir).filter(f => f.endsWith('.md'));
    const parts = [];
    for (const f of files) {
      const content = readSafe(path.join(prefsDir, f));
      if (content) parts.push(content);
    }
    return parts.join('\n\n');
  } catch { return ''; }
}

async function main() {
  try {
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; }

    let hookData = {};
    try { hookData = JSON.parse(input); } catch { /* no input */ }

    const cwd = hookData.cwd || process.cwd();
    const ctx = [];

    // 1. Wiki status
    const { total, pending } = countPendingSessions();
    ctx.push([
      '## Memory Wiki',
      `Wiki at ~/.claude/wiki/ | ${total} total sessions | ${pending} pending extraction`,
      'Run `node ~/.claude/wiki/scripts/wiki-extract.js --list` to see session status.',
      pending > 0
        ? `**${pending} unprocessed sessions.** Run \`node ~/.claude/wiki/scripts/wiki-extract.js --bootstrap\` to extract knowledge.`
        : 'All sessions processed.',
    ].join('\n'));

    // 2. Index
    const index = readSafe(path.join(WIKI_ROOT, '_index.md'));
    if (index && !index.includes('Total pages: 0')) {
      ctx.push(`## Wiki Pages\n${index}`);
    }

    // 3. Global preferences (always loaded — they apply everywhere)
    const prefs = loadGlobalPreferences();
    if (prefs) {
      ctx.push(`## Your Preferences\n${prefs}`);
    }

    // 4. Project context
    const project = detectProject(cwd);
    if (project) {
      const pages = loadProjectPages(project);
      if (pages) ctx.push(`## Project: ${project}\n${pages}`);
    }

    // 5. Recent log (last 20 lines)
    const logContent = readSafe(path.join(WIKI_ROOT, '_log.md'));
    if (logContent) {
      const recent = logContent.split('\n').slice(-MAX_LOG_LINES).join('\n');
      if (recent.trim()) ctx.push(`## Recent Wiki Activity\n${recent}`);
    }

    const output = {
      hookSpecificOutput: {
        additionalContext: ctx.join('\n\n---\n\n')
      }
    };

    process.stdout.write(JSON.stringify(output));
    log(`Loaded: project=${project || 'none'}, pending=${pending}/${total}`);

  } catch (err) {
    log(`Error: ${err.message}`);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: '' } }));
  }

  process.exit(0);
}

main();
