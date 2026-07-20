const fs = require('fs');
const path = require('path');

const DEFAULT_ATTACHMENT_FOLDER = 'attachments';

/**
 * Reads the vault's own `.obsidian/app.json` so this app follows the user's actual Obsidian
 * settings (Settings > Files & Links) instead of a hardcoded guess. Missing file/keys/parse
 * errors all fall back to {} — callers apply their own defaults on top of that.
 */
function readObsidianAppConfig(vaultRootPath) {
  const configPath = path.join(vaultRootPath, '.obsidian', 'app.json');
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
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
function resolveNewNoteFolder(vaultRootPath) {
  const cfg = readObsidianAppConfig(vaultRootPath);
  if (cfg.newFileLocation === 'folder' && cfg.newFileFolderPath) {
    return cfg.newFileFolderPath;
  }
  return '';
}

/**
 * Mirrors Obsidian's "Default location for new attachments" setting (fixed-folder form only —
 * the `./relative` and `${notename}`-templated forms Obsidian also supports aren't handled).
 */
function resolveAttachmentFolder(vaultRootPath) {
  const cfg = readObsidianAppConfig(vaultRootPath);
  return cfg.attachmentFolderPath || DEFAULT_ATTACHMENT_FOLDER;
}

module.exports = { readObsidianAppConfig, resolveNewNoteFolder, resolveAttachmentFolder };
