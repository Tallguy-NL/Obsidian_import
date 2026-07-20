const path = require('path');
const os = require('os');

// Mirrors Electron's app.getPath('userData') resolution for the current platform, for use in
// contexts without access to the `electron` app module (the worker utilityProcess, and OCR/DB
// code shared by both main and worker). Must match app.getName() — 'obsidian-importer', taken
// from package.json's "name" field, which Electron uses as the default app name.
function resolveUserDataPath() {
  const appName = 'obsidian-importer';
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', appName);
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), appName);
  }
  return path.join(os.homedir(), '.config', appName);
}

module.exports = { resolveUserDataPath };
