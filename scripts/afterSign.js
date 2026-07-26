const { execFileSync } = require('child_process');
const path = require('path');

// electron-builder can't drive ad-hoc signing itself when the keychain holds other
// (non-code-signing) identities — it just skips signing and leaves Electron's original
// placeholder binary signature in place, which macOS/Gatekeeper now rejects outright.
// Re-sign the fully packaged bundle here, ad-hoc, before electron-builder builds the DMG/zip.
module.exports = async function afterSign(context) {
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  execFileSync('codesign', [
    '--force',
    '--deep',
    '--sign', '-',
    appPath,
  ], { stdio: 'inherit' });
};
