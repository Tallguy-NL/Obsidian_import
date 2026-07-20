// Single source of truth for IPC channel names, shared by preload.js and ipcHandlers.js.
const IPC = Object.freeze({
  // Folder pickers / filesystem
  PICK_FOLDER: 'fs:pickFolder',
  LIST_SUBFOLDERS: 'fs:listSubfolders',

  // Vaults
  GET_VAULTS: 'vaults:get',
  SAVE_VAULT: 'vaults:save',
  REMOVE_VAULT: 'vaults:remove',
  RUN_ANALYZE_VAULT: 'vaults:runAnalyze',

  // Settings
  GET_SETTINGS: 'settings:get',
  UPDATE_SETTINGS: 'settings:update',

  // Stats / worker control
  GET_STATS: 'stats:get',
  SET_PAUSED: 'worker:setPaused',

  // Database export / import (migrating to a new machine)
  PICK_EXPORT_DEST: 'db:pickExportDest',
  PICK_IMPORT_FILE: 'db:pickImportFile',
  EXPORT_DB: 'db:export',
  ANALYZE_IMPORT_DB: 'db:analyzeImport',
  APPLY_IMPORT_DB: 'db:applyImport',

  // Push events, main -> renderer
  WORKER_EVENT: 'worker:event',
});

module.exports = { IPC };
