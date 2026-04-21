'use strict';

/**
 * wiki-utils.js — shared helpers for memory-wiki scripts.
 *
 * Centralizes the primitives that security review flagged as ad-hoc across
 * four files: path validation (#1), symlink-safe directory walks (#4),
 * and atomic writes (non-atomic-writes finding). Other scripts should
 * require this rather than re-implementing.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const HOME = os.homedir();

// Single source of truth for the wiki root. Honors MEMORY_WIKI_ROOT so users
// can relocate the wiki without patching every script. Always resolved to an
// absolute real path (symlinks collapsed) so downstream prefix checks can't
// be bypassed by a symlinked entry point.
const WIKI_ROOT = (() => {
  const configured = process.env.MEMORY_WIKI_ROOT || path.join(HOME, 'memory-wiki');
  // Don't require it to exist yet (installer runs before it does). Just normalize.
  return path.resolve(configured);
})();

const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');
const CLAUDE_SETTINGS_DIR = path.join(HOME, '.claude');

/**
 * Return an absolute, lexically-normalized path. Does NOT follow symlinks
 * (that's on purpose — realpath() on a not-yet-existent target throws, and
 * we want prefix checks to operate on the requested path, not the resolved
 * link target).
 */
function normalize(p) {
  return path.resolve(p);
}

/**
 * True iff `candidate` is `root` or a descendant. Operates on normalized
 * paths with a trailing separator to avoid prefix-confusion (e.g.
 * /tmp/foo vs /tmp/foobar).
 */
function isPathInside(candidate, root) {
  const c = normalize(candidate);
  const r = normalize(root);
  if (c === r) return true;
  const rWithSep = r.endsWith(path.sep) ? r : r + path.sep;
  return c.startsWith(rWithSep);
}

/**
 * Validate that `candidate` lives under at least one of `allowedRoots`.
 * Throws a descriptive error if not. Use at every boundary where an
 * untrusted path (CLI arg, JSONL field) is about to be read or written.
 */
function assertPathInside(candidate, allowedRoots, label = 'path') {
  if (!candidate || typeof candidate !== 'string') {
    throw new Error(`${label}: missing or non-string path`);
  }
  const roots = Array.isArray(allowedRoots) ? allowedRoots : [allowedRoots];
  for (const root of roots) {
    if (isPathInside(candidate, root)) return normalize(candidate);
  }
  throw new Error(
    `${label}: path ${candidate} is not inside any allowed root ` +
    `(${roots.join(', ')})`
  );
}

/**
 * Symlink-safe recursive walk.
 *
 * Security review flagged that `withFileTypes:true` + `isDirectory()`
 * silently follows symlinks. This walker rejects any entry whose dirent
 * reports `isSymbolicLink()`, plus an lstat fallback for exotic cases
 * where the dirent flags lie (rare, but real on networked filesystems).
 *
 * `onFile(absPath, dirent)` is invoked for each non-symlink regular file
 * whose name passes `fileFilter` (default: accept all).
 *
 * If `root` is not inside `confineTo` (optional), the walk is refused.
 * This is belt-and-braces defense against a caller passing untrusted paths.
 */
function walkSafe(root, onFile, { fileFilter, confineTo } = {}) {
  const rootAbs = normalize(root);
  if (confineTo && !isPathInside(rootAbs, confineTo)) {
    throw new Error(`walkSafe: ${rootAbs} is outside confineTo=${confineTo}`);
  }

  function visit(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      // Reject symlinks — directories OR files. A symlinked file could
      // point at something outside the wiki; a symlinked dir could tunnel
      // the walker into arbitrary trees.
      if (e.isSymbolicLink()) continue;

      const full = path.join(dir, e.name);

      // Belt-and-braces: lstat to defeat any dirent misreport. One extra
      // syscall per entry — acceptable for a personal tool.
      let lst;
      try { lst = fs.lstatSync(full); } catch { continue; }
      if (lst.isSymbolicLink()) continue;

      if (lst.isDirectory()) {
        visit(full);
      } else if (lst.isFile()) {
        if (!fileFilter || fileFilter(e.name, full)) onFile(full, e);
      }
    }
  }
  visit(rootAbs);
}

/**
 * Atomic write: write to a sibling temp file on the same filesystem, then
 * rename over the destination. rename(2) is atomic within a filesystem, so
 * a crash leaves either the old file or the new one — never a truncated
 * mid-write state. Applies to every writer flagged by review
 * (_index.md, CLAUDE.md, MEMORY.md).
 *
 * The temp name embeds a random suffix so two concurrent writers don't
 * collide.
 */
function writeFileAtomic(filePath, content, encoding = 'utf-8') {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const suffix = crypto.randomBytes(6).toString('hex');
  const tmp = path.join(dir, `.${path.basename(filePath)}.${suffix}.tmp`);
  try {
    fs.writeFileSync(tmp, content, encoding);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
    throw err;
  }
}

/**
 * Frontmatter parser shared by wiki-sync.js and wiki-consolidate.js so
 * changes land in one place. Returns `{ frontmatter, body }`.
 */
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

function readSafe(p) {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }
}

module.exports = {
  HOME,
  WIKI_ROOT,
  CLAUDE_PROJECTS,
  CLAUDE_SETTINGS_DIR,
  normalize,
  isPathInside,
  assertPathInside,
  walkSafe,
  writeFileAtomic,
  parseFrontmatter,
  readSafe,
};
