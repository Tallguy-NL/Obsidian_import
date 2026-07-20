const fs = require('fs');
const path = require('path');
const { ERRORS_SUBFOLDER, GUID_FILENAME_SEPARATOR } = require('../../shared/constants');
const { resolveAttachmentFolder } = require('./obsidianConfig');

function guidSuffixedName(originalFilename, guid) {
  const ext = path.extname(originalFilename);
  const stem = path.basename(originalFilename, ext);
  return `${stem}${GUID_FILENAME_SEPARATOR}${guid}${ext}`;
}

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

/**
 * Copies the source file into the vault's configured attachment folder (per Obsidian's own
 * "Default location for new attachments" setting) under a GUID-suffixed name so it can be
 * embedded via Obsidian's ![[...]] syntax. Returns the embed filename (basename) and the full
 * destination path.
 */
async function copyToAttachments(vaultRootPath, sourceFilePath, originalFilename, guid) {
  const attachmentsDir = path.join(vaultRootPath, resolveAttachmentFolder(vaultRootPath));
  await ensureDir(attachmentsDir);
  const embedFileName = guidSuffixedName(originalFilename, guid);
  const destPath = path.join(attachmentsDir, embedFileName);
  await fs.promises.copyFile(sourceFilePath, destPath);
  return { embedFileName, destPath };
}

/**
 * Post-processing move for a successfully processed import-folder file: either deletes the
 * original (if the vault has "delete after import" set) or moves it into the Archive folder
 * with the GUID appended to its filename.
 */
async function archiveOrDelete({ sourceFilePath, originalFilename, guid, archiveFolderPath, deleteAfterImport }) {
  if (deleteAfterImport) {
    await fs.promises.unlink(sourceFilePath);
    return { archivedPath: null, deleted: true };
  }
  await ensureDir(archiveFolderPath);
  const archivedName = guidSuffixedName(originalFilename, guid);
  const destPath = path.join(archiveFolderPath, archivedName);
  await fs.promises.rename(sourceFilePath, destPath);
  return { archivedPath: destPath, deleted: false };
}

/**
 * Moves a file that failed processing into `${importFolderPath}/errors/`, creating that
 * subfolder if needed. Never deletes a failed file.
 */
async function moveToErrors(importFolderPath, sourceFilePath, originalFilename) {
  const errorsDir = path.join(importFolderPath, ERRORS_SUBFOLDER);
  await ensureDir(errorsDir);
  const destPath = path.join(errorsDir, originalFilename);
  await fs.promises.rename(sourceFilePath, destPath);
  return destPath;
}

module.exports = { copyToAttachments, archiveOrDelete, moveToErrors, guidSuffixedName };
