#!/usr/bin/env node
'use strict';

/**
 * wiki-sync.js
 *
 * Syncs the Memory Wiki pointer into every project's MEMORY.md.
 * Can also migrate existing Claude Code memory files into the wiki.
 *
 * Usage:
 *   node wiki-sync.js                  # Sync MEMORY.md + check pending extraction
 *   node wiki-sync.js --sync-only      # Just sync MEMORY.md pointers
 *   node wiki-sync.js --extract-only   # Just run extraction for pending sessions
 *   node wiki-sync.js --migrate        # Migrate existing memory files to wiki
 *   node wiki-sync.js --migrate --dry-run  # Preview migration without writing
 *
 * Project filters (repeatable; apply to --migrate and default sync):
 *   --include-project <substr>   Only process project dirs whose name contains <substr>
 *   --exclude-project <substr>   Skip project dirs whose name contains <substr>
 *
 * Designed to run via cron:
 *   42 23 * * * node ~/memory-wiki/scripts/wiki-sync.js --exclude-project partner 2>&1 >> ~/memory-wiki/_sync.log
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const WIKI_ROOT = path.join(os.homedir(), 'memory-wiki');
const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const GLOBAL_CLAUDE_MD = path.join(os.homedir(), '.claude', 'CLAUDE.md');
const PROCESSED_PATH = path.join(WIKI_ROOT, '_processed.json');
const PENDING_EXTRACTION_PATH = path.join(WIKI_ROOT, '_pending-extraction.md');
const WIKI_MARKER = '<!-- memory-wiki-pointer -->';
const CLAUDE_MD_MARKER = '<!-- wiki-pointer-manifest -->';

function log(msg) {
  const ts = new Date().toISOString().slice(0, 19);
  process.stderr.write(`[wiki-sync ${ts}] ${msg}\n`);
}

function readSafe(p) {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Migration: move existing memory files to wiki ───────────────────────────

/**
 * Maps Claude Code memory types to wiki types and directories.
 */
function classifyMemoryFile(filename, frontmatter) {
  const sourceType = frontmatter.type || '';
  const name = (frontmatter.name || '').toLowerCase();
  const desc = (frontmatter.description || '').toLowerCase();

  // Project-scoped files go to projects/
  if (sourceType === 'project') {
    const projectSlug = detectProject(name, desc);
    return {
      wikiType: 'context',
      scope: 'project',
      project: projectSlug,
      dir: path.join('projects', projectSlug, 'context'),
    };
  }

  // References with project keywords go to project dirs
  if (sourceType === 'reference' && detectProject(name, desc) !== 'general') {
    const projectSlug = detectProject(name, desc);
    // Tech stack research → decision type
    const wikiType = name.includes('tech') || name.includes('stack') || name.includes('research')
      ? 'decision' : 'entity';
    const subdir = wikiType === 'decision' ? 'decisions' : 'context';
    return {
      wikiType,
      scope: 'project',
      project: projectSlug,
      dir: path.join('projects', projectSlug, subdir),
    };
  }

  // Global references → entities
  if (sourceType === 'reference') {
    return { wikiType: 'entity', scope: 'global', dir: 'global/entities' };
  }

  // User type: profile info → entity, behavioral → preference
  if (sourceType === 'user') {
    const isBehavioral = name.includes('pattern') || name.includes('cognitive')
      || name.includes('behavioral') || desc.includes('energy') || desc.includes('vices');
    return isBehavioral
      ? { wikiType: 'preference', scope: 'global', dir: 'global/preferences' }
      : { wikiType: 'entity', scope: 'global', dir: 'global/entities' };
  }

  // Feedback → preference
  if (sourceType === 'feedback') {
    return { wikiType: 'preference', scope: 'global', dir: 'global/preferences' };
  }

  // Fallback
  return { wikiType: 'pattern', scope: 'global', dir: 'global/patterns' };
}

function detectProject(name, desc) {
  const text = `${name} ${desc}`;
  if (text.includes('embeddai') || text.includes('khata') || text.includes('codebase q&a')
      || text.includes('track 1') || text.includes('fintech onboarding')) {
    return 'embeddai';
  }
  return 'general';
}

