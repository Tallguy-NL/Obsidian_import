const { app } = require('electron');
const { createMainWindow, getMainWindow } = require('./windowManager');
const { createTray, refreshMenu } = require('./tray');
const { WorkerBridge } = require('./workerBridge');
const { registerIpcHandlers } = require('./ipcHandlers');
const { IPC } = require('../shared/ipcChannels');

app.isQuitting = false;

// Keep running with the window closed on every platform. Electron's default
// window-all-closed handler quits the app on Windows (but not macOS) — since the
// whole point of this app is a background worker that outlives the window, that
// default must be overridden explicitly rather than relying on mac's behavior,
// which would otherwise mask the bug in day-to-day dev on this machine.
app.on('window-all-closed', () => {
  // intentionally not quitting
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

app.whenReady().then(() => {
  const workerBridge = new WorkerBridge();
  workerBridge.start();

  workerBridge.onEvent((message) => {
    if (message?.type === 'documentProcessed' || message?.type === 'statsChanged') {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.WORKER_EVENT, message);
      }
    }
  });

  registerIpcHandlers(workerBridge);
  createTray(workerBridge);
  createMainWindow();

  app.on('activate', () => {
    createMainWindow();
  });

  app.on('before-quit', () => {
    workerBridge.shutdown();
  });

  // Keep the tray's pause/resume label in sync if settings changed via the Settings UI.
  workerBridge.onEvent((message) => {
    if (message?.type === 'settings-changed' || message?.type === 'statsChanged') {
      refreshMenu(workerBridge);
    }
  });
});
