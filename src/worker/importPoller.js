const fs = require('fs');
const path = require('path');
const db = require('./db');
const { extractText } = require('./pipeline/extractText');
const { parseFileName } = require('./pipeline/groupKey');
const { matchTags } = require('./pipeline/tagMatcher');
const { upsertNoteForAttachment, sanitizeTitleForFileName } = require('./pipeline/noteWriter');
const { copyToAttachments, archiveOrDelete, moveToErrors } = require('./pipeline/fileMover');
const { generateGuid } = require('./pipeline/guid');
const { STATUS, SOURCE_TYPE, AUTO_GUID_TAG } = require('../shared/constants');

const SUPPORTED_EXTENSIONS = new Set([
  'txt', 'md', 'pdf', 'png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp', 'heic', 'heif',
]);

function cleanTitleFromGroupKey(groupKey) {
  return groupKey.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled';
}

async function listImportCandidates(importFolderPath) {
  let entries;
  try {
    entries = await fs.promises.readdir(importFolderPath, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .filter((name) => SUPPORTED_EXTENSIONS.has(path.extname(name).slice(1).toLowerCase()));
}

function groupFiles(fileNames) {
  const groups = new Map();
  for (const fileName of fileNames) {
    const parsed = parseFileName(fileName);
    if (!groups.has(parsed.groupKey)) groups.set(parsed.groupKey, []);
    groups.get(parsed.groupKey).push({ fileName, ...parsed });
  }
  for (const members of groups.values()) {
    members.sort((a, b) => (a.dupIndex ?? -1) - (b.dupIndex ?? -1));
  }
  return groups;
}

/**
 * Processes one file: extract text, match tags, write/append the note, copy the attachment
 * into the vault, archive or delete the source, and record the outcome in SQLite. Errors are
 * caught here (not thrown further) so one bad file doesn't abort the rest of the group/poll.
 */
async function processOneFile({ vault, fileName, groupKey, imageTypesEnabled, knownTags }) {
  const sourcePath = path.join(vault.import_folder_path, fileName);

  const existingDoc = db.findDocumentByPath(vault.id, sourcePath);
  // A previously-FAILED (400) file falls through to a real retry below instead of being
  // skipped forever, same as backfillScanner.js does for existing-vault attachments — a fix
  // that no longer applies (e.g. the ImageData polyfill in pdfExtractor.js) should actually
  // get picked up on the next poll rather than leaving the file stuck silently in the import
  // folder forever.
  if (existingDoc && existingDoc.status_code !== STATUS.PENDING && existingDoc.status_code !== STATUS.NOT_PROCESSED) {
    return { skipped: true };
  }
  const guid = existingDoc ? existingDoc.guid : generateGuid();
  const doc = existingDoc || db.insertPendingDocument({
    guid,
    vaultId: vault.id,
    sourceType: SOURCE_TYPE.IMPORT,
    originalFilename: fileName,
    originalPath: sourcePath,
    groupKey,
    dupIndex: parseFileName(fileName).dupIndex,
  });

  let stat;
  try {
    stat = await fs.promises.stat(sourcePath);
  } catch (err) {
    // File vanished between listing and processing (e.g. user moved it away) — nothing to do.
    return { skipped: true };
  }

  try {
    const { text, title: extractedTitle } = await extractText(sourcePath, imageTypesEnabled);
    const matchedTags = matchTags(text, knownTags);
    const noteTitle = extractedTitle || cleanTitleFromGroupKey(groupKey);

    const { embedFileName } = await copyToAttachments(vault.root_path, sourcePath, fileName, guid);
    const notePath = await upsertNoteForAttachment({
      vaultRootPath: vault.root_path,
      title: noteTitle,
      embedFileName,
      guid,
      originalFilename: fileName,
      matchedTags,
      extractedText: text,
    });

    const statusCode = text.length === 0
      ? STATUS.PROCESSED_NO_TEXT
      : (matchedTags.length > 0 ? STATUS.PROCESSED_TEXT_AND_TAGS : STATUS.PROCESSED_TEXT_FOUND);

    const { archivedPath } = await archiveOrDelete({
      sourceFilePath: sourcePath,
      originalFilename: fileName,
      guid,
      archiveFolderPath: vault.archive_folder_path,
      deleteAfterImport: !!vault.delete_after_import,
    });

    db.markDocumentProcessed(doc.id, {
      statusCode,
      extractedTextChars: text.length,
      notePath,
      archivedPath,
      fileSizeBytes: stat.size,
    });
    db.upsertTag(vault.id, AUTO_GUID_TAG);
    db.linkDocumentTags(doc.id, vault.id, [...matchedTags, AUTO_GUID_TAG]);

    return { skipped: false, statusCode };
  } catch (err) {
    await moveToErrors(vault.import_folder_path, sourcePath, fileName).catch((moveErr) => {
      // Left in place (not silently swallowed) so a file that fails to move into errors/
      // isn't left both unprocessed and undiagnosable — it'll be retried on the next poll
      // instead (see the status_code check above), but this makes the underlying cause visible.
      console.error(`[importPoller] failed to move ${fileName} to errors/:`, moveErr);
    });
    db.markDocumentProcessed(doc.id, {
      statusCode: STATUS.NOT_PROCESSED,
      errorMessage: String(err && err.message || err),
      fileSizeBytes: stat.size,
    });
    return { skipped: false, statusCode: STATUS.NOT_PROCESSED, error: err };
  }
}

async function processVaultImportFolder(vault, settings) {
  if (!vault.import_folder_path) return { processed: 0 }; // not configured yet (Setting #1 is a two-step pick)
  if (!vault.archive_folder_path && !vault.delete_after_import) return { processed: 0 }; // nowhere to put successfully-imported originals yet
  const fileNames = await listImportCandidates(vault.import_folder_path);
  if (fileNames.length === 0) return { processed: 0 };

  const groups = groupFiles(fileNames);
  const knownTags = db.listVaultTags(vault.id);
  let processedCount = 0;

  for (const [groupKey, members] of groups) {
    for (const member of members) {
      const result = await processOneFile({
        vault,
        fileName: member.fileName,
        groupKey,
        imageTypesEnabled: settings.imageTypesEnabled,
        knownTags,
      });
      if (!result.skipped) processedCount += 1;
    }
  }
  return { processed: processedCount };
}

async function pollAllVaults() {
  const settings = db.getSettings();
  const vaults = db.listEnabledVaults();
  const results = [];
  for (const vault of vaults) {
    const result = await processVaultImportFolder(vault, settings);
    results.push({ vaultId: vault.id, ...result });
  }
  return results;
}

module.exports = { pollAllVaults, processVaultImportFolder, listImportCandidates, groupFiles, cleanTitleFromGroupKey };