function toKebabCase(str) {
  return str
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

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

function buildWikiFrontmatter(id, wikiType, scope, confidence, tags, related) {
  const lines = [
    '---',
    `id: ${id}`,
    `type: ${wikiType}`,
    `scope: ${scope}`,
    `confidence: ${confidence}`,
    `tags: [${tags.join(', ')}]`,
  ];
  if (related.length > 0) {
    lines.push(`related: [${related.join(', ')}]`);
  }
  lines.push('---');
  return lines.join('\n');
}

function migrateMemoryFiles(dryRun, filters = { include: [], exclude: [] }) {
  const migrated = [];
  const skipped = [];
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
    return { migrated, skipped };
  }

  for (const projectDir of projectDirs) {
    const memoryDir = path.join(projectDir, 'memory');
    let files;
    try {
      files = fs.readdirSync(memoryDir)
        .filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
    } catch {
      continue; // no memory dir or empty
    }

    for (const file of files) {
      const srcPath = path.join(memoryDir, file);
      const content = readSafe(srcPath);
      if (!content) continue;

      const { frontmatter, body } = parseFrontmatter(content);
      const classification = classifyMemoryFile(file, frontmatter);

      // Generate wiki ID from the name or filename
      const nameSource = frontmatter.name || file.replace('.md', '');
      const wikiId = toKebabCase(nameSource);

      // Check if already exists in wiki
      const destDir = path.join(WIKI_ROOT, classification.dir);
      const destPath = path.join(destDir, `${wikiId}.md`);

      if (fs.existsSync(destPath)) {
        skipped.push({ src: srcPath, dest: destPath, reason: 'already exists' });
        continue;
      }

      // Derive tags from content
      const tags = deriveTags(frontmatter, classification);

      // Build new frontmatter
      const newFrontmatter = buildWikiFrontmatter(
        wikiId,
        classification.wikiType,
        classification.scope,
        0.85,
        tags,
        []
      );

      // Build the page title
      const title = frontmatter.name || file.replace('.md', '').replace(/_/g, ' ');

      // Construct the new page
      const newContent = [
        newFrontmatter,
        '',
        `# ${title}`,
        '',
        '## Summary',
        frontmatter.description || '',
        '',
        '## Details',
        body.trim(),
        '',
        '## Evidence',
        `- ${new Date().toISOString().slice(0, 10)}: Migrated from Claude Code memory (${path.basename(projectDir)})`,
      ].join('\n') + '\n';

      if (dryRun) {
        migrated.push({ src: srcPath, dest: destPath, id: wikiId, type: classification.wikiType });
        continue;
      }

      // Write the wiki page
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(destPath, newContent, 'utf-8');
      migrated.push({ src: srcPath, dest: destPath, id: wikiId, type: classification.wikiType });
      log(`Migrated: ${file} → ${classification.dir}/${wikiId}.md`);
    }
  }

  // Update _index.md if we migrated anything
  if (migrated.length > 0 && !dryRun) {
    updateIndex(migrated);
  }

  return { migrated, skipped };
}

function deriveTags(frontmatter, classification) {
  const tags = [];
  const text = `${frontmatter.name || ''} ${frontmatter.description || ''}`.toLowerCase();

  if (text.includes('embeddai') || text.includes('khata')) tags.push('embeddai');
  if (text.includes('communication') || text.includes('style')) tags.push('communication');
  if (text.includes('pattern') || text.includes('behavioral')) tags.push('behavioral');
  if (text.includes('tech') || text.includes('stack')) tags.push('tech-stack');
  if (text.includes('startup') || text.includes('priorities')) tags.push('startup');
  if (text.includes('profile') || text.includes('abhishek')) tags.push('profile');
  if (text.includes('onboarding') || text.includes('fintech')) tags.push('fintech');

  if (classification.scope === 'project' && classification.project) {
    tags.push(classification.project);
  }

  return tags.length > 0 ? tags : ['migrated'];
}

