const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const db = require('./db');
const { walkMarkdownFiles, walkAllFiles } = require('./vaultAnalyzer');
const { extractText } = require('./pipeline/extractText');
const { matchTags } = require('./pipeline/tagMatcher');
const { appendIdLineForExistingAttachment } = require('./pipeline/noteWriter');
const { generateGuid } = require('./pipeline/guid');
const { STATUS, SOURCE_TYPE, GUID_FILENAME_SEPARATOR, AUTO_GUID_TAG } = require('../shared/constants');

// Captures the filename part of ![[name]], ![[name|alias]], ![[name#heading]] embeds.
const EMBED_LINE_RE = /!\[\[([^\]|#]+)/g;
// Captures the guid and filename from each existing `ID: <guid> <filename>` line.
const ID_LINE_RE = /^ID: ([0-9a-f-]{36}) (.+)$/gm;
const GUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// Attachments this app creates are named "OriginalName__<guid>.ext" (fileMover/copyToAttachments);
// the note's ID: line records the *original* filename, not this embed name, so matching an
// embed against "already has an ID: line" must go through the guid, not a filename string.
const EMBED_GUID_SUFFIX_RE = new RegExp(`${GUID_FILENAME_SEPARATOR}(${GUID_RE})(?:\\.[^.]+)?$`, 'i');

function extractEmbeddedFileNames(body) {
  const names = new Set();
  for (const m of body.matchAll(EMBED_LINE_RE)) names.add(m[1].trim());
  return names;
}

function extractIdLineInfo(body) {
  const guids = new Set();
  const fileNames = new Set();
  for (const m of body.matchAll(ID_LINE_RE)) {
    guids.add(m[1].toLowerCase());
    fileNames.add(m[2].trim());
  }
  return { guids, fileNames };
}

function guidFromEmbedFileName(embedFileName) {
  const m = embedFileName.match(EMBED_GUID_SUFFIX_RE);
  return m ? m[1].toLowerCase() : null;
}

async function buildAttachmentIndex(vaultRootPath) {
  const allFiles = await walkAllFiles(vaultRootPath);
  const index = new Map();
  for (const filePath of allFiles) {
    const base = path.basename(filePath);
    if (!index.has(base)) index.set(base, filePath);
  }
  return index;
}

async function fileExists(filePath) {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Some vaults (e.g. Evernote exports) embed attachments via a relative path into a per-note
// resources folder — `![[./_resources/Some Note.resources/unknown_filename.3.jpeg]]` — rather
// than a bare filename. `attachmentIndex` is keyed by basename only, so a relative-path embed
// name never matches it directly (looks unresolvable even though the file is right there), and
// these exporters commonly reuse generic basenames (e.g. "unknown_filename.png") across many
// different notes' resource folders, so falling back to the basename index for a path-shaped
// embed would risk silently resolving to a *different* note's attachment. A path-shaped embed
// is therefore resolved relative to the note itself, and only a bare-filename embed uses the
// vault-wide basename index.
async function resolveEmbedPath(notePath, embedName, attachmentIndex) {
  if (embedName.includes('/')) {
    const relPath = path.resolve(path.dirname(notePath), embedName);
    return (await fileExists(relPath)) ? relPath : null;
  }
  return attachmentIndex.get(embedName) || null;
}

/**
 * Finds attachments embedded in existing notes that don't yet have a corresponding `ID:` line
 * — files added to the vault outside this app (or before it existed) that still need text
 * extraction and tagging. Sorted by note path so repeated calls make steady, stable progress.
 */
async function findBacklog(vault) {
  const noteFiles = (await walkMarkdownFiles(vault.root_path)).sort();
  const attachmentIndex = await buildAttachmentIndex(vault.root_path);
  const backlog = [];

  for (const notePath of noteFiles) {
    const raw = await fs.promises.readFile(notePath, 'utf8').catch(() => null);
    if (!raw) continue;
    let parsed;
    try {
      parsed = matter(raw);
    } catch (err) {
      // Malformed frontmatter (e.g. an unescaped colon-heavy URL in a `source:` value from an
      // Evernote-style export) would otherwise throw here and, uncaught, take down the whole
      // scan — killing getStats() for every vault and wedging the worker's tick loop on this
      // one file forever. Skip just this note instead; vaultAnalyzer.js's tag scan already
      // treats malformed frontmatter the same way.
      console.error(`[findBacklog] skipping note with unparseable frontmatter: ${notePath}: ${err.message}`);
      continue;
    }
    const embedded = extractEmbeddedFileNames(parsed.content);
    if (embedded.size === 0) continue;
    const { guids: idGuids, fileNames: idFileNames } = extractIdLineInfo(parsed.content);

    for (const embedName of embedded) {
      // Our own GUID-suffixed attachments: matched via the guid embedded in their filename,
      // since the ID: line records the original filename, not this one. Anything else
      // (a plain, non-suffixed embed a user added directly) is matched by filename.
      const embedGuid = guidFromEmbedFileName(embedName);
      const alreadyTracked = embedGuid ? idGuids.has(embedGuid) : idFileNames.has(embedName);
      if (alreadyTracked) continue;
      const resolvedPath = await resolveEmbedPath(notePath, embedName, attachmentIndex);
      if (!resolvedPath) continue; // broken/unresolvable link — nothing to extract from
      backlog.push({ notePath, embedFileName: embedName, resolvedPath });
    }
  }
  return backlog;
}

/**
 * Processes exactly one backlog item end-to-end (extract -> tag-match -> insert ID: line ->
 * record in SQLite). No file move — the attachment already lives in the vault. Callers are
 * responsible for only ever processing one item at a time, never in parallel, per the spec's
 * "start and finish processing one for one" requirement for existing documents.
 */
async function processBacklogItem(vault, item, settings) {
  let stat;
  try {
    stat = await fs.promises.stat(item.resolvedPath);
  } catch {
    return { skipped: true };
  }

  const doc = db.insertPendingDocument({
    guid: generateGuid(),
    vaultId: vault.id,
    sourceType: SOURCE_TYPE.EXISTING,
    originalFilename: item.embedFileName,
    originalPath: item.resolvedPath,
    groupKey: path.basename(item.embedFileName, path.extname(item.embedFileName)),
    dupIndex: null,
  });

  if (doc.status_code !== STATUS.PENDING && doc.status_code !== STATUS.NOT_PROCESSED) {
    // A previously-FAILED (400) document falls through to the real extraction branch below
    // instead, so it actually gets retried (e.g. after a fix like extractText no longer
    // throwing on unsupported types) rather than being permanently stuck at 400 forever.
    // The same physical file is embedded in another note and was already processed there —
    // reuse its GUID/tags and just add the missing ID: line to *this* note, rather than
    // re-matching tags (and rather than leaving this note stuck in the backlog forever). Text
    // is cheap to re-extract (nothing else needs it) so this note still gets its own callout.
    const matchedTags = db.getDocumentTagNames(doc.id);
    const { text } = await extractText(item.resolvedPath, settings.imageTypesEnabled).catch(() => ({ text: '' }));
    await appendIdLineForExistingAttachment({
      notePath: item.notePath,
      guid: doc.guid,
      originalFilename: item.embedFileName,
      matchedTags,
      extractedText: text,
    });
    return { skipped: true, alreadyProcessedElsewhere: true };
  }

  const knownTags = db.listVaultTags(vault.id);
  try {
    const { text } = await extractText(item.resolvedPath, settings.imageTypesEnabled);
    const matchedTags = matchTags(text, knownTags);

    await appendIdLineForExistingAttachment({
      notePath: item.notePath,
      guid: doc.guid,
      originalFilename: item.embedFileName,
      matchedTags,
      extractedText: text,
    });

    const statusCode = text.length === 0
      ? STATUS.PROCESSED_NO_TEXT
      : (matchedTags.length > 0 ? STATUS.PROCESSED_TEXT_AND_TAGS : STATUS.PROCESSED_TEXT_FOUND);

    db.markDocumentProcessed(doc.id, {
      statusCode,
      extractedTextChars: text.length,
      notePath: item.notePath,
      fileSizeBytes: stat.size,
    });
    db.upsertTag(vault.id, AUTO_GUID_TAG);
    db.linkDocumentTags(doc.id, vault.id, [...matchedTags, AUTO_GUID_TAG]);
    return { skipped: false, statusCode };
  } catch (err) {
    db.markDocumentProcessed(doc.id, {
      statusCode: STATUS.NOT_PROCESSED,
      errorMessage: String(err && err.message || err),
      fileSizeBytes: stat.size,
    });
    return { skipped: false, statusCode: STATUS.NOT_PROCESSED, error: err };
  }
}

/**
 * Processes at most one pending backlog item for a vault — the shape the Phase 5 tick loop
 * calls every tick, guaranteeing steady forward progress without ever bulk-processing.
 */
async function processNextBacklogItem(vault, settings) {
  const backlog = await findBacklog(vault);
  if (backlog.length === 0) return { processed: false };
  const result = await processBacklogItem(vault, backlog[0], settings);
  return { processed: !result.skipped, ...result };
}

/**
 * Convenience for Settings §2 "analyze now" / manual testing: drains the entire backlog for a
 * vault, still strictly one document at a time (never in parallel). Re-scans the backlog after
 * each item rather than iterating a stale list, since a finished item changes what still
 * counts as backlog.
 */
async function runBackfillForVault(vault, settings) {
  let processedCount = 0;
  for (let i = 0; i < 10_000; i += 1) {
    const backlog = await findBacklog(vault);
    if (backlog.length === 0) break;
    const result = await processBacklogItem(vault, backlog[0], settings);
    if (result.skipped && !result.alreadyProcessedElsewhere) break; // stuck (e.g. stat failure) — no progress possible
    if (!result.skipped) processedCount += 1; // "already processed elsewhere" still shrinks the backlog, just isn't a new extraction
  }
  return { processed: processedCount };
}

module.exports = { findBacklog, processBacklogItem, processNextBacklogItem, runBackfillForVault };
