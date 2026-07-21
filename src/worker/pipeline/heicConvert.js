const fs = require('fs');
const convert = require('heic-convert');
const { withTimeout } = require('./withTimeout');
const { HEIC_CONVERT_TIMEOUT_MS } = require('../../shared/constants');

/**
 * Decodes a HEIC/HEIF buffer to a JPEG buffer via pure JS/WASM (heic-convert -> heic-decode),
 * so this works identically on macOS and Windows with no system-level libheif dependency.
 */
async function heicFileToJpegBuffer(filePath) {
  console.log(`[heicConvert] converting: ${filePath}`);
  const inputBuffer = await fs.promises.readFile(filePath);
  const convertPromise = convert({ buffer: inputBuffer, format: 'JPEG', quality: 0.92 });
  // Abandoned (not cancelled) if the timeout wins below — swallow its eventual settlement so
  // it doesn't surface as an unhandled rejection once nothing is still awaiting it.
  convertPromise.catch(() => {});
  const outputBuffer = await withTimeout(convertPromise, HEIC_CONVERT_TIMEOUT_MS, `heicFileToJpegBuffer ${filePath}`);
  return Buffer.from(outputBuffer);
}

module.exports = { heicFileToJpegBuffer };