function updateIndex(migratedPages) {
  const indexPath = path.join(WIKI_ROOT, '_index.md');
  let index = readSafe(indexPath) || '# Memory Wiki Index\n\nUpdated: ' + new Date().toISOString().slice(0, 10) + '\n';

  // Group by type
  const byType = {};
  for (const page of migratedPages) {
    if (!byType[page.type]) byType[page.type] = [];
    byType[page.type].push(page);
  }

  // Type → section header mapping
  const typeToSection = {
    entity: 'Entities',
    decision: 'Decisions',
    pattern: 'Patterns',
    preference: 'Preferences',
    troubleshooting: 'Troubleshooting',
    context: 'Projects',
  };

  for (const [type, pages] of Object.entries(byType)) {
    for (const page of pages) {
      const entry = `- [[${page.id}]]`;
      // Only add if not already in index
      if (!index.includes(`[[${page.id}]]`)) {
        const section = typeToSection[type] || 'Patterns';

        if (type === 'context') {
          // Project-scoped: add under Projects section
          const projectHeader = `### ${page.id.includes('embeddai') ? 'embeddai' : 'general'}`;
          if (!index.includes(projectHeader)) {
            // Add project section if missing
            const projectsMarker = '## Projects';
            if (index.includes(projectsMarker)) {
              index = index.replace(
                '_No project wikis yet._',
                `${projectHeader}\n${entry}`
              );
              // If the marker text wasn't there, append after ## Projects
              if (!index.includes(projectHeader)) {
                index = index.replace(
                  projectsMarker,
                  `${projectsMarker}\n\n${projectHeader}\n${entry}`
                );
              }
            }
          } else {
            // Append under existing project header
            const headerIdx = index.indexOf(projectHeader);
            const nextSection = index.indexOf('\n##', headerIdx + 1);
            const insertAt = nextSection > 0 ? nextSection : index.length;
            index = index.slice(0, insertAt) + '\n' + entry + index.slice(insertAt);
          }
        } else {
          // Global: add under the matching ### section
          const sectionHeader = `### ${section}`;
          const sectionIdx = index.indexOf(sectionHeader);
          if (sectionIdx >= 0) {
            // Find the count in parentheses and increment
            const countMatch = index.slice(sectionIdx).match(/\((\d+)\)/);
            if (countMatch) {
              const oldCount = parseInt(countMatch[1], 10);
              index = index.replace(
                `${sectionHeader} (${oldCount})`,
                `${sectionHeader} (${oldCount + 1})`
              );
            }
            // Insert entry after the header line
            const lineEnd = index.indexOf('\n', sectionIdx);
            index = index.slice(0, lineEnd + 1) + entry + '\n' + index.slice(lineEnd + 1);
          }
        }
      }
    }
  }

  // Update total count and date
  const totalMatch = index.match(/Total pages: (\d+)/);
  if (totalMatch) {
    const newTotal = parseInt(totalMatch[1], 10) + migratedPages.length;
    index = index.replace(`Total pages: ${totalMatch[1]}`, `Total pages: ${newTotal}`);
  }
  index = index.replace(/Last updated: \d{4}-\d{2}-\d{2}/, `Last updated: ${new Date().toISOString().slice(0, 10)}`);

  fs.writeFileSync(indexPath, index, 'utf-8');
  log(`Updated _index.md with ${migratedPages.length} new entries`);
}

// ── MEMORY.md pointer (shrunk) ───────────────────────────────────────────────
//
// MEMORY.md holds only dynamic auto-memory observations now. The full wiki
// pointer manifest lives in CLAUDE.md (injected by syncGlobalClaudeMd /
// syncProjectClaudeMds). MEMORY.md just carries a one-line nudge.

function buildWikiPointer(/* projectDir */) {
  return `${WIKI_MARKER}
# Memory

Wiki pointers live in \`~/.claude/CLAUDE.md\` (global) and \`<project>/CLAUDE.md\` (per-project).
This file holds only dynamic auto-memory — things Claude noticed during sessions that aren't yet worth promoting to the wiki.
Canonical content is at \`~/memory-wiki/\`. Index: \`~/memory-wiki/_index.md\`. Schema: \`~/memory-wiki/_schema.md\`.
${WIKI_MARKER}`;
}

// ── Page walk + alwaysLoad collection ────────────────────────────────────────

function walkMd(dir, onFile) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walkMd(full, onFile);
      else if (e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('_')) onFile(full);
    }
  } catch { /* skip */ }
}

/**
 * Returns pages with `alwaysLoad: true` in frontmatter, grouped by wiki type.
 * @param {string} scope 'global' → scans wiki/global/**; project slug → scans wiki/projects/<slug>/**
 */
