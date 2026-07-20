const fs = require('fs');
const convert = require('heic-convert');

/**
 * Decodes a HEIC/HEIF buffer to a JPEG buffer via pure JS/WASM (heic-convert -> heic-decode),
 * so this works identically on macOS and Windows with no system-level libheif dependency.
 */
async function heicFileToJpegBuffer(filePath) {
  const inputBuffer = await fs.promises.readFile(filePath);
  const outputBuffer = await convert({ buffer: inputBuffer, format: 'JPEG', quality: 0.92 });
  return Buffer.from(outputBuffer);
}

module.exports = { heicFileToJpegBuffer };
