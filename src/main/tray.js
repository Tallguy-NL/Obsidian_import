const path = require('path');
const { Tray, Menu, nativeImage, app } = require('electron');
const { showMainWindow } = require('./windowManager');
const db = require('./db');

let tray = null;

function trayIconPath() {
  if (process.platform === 'darwin') {
    return path.join(__dirname, '..', '..', 'resources', 'icons', 'trayTemplate.png');
  }
  return path.join(__dirname, '..', '..', 'resources', 'icons', 'tray.png');
}

function createTray(workerBridge) {
  const icon = nativeImage.createFromPath(trayIconPath());
  if (process.platform === 'darwin') icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip('Obsidian Importer');
  refreshMenu(workerBridge);
  tray.on('click', showMainWindow);
  return tray;
}

function refreshMenu(workerBridge) {
  if (!tray) return;
  const { workerPaused } = db.getSettings();
  const menu = Menu.buildFromTemplate([
    { label: 'Show Obsidian Importer', click: showMainWindow },
    { type: 'separator' },
    {
      label: workerPaused ? 'Resume background processing' : 'Pause background processing',
      click: () => {
        const settings = db.updateSettings({ workerPaused: !workerPaused });
        workerBridge.postMessage({ type: 'settings-changed' });
        refreshMenu(workerBridge);
        void settings;
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

module.exports = { createTray, refreshMenu };