function collectAlwaysLoadPages(scope) {
  const root = scope === 'global'
    ? path.join(WIKI_ROOT, 'global')
    : path.join(WIKI_ROOT, 'projects', scope);

  const pages = [];
  walkMd(root, (filePath) => {
    const content = readSafe(filePath);
    if (!content) return;
    const { frontmatter } = parseFrontmatter(content);
    if (String(frontmatter.alwaysLoad).trim() !== 'true') return;

    // Pull a one-line description: prefer frontmatter.description, else Summary first line.
    let desc = frontmatter.description || '';
    if (!desc) {
      const match = content.match(/^## Summary\s*\n([^\n]+)/m);
      if (match) desc = match[1].trim();
    }

    pages.push({
      id: frontmatter.id || path.basename(filePath, '.md'),
      type: frontmatter.type || 'page',
      absPath: filePath,
      desc: desc.slice(0, 180),
    });
  });

  // Sort by type, then id — stable output
  const typeOrder = ['preference', 'decision', 'pattern', 'entity', 'context', 'troubleshooting', 'concept', 'area', 'person'];
  pages.sort((a, b) => {
    const ai = typeOrder.indexOf(a.type), bi = typeOrder.indexOf(b.type);
    if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    return a.id.localeCompare(b.id);
  });

  return pages;
}

// ── CLAUDE.md manifest builder ───────────────────────────────────────────────

function buildClaudeMdManifest(scope) {
  const pages = collectAlwaysLoadPages(scope);
  const date = new Date().toISOString().slice(0, 10);

  const header = scope === 'global'
    ? '# Wiki — always-loaded context\n\n' +
      `Pointers to wiki pages marked \`alwaysLoad: true\`. Full content is at \`~/memory-wiki/\` — read specific pages on demand.\n` +
      `Full catalog: \`~/memory-wiki/_index.md\`. Schema + operations: \`~/memory-wiki/_schema.md\`.\n`
    : `# Wiki — project context (${scope})\n\n` +
      `Pointers to wiki pages under \`~/memory-wiki/projects/${scope}/**\` marked \`alwaysLoad: true\`.\n`;

  let body;
  if (pages.length === 0) {
    body = '_No pages flagged `alwaysLoad: true` yet. Set the flag in page frontmatter to promote here._';
  } else {
    // Group by type
    const byType = {};
    for (const p of pages) {
      if (!byType[p.type]) byType[p.type] = [];
      byType[p.type].push(p);
    }
    // Plural labels (avoid naïve `+s` → "entitys")
    const plural = {
      preference: 'Preferences', decision: 'Decisions', pattern: 'Patterns',
      entity: 'Entities', context: 'Context', troubleshooting: 'Troubleshooting',
      concept: 'Concepts', area: 'Areas', person: 'People', page: 'Pages',
    };
    const sections = [];
    for (const [type, items] of Object.entries(byType)) {
      const label = plural[type] || (type.charAt(0).toUpperCase() + type.slice(1));
      sections.push(`## ${label}`);
      for (const p of items) {
        const suffix = p.desc ? ` — ${p.desc}` : '';
        sections.push(`- \`${p.absPath}\`${suffix}`);
      }
      sections.push('');
    }
    body = sections.join('\n').trim();
  }

  return `${CLAUDE_MD_MARKER}\n${header}\nLast synced: ${date} · ${pages.length} page(s)\n\n${body}\n${CLAUDE_MD_MARKER}`;
}

// ── Inject manifest into a CLAUDE.md (marker-block replacement) ──────────────

function injectIntoClaudeMd(filePath, manifest) {
  const existing = readSafe(filePath);

  if (existing === null) {
    // Create file with manifest only. Don't fabricate other content.
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, manifest + '\n', 'utf-8');
    return 'created';
  }

  if (existing.includes(CLAUDE_MD_MARKER)) {
    const markerRegex = new RegExp(
      `${escapeRegex(CLAUDE_MD_MARKER)}[\\s\\S]*?${escapeRegex(CLAUDE_MD_MARKER)}`,
      'g'
    );
    const updated = existing.replace(markerRegex, manifest);
    if (updated === existing) return 'unchanged';
    fs.writeFileSync(filePath, updated, 'utf-8');
    return 'updated';
  }

  // Marker not present — append to end so we don't disturb user content.
  const sep = existing.endsWith('\n') ? '\n' : '\n\n';
  fs.writeFileSync(filePath, existing + sep + manifest + '\n', 'utf-8');
  return 'appended';
}

