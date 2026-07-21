const fs = require('fs');
const { ipcMain, dialog } = require('electron');
const { IPC } = require('../shared/ipcChannels');
const db = require('./db');
const { getMainWindow } = require('./windowManager');
const { refreshMenu } = require('./tray');

function registerIpcHandlers(workerBridge) {
  ipcMain.handle(IPC.PICK_FOLDER, async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(IPC.LIST_SUBFOLDERS, async (_event, parentPath) => {
    try {
      const entries = await fs.promises.readdir(parentPath, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle(IPC.GET_VAULTS, () => db.listVaults());

  ipcMain.handle(IPC.SAVE_VAULT, (_event, config) => {
    const vault = db.saveVault(config);
    workerBridge.postMessage({ type: 'settings-changed' });
    return vault;
  });

  ipcMain.handle(IPC.REMOVE_VAULT, (_event, id) => {
    db.removeVault(id);
    workerBridge.postMessage({ type: 'settings-changed' });
    return true;
  });

  ipcMain.handle(IPC.RUN_ANALYZE_VAULT, (_event, vaultId) => {
    workerBridge.postMessage({ type: 'analyze-vault', vaultId });
    return true;
  });

  ipcMain.handle(IPC.GET_SETTINGS, () => db.getSettings());

  ipcMain.handle(IPC.UPDATE_SETTINGS, (_event, partial) => {
    const settings = db.updateSettings(partial);
    workerBridge.postMessage({ type: 'settings-changed' });
    return settings;
  });

  ipcMain.handle(IPC.GET_STATS, () => db.getStats());

  ipcMain.handle(IPC.GET_PROCESSING_STATUS, () => workerBridge.getProcessingStatus());

  ipcMain.handle(IPC.SET_PAUSED, (_event, paused) => {
    const settings = db.updateSettings({ workerPaused: !!paused });
    workerBridge.postMessage({ type: 'settings-changed' });
    return settings;
  });

  // --- Database export / import ---------------------------------------------------------

  ipcMain.handle(IPC.PICK_EXPORT_DEST, async () => {
    const defaultName = `obsidian-importer-backup-${new Date().toISOString().slice(0, 10)}.db`;
    const result = await dialog.showSaveDialog(getMainWindow(), {
      defaultPath: defaultName,
      filters: [{ name: 'Database', extensions: ['db'] }],
    });
    if (result.canceled || !result.filePath) return null;
    return result.filePath;
  });

  ipcMain.handle(IPC.PICK_IMPORT_FILE, async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openFile'],
      filters: [{ name: 'Database', extensions: ['db'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(IPC.EXPORT_DB, async (_event, destPath) => {
    await db.exportDatabase(destPath);
    return true;
  });

  ipcMain.handle(IPC.ANALYZE_IMPORT_DB, (_event, filePath) => db.analyzeImportFile(filePath));

  ipcMain.handle(IPC.APPLY_IMPORT_DB, async (_event, { filePath, resolutions }) => {
    // The worker holds its own DB connection and in-memory backlog caches — both would be
    // left pointing at a file that no longer exists (or has completely different content)
    // once app.db is swapped out from under it, so it's stopped for the swap and restarted
    // fresh against the imported data afterwards (also if the import itself throws, so the
    // app doesn't end up with a permanently-stopped worker).
    workerBridge.shutdown();
    try {
      return await db.applyImport(filePath, resolutions);
    } finally {
      workerBridge.restart();
      refreshMenu(workerBridge);
    }
  });
}

module.exports = { registerIpcHandlers };
