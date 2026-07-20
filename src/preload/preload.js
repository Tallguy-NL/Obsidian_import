const { contextBridge, ipcRenderer } = require('electron');
const { IPC } = require('../shared/ipcChannels');

contextBridge.exposeInMainWorld('api', {
  pickFolder: () => ipcRenderer.invoke(IPC.PICK_FOLDER),
  listSubfolders: (parentPath) => ipcRenderer.invoke(IPC.LIST_SUBFOLDERS, parentPath),

  getVaults: () => ipcRenderer.invoke(IPC.GET_VAULTS),
  saveVaultConfig: (config) => ipcRenderer.invoke(IPC.SAVE_VAULT, config),
  removeVault: (id) => ipcRenderer.invoke(IPC.REMOVE_VAULT, id),
  runAnalyzeVault: (vaultId) => ipcRenderer.invoke(IPC.RUN_ANALYZE_VAULT, vaultId),

  getSettings: () => ipcRenderer.invoke(IPC.GET_SETTINGS),
  updateSettings: (partial) => ipcRenderer.invoke(IPC.UPDATE_SETTINGS, partial),

  getStats: () => ipcRenderer.invoke(IPC.GET_STATS),
  setPaused: (paused) => ipcRenderer.invoke(IPC.SET_PAUSED, paused),

  pickExportDestination: () => ipcRenderer.invoke(IPC.PICK_EXPORT_DEST),
  pickImportFile: () => ipcRenderer.invoke(IPC.PICK_IMPORT_FILE),
  exportDatabase: (destPath) => ipcRenderer.invoke(IPC.EXPORT_DB, destPath),
  analyzeImportDatabase: (filePath) => ipcRenderer.invoke(IPC.ANALYZE_IMPORT_DB, filePath),
  applyImportDatabase: (filePath, resolutions) =>
    ipcRenderer.invoke(IPC.APPLY_IMPORT_DB, { filePath, resolutions }),

  onWorkerEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(IPC.WORKER_EVENT, handler);
    return () => ipcRenderer.removeListener(IPC.WORKER_EVENT, handler);
  },
});