// ── Map sanitized ~/.claude/projects/<dir> → real filesystem cwd ────────────

function getCwdForProjectDir(sanitizedDirPath) {
  // Walk recursively, find any JSONL entry with a cwd field whose path exists.
  const visit = (dir) => {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          const hit = visit(full);
          if (hit) return hit;
        } else if (e.isFile() && e.name.endsWith('.jsonl')) {
          const lines = fs.readFileSync(full, 'utf-8').split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line);
              if (entry.cwd && fs.existsSync(entry.cwd)) return entry.cwd;
            } catch { /* skip */ }
          }
        }
      }
    } catch { /* skip */ }
    return null;
  };

  const fromJsonl = visit(sanitizedDirPath);
  if (fromJsonl) return fromJsonl;

  // Fallback: reverse the sanitization heuristically.
  // `-Users-abhisheksuhani-abhishek_work-embeddai_repo` → `/Users/abhisheksuhani/abhishek_work/embeddai_repo`.
  // Dashes inside real dirnames (e.g. `abhishek-work`) are ambiguous — we accept that and fail gracefully.
  const name = path.basename(sanitizedDirPath);
  const guess = '/' + name.replace(/^-/, '').replace(/-/g, '/');
  if (fs.existsSync(guess)) return guess;
  return null;
}

// ── syncGlobalClaudeMd + syncProjectClaudeMds ───────────────────────────────

function syncGlobalClaudeMd() {
  const manifest = buildClaudeMdManifest('global');
  const result = injectIntoClaudeMd(GLOBAL_CLAUDE_MD, manifest);
  log(`Global ~/.claude/CLAUDE.md: ${result}`);
  return result;
}

function syncProjectClaudeMds(filters = { include: [], exclude: [] }) {
  const projectsDir = path.join(WIKI_ROOT, 'projects');
  let wikiProjects = [];
  try {
    wikiProjects = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
  } catch { return 0; }

  let synced = 0;
  for (const wp of wikiProjects) {
    // Find the sanitized project dir under ~/.claude/projects that maps to this wiki project
    let cwd = null;
    try {
      const candidates = fs.readdirSync(CLAUDE_PROJECTS, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .filter(d => {
          if (filters.include.length > 0 && !filters.include.some(p => d.name.includes(p))) return false;
          if (filters.exclude.some(p => d.name.includes(p))) return false;
          return d.name.includes(wp) || d.name.includes(wp.replace(/-/g, ''));
        });
      for (const c of candidates) {
        const resolved = getCwdForProjectDir(path.join(CLAUDE_PROJECTS, c.name));
        if (resolved) { cwd = resolved; break; }
      }
    } catch { /* skip */ }

    if (!cwd) {
      log(`Skipping wiki project '${wp}' — could not resolve cwd`);
      continue;
    }

    const claudeMdPath = path.join(cwd, 'CLAUDE.md');
    const manifest = buildClaudeMdManifest(wp);
    const result = injectIntoClaudeMd(claudeMdPath, manifest);
    log(`Project CLAUDE.md (${wp} → ${claudeMdPath}): ${result}`);
    synced++;
  }
  return synced;
}

function buildProjectContext(projectDir) {
  if (!projectDir) return null;

  // Try to detect which wiki project this maps to
  const dirName = path.basename(projectDir).toLowerCase();
  const projectsDir = path.join(WIKI_ROOT, 'projects');

  let matchedProject = null;

  try {
    const wikiProjects = fs.readdirSync(projectsDir).filter(d =>
      fs.statSync(path.join(projectsDir, d)).isDirectory()
    );

    for (const wp of wikiProjects) {
      if (dirName.includes(wp) || dirName.includes(wp.replace(/-/g, ''))) {
        matchedProject = wp;
        break;
      }
    }
  } catch { /* no projects dir */ }

  if (!matchedProject) return null;

  // List all pages under this project
  const projectWikiDir = path.join(projectsDir, matchedProject);
  const pages = [];

  function walkProject(dir, prefix) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) {
          walkProject(path.join(dir, e.name), `${prefix}${e.name}/`);
        } else if (e.isFile() && e.name.endsWith('.md')) {
          const content = readSafe(path.join(dir, e.name));
          const { frontmatter } = content ? parseFrontmatter(content) : { frontmatter: {} };
          pages.push({
            path: `~/memory-wiki/projects/${matchedProject}/${prefix}${e.name}`,
            name: frontmatter.name || e.name.replace('.md', ''),
          });
        }
      }
    } catch { /* skip */ }
  }
  walkProject(projectWikiDir, '');

  if (pages.length === 0) return null;

  return pages.map(p => `- Read \`${p.path}\` — ${p.name}`).join('\n');
}

