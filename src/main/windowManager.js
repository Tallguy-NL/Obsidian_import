const path = require('path');
const { BrowserWindow } = require('electron');

let mainWindow = null;

function createMainWindow() {
  if (mainWindow) {
    showMainWindow();
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    title: 'Obsidian Importer',
    backgroundColor: '#EFE3D1',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox:false so the preload script can require() local project files (../shared/*)
      // via plain CommonJS; contextIsolation:true is what actually matters for keeping the
      // preload's Node access out of the page's window object.
      sandbox: false,
    },
  });

  const startPage = process.env.START_PAGE || 'index.html';
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', startPage));

  // Forward renderer console output to the main process's stdout — useful in dev since
  // there's no separate devtools window to watch when driving this headlessly.
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });

  // Tray/menu-bar resident app: closing the window just hides it — the background
  // worker (a separate utilityProcess) keeps running. Only the tray's explicit
  // "Quit" (which sets app.isQuitting) actually tears the window down.
  mainWindow.on('close', (event) => {
    const { app } = require('electron');
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

function showMainWindow() {
  if (!mainWindow) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function getMainWindow() {
  return mainWindow;
}

module.exports = { createMainWindow, showMainWindow, getMainWindow };
