const fs = require('fs');
const path = require('path');
const { withTimeout } = require('./withTimeout');
const { FILE_IO_TIMEOUT_MS } = require('../../shared/constants');

const DEFAULT_ATTACHMENT_FOLDER = 'attachments';

/**
 * Reads the vault's own `.obsidian/app.json` so this app follows the user's actual Obsidian
 * settings (Settings > Files & Links) instead of a hardcoded guess. Missing file/keys/parse
 * errors all fall back to {} — callers apply their own defaults on top of that.
 * Raced against a deadline like every other fs call in the pipeline: this file lives inside the
 * vault itself, so on a sync drive (iCloud Drive/OneDrive) reading it can block indefinitely —
 * and, unlike the async fs calls a plain read() timeout can race, a synchronous readFileSync
 * here would freeze the whole event loop with no way for any timeout to ever preempt it.
 */
async function readObsidianAppConfig(vaultRootPath) {
  const configPath = path.join(vaultRootPath, '.obsidian', 'app.json');
  try {
    const readPromise = fs.promises.readFile(configPath, 'utf8');
    readPromise.catch(() => {});
    const raw = await withTimeout(readPromise, FILE_IO_TIMEOUT_MS, `readObsidianAppConfig ${configPath}`);
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Mirrors Obsidian's "Default location for new notes" setting. Only the "folder" mode (a
 * fixed configured subfolder) is meaningful for a headless background process — "current"
 * means "next to the active pane's file", which doesn't exist here, so that (and "root", and
 * an absent/unrecognized value) all resolve to the vault root.
 */
async function resolveNewNoteFolder(vaultRootPath) {
  const cfg = await readObsidianAppConfig(vaultRootPath);
  if (cfg.newFileLocation === 'folder' && cfg.newFileFolderPath) {
    return cfg.newFileFolderPath;
  }
  return '';
}

/**
 * Mirrors Obsidian's "Default location for new attachments" setting (fixed-folder form only —
 * the `./relative` and `${notename}`-templated forms Obsidian also supports aren't handled).
 */
async function resolveAttachmentFolder(vaultRootPath) {
  const cfg = await readObsidianAppConfig(vaultRootPath);
  return cfg.attachmentFolderPath || DEFAULT_ATTACHMENT_FOLDER;
}

module.exports = { readObsidianAppConfig, resolveNewNoteFolder, resolveAttachmentFolder };