function loadCriticalPreferences() {
  const prefsDir = path.join(WIKI_ROOT, 'global', 'preferences');
  const prefs = [];

  try {
    const files = fs.readdirSync(prefsDir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const content = readSafe(path.join(prefsDir, file));
      if (!content) continue;

      const { frontmatter, body } = parseFrontmatter(content);
      const confidence = parseFloat(frontmatter.confidence || '0');

      // Only inline high-confidence preferences
      if (confidence >= 0.8) {
        // Extract the first meaningful line from the body as a summary
        const lines = body.split('\n').filter(l => l.trim() && !l.startsWith('#'));
        const summary = lines[0] || frontmatter.description || '';
        if (summary) {
          prefs.push(`- **${frontmatter.name || file}**: ${summary.trim().slice(0, 150)}`);
        }
      }
    }
  } catch { /* no prefs dir yet */ }

  return prefs;
}

function extractCount(line) {
  const match = line.match(/\((\d+)\)/);
  return match ? parseInt(match[1], 10) : 0;
}

// ── Sync MEMORY.md across all projects ───────────────────────────────────────

function syncMemoryFiles(filters = { include: [], exclude: [] }) {
  // Find all project directories
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
    return 0;
  }

  let synced = 0;

  for (const projectDir of projectDirs) {
    const memoryDir = path.join(projectDir, 'memory');
    const memoryFile = path.join(memoryDir, 'MEMORY.md');

    // Build per-project pointer
    const wikiPointer = buildWikiPointer(projectDir);

    // Read existing MEMORY.md
    const existing = readSafe(memoryFile);

    if (existing === null) {
      // No memory dir/file — create with just the pointer
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.writeFileSync(memoryFile, wikiPointer + '\n', 'utf-8');
      synced++;
      continue;
    }

    // Check if pointer already exists
    if (existing.includes(WIKI_MARKER)) {
      // Replace existing pointer block, preserve everything after
      const markerRegex = new RegExp(
        `${escapeRegex(WIKI_MARKER)}[\\s\\S]*?${escapeRegex(WIKI_MARKER)}`,
        'g'
      );
      const cleaned = existing.replace(markerRegex, '').trim();

      // Filter out old memory file references that have been migrated
      const preservedLines = cleaned.split('\n').filter(line => {
        // Keep lines that aren't old memory file pointers
        if (line.match(/^- \[.+\]\(.+\.md\) —/)) {
          // Check if this memory file still exists
          const linkMatch = line.match(/\]\(([^)]+)\)/);
          if (linkMatch) {
            const linkedFile = path.join(path.dirname(memoryFile), linkMatch[1]);
            return fs.existsSync(linkedFile);
          }
        }
        return true;
      });

      const preservedContent = preservedLines.join('\n').trim();
      const updated = preservedContent
        ? wikiPointer + '\n\n' + preservedContent + '\n'
        : wikiPointer + '\n';
      fs.writeFileSync(memoryFile, updated, 'utf-8');
      synced++;
      continue;
    }

    // No pointer yet — prepend it, keep existing content
    const updated = wikiPointer + '\n\n' + existing;
    fs.writeFileSync(memoryFile, updated, 'utf-8');
    synced++;
  }

  return synced;
}

// ── Extract pending sessions ─────────────────────────────────────────────────

