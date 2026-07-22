const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const db = require('./db');
const { withTimeout } = require('./pipeline/withTimeout');
const { FILE_IO_TIMEOUT_MS } = require('../shared/constants');

const SKIP_DIRS = new Set(['.obsidian', '.git', '.trash', 'node_modules']);
// Matches Obsidian inline tags (#tag, #nested/tag, #tag_with-dashes); requires a letter right
// after '#' so it doesn't match markdown headings ("# Title") or bare numbers/anchors. Also
// excludes '#' preceded by a word character or '(' so URL fragments (page#section) and
// markdown link targets ([text](#anchor)) in web-clipped notes aren't picked up as tags.
const INLINE_TAG_RE = /(?<![\w(])#([A-Za-z][A-Za-z0-9_/-]*)/g;

async function walkFiles(rootPath, predicate) {
  const results = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && predicate(entry.name)) {
        results.push(fullPath);
      }
    }
  }
  await walk(rootPath);
  return results;
}

function walkAllFiles(rootPath) {
  return walkFiles(rootPath, () => true);
}

async function walkMarkdownFiles(rootPath) {
  const results = await walkFiles(rootPath, (name) => name.toLowerCase().endsWith('.md'));
  return results;
}

function collectTagsFromNote(rawContent) {
  const tags = new Set();
  let frontmatter = {};
  let body = rawContent;
  try {
    const parsed = matter(rawContent);
    frontmatter = parsed.data || {};
    body = parsed.content || '';
  } catch {
    // Malformed frontmatter — fall back to scanning the raw content for inline tags only.
  }

  const fmTags = frontmatter.tags;
  if (Array.isArray(fmTags)) {
    for (const t of fmTags) if (typeof t === 'string') tags.add(t.trim());
  } else if (typeof fmTags === 'string') {
    for (const t of fmTags.split(',')) tags.add(t.trim());
  }

  for (const match of body.matchAll(INLINE_TAG_RE)) {
    tags.add(match[1]);
  }

  return [...tags].map((t) => t.trim().toLowerCase()).filter(Boolean);
}

/**
 * Scans every existing note in a vault for tags already in use (YAML frontmatter `tags:`
 * plus inline `#tags`) and refreshes the vault's known-tag vocabulary in SQLite. This is the
 * fast, note-only pass behind Settings §2 "analyze vault" and the tag source for auto-tagging
 * new documents. Heavier per-document work (OCR'ing attachments, inserting ID: lines into
 * notes that don't have one yet) is handled separately by backfillScanner.js.
 */
async function analyzeVaultTags(vaultId) {
  const vault = db.getVault(vaultId);
  if (!vault) return { tagCount: 0 };

  const noteFiles = await walkMarkdownFiles(vault.root_path);
  const allTags = new Set();
  for (const filePath of noteFiles) {
    // Raced against a deadline (see FILE_IO_TIMEOUT_MS) — a note stuck on a sync drive would
    // otherwise wedge this whole tag scan on one file instead of just skipping it.
    const readPromise = fs.promises.readFile(filePath, 'utf8');
    readPromise.catch(() => {});
    const raw = await withTimeout(readPromise, FILE_IO_TIMEOUT_MS, `analyzeVaultTags read ${filePath}`).catch(() => '');
    if (!raw) continue;
    for (const tag of collectTagsFromNote(raw)) allTags.add(tag);
  }

  db.replaceVaultTags(vaultId, allTags);
  db.touchVaultAnalyzed(vaultId);
  return { tagCount: allTags.size, noteCount: noteFiles.length };
}

module.exports = { analyzeVaultTags, collectTagsFromNote, walkMarkdownFiles, walkAllFiles };
