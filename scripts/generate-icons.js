// One-off placeholder icon generator, run manually via `node scripts/generate-icons.js`.
// Produces simple purple-circle PNGs for the tray/menu-bar icon and a square app icon PNG.
// These are cosmetic placeholders — swap resources/icons/* for real artwork any time; nothing
// in the app logic depends on their exact pixels, only their file paths.
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');

const ICONS_DIR = path.join(__dirname, '..', 'resources', 'icons');

function drawCircle(size, { fill, stroke } = {}) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const r = size / 2;
  ctx.beginPath();
  ctx.arc(r, r, r - Math.max(1, size * 0.06), 0, Math.PI * 2);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.lineWidth = Math.max(1, size * 0.08);
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
  return canvas;
}

function writePng(canvas, fileName) {
  const buf = canvas.toBuffer('image/png');
  fs.writeFileSync(path.join(ICONS_DIR, fileName), buf);
  console.log('wrote', fileName);
}

// macOS menu-bar "template" image: solid black shape with alpha, no color — macOS auto-tints
// it for light/dark mode. 22pt @1x / @2x is the conventional menu-bar size.
writePng(drawCircle(22, { fill: '#000000' }), 'trayTemplate.png');
writePng(drawCircle(44, { fill: '#000000' }), 'trayTemplate@2x.png');

// Windows tray icon: full color, since Windows doesn't do template-image auto-tinting.
writePng(drawCircle(32, { fill: '#7C3AED' }), 'tray.png');

// App icon placeholder (electron-builder needs real .icns/.ico for a signed build later;
// this square PNG is a source asset a designer/tool can convert from in Phase 7).
writePng(drawCircle(512, { fill: '#7C3AED', stroke: '#3B2266' }), 'icon.png');

console.log('Done. icon.png can be converted to icon.icns (mac) / icon.ico (Windows) in Phase 7.');