function extractPending() {
  // Find all JSONL sessions
  const sessions = [];
  function walk(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && !e.name.startsWith('.') && !full.includes('/subagents/')) {
          walk(full);
        } else if (e.isFile() && e.name.endsWith('.jsonl') && !full.includes('/subagents/')) {
          sessions.push(full);
        }
      }
    } catch { /* skip */ }
  }
  walk(CLAUDE_PROJECTS);

  // Check processed
  let processed = {};
  try {
    processed = JSON.parse(fs.readFileSync(PROCESSED_PATH, 'utf-8')).sessions || {};
  } catch { /* none processed */ }

  const pending = sessions.filter(s => !processed[s]);

  if (pending.length === 0) {
    log('No pending sessions to extract');
    try { fs.unlinkSync(PENDING_EXTRACTION_PATH); } catch { /* ok */ }
    return 0;
  }

  log(`${pending.length} sessions pending extraction`);

  const notice = [
    `# Pending Extraction — ${new Date().toISOString().slice(0, 10)}`,
    '',
    `${pending.length} sessions have not been processed into the wiki yet.`,
    '',
    'To extract knowledge from these sessions, run:',
    '```',
    'node ~/memory-wiki/scripts/wiki-extract.js --bootstrap',
    '```',
    '',
    'Then read the output and create/update wiki pages for significant knowledge.',
    'After done, mark all as processed:',
    '```',
    'node ~/memory-wiki/scripts/wiki-extract.js --mark-all-processed',
    '```',
    '',
    '## Pending sessions:',
    '',
  ].join('\n');

  const sessionList = pending.map(s => {
    const stat = fs.statSync(s);
    const date = stat.mtime.toISOString().slice(0, 10);
    const sizeKB = Math.round(stat.size / 1024);
    return `- ${date} | ${sizeKB}KB | ${path.basename(path.dirname(s))}`;
  }).join('\n');

  fs.writeFileSync(PENDING_EXTRACTION_PATH, notice + sessionList + '\n', 'utf-8');
  return pending.length;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const syncOnly = args.includes('--sync-only');
const extractOnly = args.includes('--extract-only');
const doMigrate = args.includes('--migrate');
const dryRun = args.includes('--dry-run');

// Parse repeatable --include-project / --exclude-project
const filters = { include: [], exclude: [] };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--include-project' && args[i + 1]) { filters.include.push(args[i + 1]); i++; }
  else if (args[i] === '--exclude-project' && args[i + 1]) { filters.exclude.push(args[i + 1]); i++; }
}

try {
  if (doMigrate) {
    log(dryRun ? 'Migration dry run...' : 'Migrating memory files to wiki...');
    const { migrated, skipped } = migrateMemoryFiles(dryRun, filters);

    if (migrated.length === 0 && skipped.length === 0) {
      log('No memory files found to migrate');
    } else {
      for (const m of migrated) {
        const label = dryRun ? 'WOULD MIGRATE' : 'MIGRATED';
        log(`${label}: ${path.basename(m.src)} → ${m.dest} (${m.type})`);
      }
      for (const s of skipped) {
        log(`SKIPPED: ${path.basename(s.src)} — ${s.reason}`);
      }
      log(`${dryRun ? 'Would migrate' : 'Migrated'} ${migrated.length} files, skipped ${skipped.length}`);
    }

    // After migration, run the full 3-surface sync (global + project CLAUDE.md, MEMORY.md stub)
    if (!dryRun) {
      syncGlobalClaudeMd();
      const projSynced = syncProjectClaudeMds(filters);
      const memSynced = syncMemoryFiles(filters);
      log(`Post-migrate: ${projSynced} project CLAUDE.md + ${memSynced} MEMORY.md stubs synced`);
    }
  }

  if (!doMigrate) {
    if (!extractOnly) {
      // Three sync surfaces — keep them in lockstep.
      syncGlobalClaudeMd();
      const projSynced = syncProjectClaudeMds(filters);
      log(`Synced wiki pointer manifest into ${projSynced} project CLAUDE.md file(s)`);

      const memSynced = syncMemoryFiles(filters);
      log(`Synced shrunk MEMORY.md stub into ${memSynced} project memory file(s)`);
    }

    if (!syncOnly) {
      const pending = extractPending();
      if (pending > 0) {
        log(`Wrote pending extraction notice (${pending} sessions)`);
      }
    }
  }

  log('Done');
} catch (err) {
  log(`Error: ${err.message}`);
  process.exit(1);
}
