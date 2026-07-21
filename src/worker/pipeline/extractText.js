const path = require('path');
const fs = require('fs');
const { extractPdfText } = require('./pdfExtractor');
const { heicFileToJpegBuffer } = require('./heicConvert');
const { ocrImage } = require('./ocrEngine');
const { HEIC_EXTENSIONS } = require('../../shared/constants');

const TEXT_EXTENSIONS = new Set(['txt', 'md']);
const NON_HEIC_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp']);

function extOf(filePath) {
  return path.extname(filePath).slice(1).toLowerCase();
}

/**
 * Dispatches text extraction by file extension. `imageTypesEnabled` gates OCR for image
 * files per Settings §5 — an unchecked image type still gets a note + embed, just skips OCR
 * (returns empty text, not an error, per the spec's 200 "processed, no text found" status).
 * A file type this app doesn't know how to extract from (e.g. .xlsx, .docx, .p7s) is handled
 * the same way — the attachment still gets a note/embed/ID: line, it just has no extracted
 * text or tag matches, rather than being marked as a failed (400) document.
 * Returns { text, title, usedOcr, skippedOcr }.
 */
async function extractText(filePath, imageTypesEnabled) {
  const ext = extOf(filePath);

  if (TEXT_EXTENSIONS.has(ext)) {
    const text = (await fs.promises.readFile(filePath, 'utf8')).trim();
    return { text, title: null, usedOcr: false, skippedOcr: false };
  }

  if (ext === 'pdf') {
    const result = await extractPdfText(filePath);
    return { ...result, skippedOcr: false };
  }

  const isHeic = HEIC_EXTENSIONS.includes(ext);
  const isPlainImage = NON_HEIC_IMAGE_EXTENSIONS.has(ext);
  if (isHeic || isPlainImage) {
    if (!imageTypesEnabled.includes(ext)) {
      return { text: '', title: null, usedOcr: false, skippedOcr: true };
    }
    const ocrInput = isHeic ? await heicFileToJpegBuffer(filePath) : filePath;
    if (!isHeic) console.log(`[extractText] OCR: ${filePath}`);
    const text = await ocrImage(ocrInput);
    return { text, title: null, usedOcr: true, skippedOcr: false };
  }

  return { text: '', title: null, usedOcr: false, skippedOcr: true };
}

module.exports = { extractText, extOf };
