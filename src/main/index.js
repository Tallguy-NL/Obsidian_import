const { app, powerSaveBlocker } = require('electron');
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
  // This is a tray-resident background importer with no window open most of the time — exactly
  // the profile macOS (and, independently, Chromium's own backgrounded-process scheduling)
  // deprioritizes once it's not the focused/frontmost app: both the main process and the worker
  // utilityProcess were directly observed running at a reduced OS scheduling priority (`nice 5`,
  // via `ps`) while the app sat fully idle mid-tick for 12+ minutes — well past every in-process
  // timeout and even past this app's own 10-minute worker-restart watchdog, because that
  // watchdog's own setInterval lives in this same deprioritized main process and was starved
  // right along with everything else. No in-process fix can compensate for the OS declining to
  // schedule the process at all; this is the one thing that addresses that directly, by holding
  // a system assertion that tells macOS not to nap this app while it's running.
  powerSaveBlocker.start('prevent-app-suspension');

  const workerBridge = new WorkerBridge();
  workerBridge.start();

  workerBridge.onEvent((message) => {
    if (
      message?.type === 'documentProcessed'
      || message?.type === 'statsChanged'
      || message?.type === 'processingStatusChanged'
    ) {
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
