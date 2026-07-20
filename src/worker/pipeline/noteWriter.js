const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { nowUtcIso } = require('../../shared/time');
const { AUTO_GUID_TAG } = require('../../shared/constants');
const { resolveNewNoteFolder } = require('./obsidianConfig');

const ILLEGAL_FILENAME_CHARS_RE = /[\\/:*?"<>|]/g;
const HEADING_RE = /^#\s+(.+)$/m;
const EXTRACTED_TEXT_CALLOUT_HEADER = '> [!note]- Extracted text';

function sanitizeTitleForFileName(title) {
  return title.replace(ILLEGAL_FILENAME_CHARS_RE, '-').replace(/\s+/g, ' ').trim();
}

function mergeTags(existingTags, newTags) {
  const set = new Set((existingTags || []).map((t) => String(t).toLowerCase()));
  for (const t of newTags || []) set.add(t.toLowerCase());
  return [...set].sort();
}

// Renders extracted text as a collapsed Obsidian callout so it's indexed/searchable without
// dominating the note visually. Returns null when there's nothing worth attaching.
function formatExtractedTextCallout(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  const quoted = trimmed.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n');
  return `${EXTRACTED_TEXT_CALLOUT_HEADER}\n${quoted}`;
}

async function readNoteIfExists(notePath) {
  let raw;
  try {
    raw = await fs.promises.readFile(notePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    return matter(raw);
  } catch (err) {
    // Malformed frontmatter (e.g. an unescaped colon-heavy URL in a `source:` value) would
    // otherwise crash a new import that happens to land on this same filename. Treat it as a
    // foreign note with no parseable frontmatter — data.source won't be 'import', so callers
    // fall into the "different pre-existing note" append path instead of trying to merge into
    // frontmatter that couldn't be parsed in the first place.
    console.error(`[noteWriter] unparseable frontmatter, treating as foreign note: ${notePath}: ${err.message}`);
    return { data: {}, content: raw };
  }
}

// One embed + its (optional) extracted-text callout + its ID: line, kept together as a single
// blank-line-delimited block so re-parsing existing notes (splitting on blank lines) recovers
// each attachment's block intact instead of scattering embeds/callouts/ID lines into flat lists.
function buildAttachmentBlock({ embedLine, extractedText, idLine }) {
  const callout = formatExtractedTextCallout(extractedText);
  return [embedLine, callout, idLine].filter(Boolean).join('\n');
}

/**
 * Creates a note for a new import, or appends to it if a sibling [1]/[2]/[3] file already
 * created one earlier in the same (or a later) poll. If a file with the target name already
 * exists but wasn't created by this app (frontmatter.source !== 'import'), we don't touch its
 * body structure — we append a clearly-marked section instead, so a same-named pre-existing
 * user note is never silently rewritten.
 *
 * Returns the note's absolute path.
 */
async function upsertNoteForAttachment({ vaultRootPath, title, embedFileName, guid, originalFilename, matchedTags, extractedText }) {
  const fileName = `${sanitizeTitleForFileName(title)}.md`;
  // New notes land wherever Obsidian's own "Default location for new notes" setting
  // (.obsidian/app.json) says, so this follows the user's actual configured folder instead of
  // a guess baked into this app — including automatically if they ever repoint it.
  const noteFolder = resolveNewNoteFolder(vaultRootPath);
  const notePath = path.join(vaultRootPath, noteFolder, fileName);
  await fs.promises.mkdir(path.dirname(notePath), { recursive: true });
  const existing = await readNoteIfExists(notePath);

  const embedLine = `![[${embedFileName}]]`;
  const idLine = `ID: ${guid} ${originalFilename}`;
  const attachmentBlock = buildAttachmentBlock({ embedLine, extractedText, idLine });

  if (!existing) {
    const body = `# ${title}\n\n${attachmentBlock}\n`;
    const frontmatter = { tags: mergeTags([], [...(matchedTags || []), AUTO_GUID_TAG]), created: nowUtcIso(), source: 'import' };
    await fs.promises.writeFile(notePath, matter.stringify(body, frontmatter), 'utf8');
    return notePath;
  }

  const isOurs = existing.data?.source === 'import';
  if (isOurs) {
    // Recover each previously-written attachment block whole (embed + optional callout + ID
    // line together) by splitting on blank lines, rather than re-extracting flat embed/ID
    // lists — that would silently drop any extracted-text callouts sitting between them.
    const existingTitle = existing.content.match(HEADING_RE)?.[1]?.trim() || title;
    const existingBlocks = existing.content
      .split(/\n{2,}/)
      .map((b) => b.trim())
      .filter((b) => b && !HEADING_RE.test(b));
    existingBlocks.push(attachmentBlock);
    const body = `# ${existingTitle}\n\n${existingBlocks.join('\n\n')}\n`;
    const frontmatter = {
      ...existing.data,
      tags: mergeTags(existing.data.tags, [...(matchedTags || []), AUTO_GUID_TAG]),
    };
    await fs.promises.writeFile(notePath, matter.stringify(body, frontmatter), 'utf8');
    return notePath;
  }

  // A different, pre-existing note happens to have the same title — append without
  // disturbing its existing content or structure.
  const appendedBody = `${existing.content.trimEnd()}\n\n## Imported attachment\n${attachmentBlock}\n`;
  const frontmatter = { ...existing.data, tags: mergeTags(existing.data.tags, [...(matchedTags || []), AUTO_GUID_TAG]) };
  await fs.promises.writeFile(notePath, matter.stringify(appendedBody, frontmatter), 'utf8');
  return notePath;
}

const IMPORT_IDS_HEADING = '## Import IDs';

/**
 * Backfill path: the note already exists (it's a pre-existing user note with an embedded
 * attachment that predates this app) and already has its own structure we must not disturb.
 * We only add a GUID/ID: line (+ its extracted-text callout) for the newly-processed
 * attachment — under a trailing "## Import IDs" section, creating that section on first use and
 * appending subsequent entries under the same heading rather than duplicating it — plus merge
 * in any newly matched tags.
 */
async function appendIdLineForExistingAttachment({ notePath, guid, originalFilename, matchedTags, extractedText }) {
  const existing = await readNoteIfExists(notePath);
  if (!existing) throw new Error(`Note not found: ${notePath}`);

  const idLine = `ID: ${guid} ${originalFilename}`;
  const callout = formatExtractedTextCallout(extractedText);
  const entry = callout ? `${idLine}\n${callout}` : idLine;

  let body = existing.content.trimEnd();
  if (body.includes(IMPORT_IDS_HEADING)) {
    body = `${body}\n${entry}\n`;
  } else {
    body = `${body}\n\n${IMPORT_IDS_HEADING}\n${entry}\n`;
  }
  const frontmatter = { ...existing.data, tags: mergeTags(existing.data.tags, [...(matchedTags || []), AUTO_GUID_TAG]) };
  await fs.promises.writeFile(notePath, matter.stringify(body, frontmatter), 'utf8');
  return notePath;
}

/**
 * One-off retroactive repair: a document that was already fully processed before extracted
 * text was persisted to notes has an `ID: <guid> <filename>` line but no callout after it.
 * Finds that exact line and inserts the callout right after it, in place — idempotent (skips
 * notes that already have a callout there) and doesn't touch anything else in the note. Also
 * makes sure the AUTO_GUID_TAG marker is present, for notes written before that existed either.
 */
async function insertExtractedTextForExistingIdLine({ notePath, guid, originalFilename, extractedText, matchedTags }) {
  const existing = await readNoteIfExists(notePath);
  if (!existing) throw new Error(`Note not found: ${notePath}`);

  const idLine = `ID: ${guid} ${originalFilename}`;
  const marker = `${idLine}\n`;
  const idx = existing.content.indexOf(marker);

  let newContent = existing.content;
  if (idx !== -1) {
    const insertAt = idx + marker.length;
    const rest = existing.content.slice(insertAt);
    const alreadyHasCallout = rest.startsWith(EXTRACTED_TEXT_CALLOUT_HEADER);
    const callout = formatExtractedTextCallout(extractedText);
    if (callout && !alreadyHasCallout) {
      newContent = existing.content.slice(0, insertAt) + callout + '\n' + rest;
    }
  }

  const tags = mergeTags(existing.data.tags, [...(matchedTags || []), AUTO_GUID_TAG]);
  const tagsChanged = tags.length !== (existing.data.tags || []).length
    || tags.some((t, i) => t !== (existing.data.tags || [])[i]);
  if (newContent === existing.content && !tagsChanged) return { notePath, changed: false };

  const frontmatter = { ...existing.data, tags };
  await fs.promises.writeFile(notePath, matter.stringify(newContent, frontmatter), 'utf8');
  return { notePath, changed: true };
}

module.exports = {
  upsertNoteForAttachment,
  appendIdLineForExistingAttachment,
  insertExtractedTextForExistingIdLine,
  sanitizeTitleForFileName,
  mergeTags,
  formatExtractedTextCallout,
};
