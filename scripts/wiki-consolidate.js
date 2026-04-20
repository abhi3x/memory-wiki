#!/usr/bin/env node
'use strict';

/**
 * wiki-consolidate.js — the mechanical half of "dreams".
 *
 * Performs deterministic, safe consolidation of the three memory tiers:
 *
 *   (ii) Prune MEMORY.md entries whose content has been promoted to a wiki
 *        page, leaving a `see ~/.claude/wiki/...` stub in their place.
 *        Detection: wiki page frontmatter `promoteFromMemory: <filename>`.
 *   (iv) Regenerate CLAUDE.md pointer manifests (delegates to wiki-sync.js).
 *
 * It does NOT synthesize new wiki pages from MEMORY.md entries — that's the
 * LLM's job, orchestrated by wiki-dream.sh. This script is pure bookkeeping.
 *
 * Usage:
 *   node wiki-consolidate.js                      # Run all passes
 *   node wiki-consolidate.js --dry-run            # Report what would change, write nothing
 *   node wiki-consolidate.js --prune-only         # Only MEMORY.md prune pass
 *   node wiki-consolidate.js --manifest-only      # Only CLAUDE.md manifest regen
 *
 * Project filters (repeatable):
 *   --include-project <substr>   Only operate on project dirs whose name contains <substr>
 *   --exclude-project <substr>   Skip project dirs whose name contains <substr>
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const WIKI_ROOT = path.join(os.homedir(), '.claude', 'wiki');
const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const SYNC_SCRIPT = path.join(WIKI_ROOT, 'scripts', 'wiki-sync.js');

function log(msg) { process.stderr.write(`[wiki-consolidate] ${msg}\n`); }
function readSafe(p) { try { return fs.readFileSync(p, 'utf-8'); } catch { return null; } }

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };
  const fm = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return { frontmatter: fm, body: match[2] };
}

// ── Scan wiki for promoteFromMemory → wiki page map ──────────────────────────

function buildPromotionMap() {
  const map = new Map();  // memoryFileBasename → wikiPagePath
  const walk = (dir) => {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('_')) {
          const { frontmatter } = parseFrontmatter(readSafe(full) || '');
          const origin = frontmatter.promoteFromMemory;
          if (origin) map.set(origin.replace(/\.md$/, ''), full);
        }
      }
    } catch { /* skip */ }
  };
  walk(path.join(WIKI_ROOT, 'global'));
  walk(path.join(WIKI_ROOT, 'projects'));
  return map;
}

// ── Prune pass — replace promoted memory files with stubs ────────────────────

function pruneMemoryFiles(filters, dryRun) {
  const promotionMap = buildPromotionMap();
  const results = { pruned: [], skipped: [] };

  let projectDirs;
  try {
    projectDirs = fs.readdirSync(CLAUDE_PROJECTS, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .filter(d => {
        if (filters.include.length > 0 && !filters.include.some(p => d.name.includes(p))) return false;
        if (filters.exclude.some(p => d.name.includes(p))) return false;
        return true;
      })
      .map(d => path.join(CLAUDE_PROJECTS, d.name));
  } catch {
    log('Could not read projects directory');
    return results;
  }

  for (const projectDir of projectDirs) {
    const memoryDir = path.join(projectDir, 'memory');
    let files;
    try {
      files = fs.readdirSync(memoryDir)
        .filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
    } catch { continue; }

    for (const file of files) {
      const basename = file.replace(/\.md$/, '');
      const wikiPath = promotionMap.get(basename);
      if (!wikiPath) continue;

      const src = path.join(memoryDir, file);
      const existing = readSafe(src);
      if (!existing) continue;

      // Skip if already a stub
      if (existing.includes('<!-- promoted-to-wiki -->')) {
        results.skipped.push({ src, wikiPath, reason: 'already stub' });
        continue;
      }

      const relWiki = path.relative(os.homedir(), wikiPath);
      const stub = [
        '---',
        `name: ${basename}`,
        `type: reference`,
        `description: Promoted to wiki — canonical content at ~/${relWiki}`,
        '---',
        '<!-- promoted-to-wiki -->',
        '',
        `# ${basename}`,
        '',
        `This memory has been promoted to the wiki. Canonical content:`,
        '',
        `- \`~/${relWiki}\``,
        '',
        `Read that page when you need the content. This stub exists so references to ` +
        `\`${basename}.md\` still resolve but don't duplicate the page.`,
        `Pruned by wiki-consolidate.js on ${new Date().toISOString().slice(0, 10)}.`,
        '',
      ].join('\n');

      if (dryRun) {
        results.pruned.push({ src, wikiPath, action: 'would-prune' });
      } else {
        fs.writeFileSync(src, stub, 'utf-8');
        results.pruned.push({ src, wikiPath, action: 'pruned' });
      }
    }
  }

  return results;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const pruneOnly = args.includes('--prune-only');
const manifestOnly = args.includes('--manifest-only');

const filters = { include: [], exclude: [] };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--include-project' && args[i + 1]) { filters.include.push(args[i + 1]); i++; }
  else if (args[i] === '--exclude-project' && args[i + 1]) { filters.exclude.push(args[i + 1]); i++; }
}

try {
  if (!manifestOnly) {
    log(`Pass (ii) — prune promoted MEMORY.md entries${dryRun ? ' (dry-run)' : ''}`);
    const res = pruneMemoryFiles(filters, dryRun);
    for (const p of res.pruned) log(`${p.action.toUpperCase()}: ${p.src} → stub → ${p.wikiPath}`);
    for (const s of res.skipped) log(`SKIPPED: ${s.src} (${s.reason})`);
    log(`${dryRun ? 'Would prune' : 'Pruned'} ${res.pruned.length} file(s), skipped ${res.skipped.length}`);
  }

  if (!pruneOnly && !dryRun) {
    log(`Pass (iv) — regenerate CLAUDE.md pointer manifests via wiki-sync`);
    const syncArgs = ['--sync-only'];
    for (const p of filters.include) syncArgs.push('--include-project', p);
    for (const p of filters.exclude) syncArgs.push('--exclude-project', p);
    try {
      const out = execFileSync('node', [SYNC_SCRIPT, ...syncArgs], { stdio: ['ignore', 'pipe', 'pipe'] });
      process.stderr.write(out);
    } catch (err) {
      log(`wiki-sync failed: ${err.message}`);
    }
  }

  log('Done.');
} catch (err) {
  log(`Error: ${err.message}`);
  process.exit(1);
}
