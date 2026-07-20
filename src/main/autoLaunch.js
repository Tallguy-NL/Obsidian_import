const { app } = require('electron');

/**
 * Cross-platform login-item registration via Electron's built-in API (covers a macOS
 * Login Item and, via Squirrel, a Windows startup entry) — no extra npm package needed.
 */
function setAutoLaunch(enabled) {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true,
  });
}

function isAutoLaunchEnabled() {
  return app.getLoginItemSettings().openAtLogin;
}

module.exports = { setAutoLaunch, isAutoLaunchEnabled };
