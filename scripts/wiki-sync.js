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
 * Designed to run via cron:
 *   42 23 * * * node ~/.claude/wiki/scripts/wiki-sync.js 2>&1 >> ~/.claude/wiki/_sync.log
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const WIKI_ROOT = path.join(os.homedir(), '.claude', 'wiki');
const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const PROCESSED_PATH = path.join(WIKI_ROOT, '_processed.json');
const PENDING_EXTRACTION_PATH = path.join(WIKI_ROOT, '_pending-extraction.md');
const WIKI_MARKER = '<!-- memory-wiki-pointer -->';

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

function migrateMemoryFiles(dryRun) {
  const migrated = [];
  const skipped = [];
  let projectDirs;

  try {
    projectDirs = fs.readdirSync(CLAUDE_PROJECTS, { withFileTypes: true })
      .filter(d => d.isDirectory())
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

// ── Build the wiki pointer block ─────────────────────────────────────────────

function buildWikiPointer(projectDir) {
  // Read the index to get page counts
  const index = readSafe(path.join(WIKI_ROOT, '_index.md'));

  const counts = { entities: 0, decisions: 0, patterns: 0, preferences: 0, troubleshooting: 0 };

  if (index) {
    const lines = index.split('\n');
    for (const line of lines) {
      if (line.startsWith('### Entities')) counts.entities = extractCount(line);
      if (line.startsWith('### Decisions')) counts.decisions = extractCount(line);
      if (line.startsWith('### Patterns')) counts.patterns = extractCount(line);
      if (line.startsWith('### Preferences')) counts.preferences = extractCount(line);
      if (line.startsWith('### Troubleshooting')) counts.troubleshooting = extractCount(line);
    }
  }

  // Count project wikis
  const projectsDir = path.join(WIKI_ROOT, 'projects');
  let projectCount = 0;
  try {
    projectCount = fs.readdirSync(projectsDir).filter(d =>
      fs.statSync(path.join(projectsDir, d)).isDirectory()
    ).length;
  } catch { /* no projects yet */ }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  // Build summary lines
  const summaryLines = [];
  if (counts.preferences > 0) summaryLines.push(`- ${counts.preferences} preferences (coding style, tool choices)`);
  if (counts.decisions > 0) summaryLines.push(`- ${counts.decisions} decisions (architectural choices + rationale)`);
  if (counts.patterns > 0) summaryLines.push(`- ${counts.patterns} patterns (recurring solutions)`);
  if (counts.entities > 0) summaryLines.push(`- ${counts.entities} entities (tools, services, APIs)`);
  if (counts.troubleshooting > 0) summaryLines.push(`- ${counts.troubleshooting} troubleshooting (known issues + fixes)`);
  if (projectCount > 0) summaryLines.push(`- ${projectCount} project-specific wikis`);

  const summary = summaryLines.length > 0
    ? summaryLines.join('\n')
    : '- No pages yet. Create pages as you learn things worth keeping.';

  // Find project-specific wiki pages
  const projectContext = buildProjectContext(projectDir);

  // Load critical preferences to inline
  const criticalPrefs = loadCriticalPreferences();

  let pointer = `${WIKI_MARKER}
# Memory Wiki

You have a persistent knowledge wiki at \`~/.claude/wiki/\`.
Read \`~/.claude/wiki/_index.md\` for the full index when you need to find something.
Read \`~/.claude/wiki/_schema.md\` for rules on creating/updating pages.

## What you know (${total} pages)
${summary}`;

  // Inline critical preferences (always in context)
  if (criticalPrefs.length > 0) {
    pointer += '\n\n## Critical preferences (always loaded)\n';
    pointer += criticalPrefs.join('\n');
  }

  // Add project-specific pages if detected
  if (projectContext) {
    pointer += '\n\n## Project context — READ THESE FIRST\n';
    pointer += projectContext;
  }

  pointer += `

## How to use
- Read specific wiki pages when the conversation topic matches what you know
- After significant conversations, create/update wiki pages
- Check pending: \`node ~/.claude/wiki/scripts/wiki-extract.js --list\`
${WIKI_MARKER}`;

  return pointer;
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
            path: `~/.claude/wiki/projects/${matchedProject}/${prefix}${e.name}`,
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

function syncMemoryFiles() {
  // Find all project directories
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(CLAUDE_PROJECTS, { withFileTypes: true })
      .filter(d => d.isDirectory())
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
    'node ~/.claude/wiki/scripts/wiki-extract.js --bootstrap',
    '```',
    '',
    'Then read the output and create/update wiki pages for significant knowledge.',
    'After done, mark all as processed:',
    '```',
    'node ~/.claude/wiki/scripts/wiki-extract.js --mark-all-processed',
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

try {
  if (doMigrate) {
    log(dryRun ? 'Migration dry run...' : 'Migrating memory files to wiki...');
    const { migrated, skipped } = migrateMemoryFiles(dryRun);

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

    // After migration, run sync to update MEMORY.md pointers
    if (!dryRun) {
      const synced = syncMemoryFiles();
      log(`Synced wiki pointer to ${synced} project MEMORY.md files`);
    }
  }

  if (!doMigrate) {
    if (!extractOnly) {
      const synced = syncMemoryFiles();
      log(`Synced wiki pointer to ${synced} project MEMORY.md files`);
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
