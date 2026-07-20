const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');
const { ocrImage } = require('./ocrEngine');
const { MIN_TEXT_LAYER_CHARS } = require('../../shared/constants');

const MAX_OCR_FALLBACK_PAGES = 5; // bound OCR cost for large scanned PDFs
const RENDER_SCALE = 2; // ~144dpi-ish for a 72dpi base viewport, good enough for OCR

// Bundled cmaps/standard fonts (vendored from node_modules/pdfjs-dist, see resources/pdfjs/).
// Without these, PDFs whose embedded fonts use a non-Identity encoding (common for CJK, and
// plenty of everyday PDFs from scanners/printers with subset TrueType fonts) fail to translate
// glyphs to text ("cMapUrl and cMapPacked API parameters are provided" / "TT: undefined
// function") and their extracted text comes out empty or garbled. Trailing slash matters —
// pdf.js's readers build the file path via plain string concatenation (baseUrl + name).
const PDFJS_RESOURCES_DIR = path.join(__dirname, '..', '..', '..', 'resources', 'pdfjs');
const CMAP_URL = `${path.join(PDFJS_RESOURCES_DIR, 'cmaps')}${path.sep}`;
const STANDARD_FONT_DATA_URL = `${path.join(PDFJS_RESOURCES_DIR, 'standard_fonts')}${path.sep}`;

// pdf.js picks its Node-vs-browser code paths (fake worker, filesystem-based CMap/font
// loading, etc.) via an internal isNodeJS check that also requires process.type === 'browser'
// when process.versions.electron is set. Electron's utilityProcess reports a different
// process.type, so pdf.js misdetects it as a browser context and reaches for DOM/fetch-based
// readers that don't exist here (surfacing as "document is not defined"). These two small
// classes replicate pdf.js's own NodeCMapReaderFactory/NodeStandardFontDataFactory (plain
// fs.readFile against a local directory) so we can force the Node behavior explicitly instead.
class LocalCMapReaderFactory {
  constructor({ baseUrl, isCompressed }) {
    this.baseUrl = baseUrl;
    this.isCompressed = isCompressed;
  }
  async fetch({ name }) {
    if (!name) throw new Error('CMap name must be specified.');
    const filePath = `${this.baseUrl}${name}${this.isCompressed ? '.bcmap' : ''}`;
    const cMapData = new Uint8Array(await fs.promises.readFile(filePath));
    return { cMapData, isCompressed: this.isCompressed };
  }
}
class LocalStandardFontDataFactory {
  constructor({ baseUrl }) {
    this.baseUrl = baseUrl;
  }
  async fetch({ filename }) {
    if (!filename) throw new Error('Font filename must be specified.');
    return new Uint8Array(await fs.promises.readFile(`${this.baseUrl}${filename}`));
  }
}

// Same isNodeJS misdetection as above means pdf.js also defaults to its DOM-based filter
// factory (SVG filters for blend modes / soft masks), which reaches for
// `document.createElement` while rendering pages that use those graphics features — surfacing
// as "Cannot read properties of undefined (reading 'createElement')". We don't need real filter
// rendering for OCR/text extraction, so this mirrors pdf.js's own (internal, unexported)
// NodeFilterFactory: a no-op that reports "no filter" instead of touching the DOM.
class NoopFilterFactory {
  addFilter() { return 'none'; }
  addHCMFilter() { return 'none'; }
  addAlphaFilter() { return 'none'; }
  addLuminosityFilter() { return 'none'; }
  addHighlightHCMFilter() { return 'none'; }
  destroy() {}
}

let pdfjsLibPromise = null;
function loadPdfjs() {
  // pdfjs-dist v4 ships ESM-only; this project is CommonJS, so bridge via dynamic import().
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((pdfjsLib) => {
      // Same isNodeJS misdetection as above means pdf.js won't fall back to a same-thread
      // "fake worker" automatically — point it at the real worker script explicitly.
      pdfjsLib.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
      return pdfjsLib;
    });
  }
  return pdfjsLibPromise;
}

// pdfjs-dist's Node rendering path expects a CanvasFactory with this shape; @napi-rs/canvas's
// createCanvas/getContext('2d')/toBuffer API is drop-in compatible with what pdfjs expects
// from the `canvas` npm package in its own Node examples.
class NapiCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }
  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

async function renderPageToPngBuffer(page) {
  const canvasFactory = new NapiCanvasFactory();
  const viewport = page.getViewport({ scale: RENDER_SCALE });
  const canvasAndContext = canvasFactory.create(viewport.width, viewport.height);
  await page.render({
    canvasContext: canvasAndContext.context,
    viewport,
    canvasFactory,
  }).promise;
  const buffer = canvasAndContext.canvas.toBuffer('image/png');
  canvasFactory.destroy(canvasAndContext);
  return buffer;
}

/**
 * Extracts text from a PDF: tries the embedded text layer first; if that yields
 * (near-)nothing, treats it as a scanned/image-only PDF and OCRs a bounded number of
 * rendered pages instead. Also returns the PDF's metadata Title, if present, for the
 * note-title rule (title = metadata Title, else cleaned filename).
 */
async function extractPdfText(filePath) {
  const pdfjsLib = await loadPdfjs();
  const data = new Uint8Array(await fs.promises.readFile(filePath));
  const loadingTask = pdfjsLib.getDocument({
    data,
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    CMapReaderFactory: LocalCMapReaderFactory,
    StandardFontDataFactory: LocalStandardFontDataFactory,
    FilterFactory: NoopFilterFactory,
    // pdf.js has exactly 4 isNodeJS-gated "Default*Factory" fallbacks (CMapReader,
    // StandardFontData, Filter, Canvas) — all 4 need an explicit override here, or whichever
    // one is left on its DOM-based default reaches for `document.createElement` the moment a
    // PDF actually exercises it and crashes with "Cannot read properties of undefined
    // (reading 'createElement')". This is the 4th; NapiCanvasFactory already has the right
    // shape since it's also used directly by page.render() below.
    CanvasFactory: NapiCanvasFactory,
  });
  const pdfDoc = await loadingTask.promise;

  try {
    const metadata = await pdfDoc.getMetadata().catch(() => null);
    const title = metadata?.info?.Title?.trim() || null;

    let textLayer = '';
    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum += 1) {
      const page = await pdfDoc.getPage(pageNum);
      const content = await page.getTextContent();
      const pageText = content.items.map((item) => item.str).join(' ');
      textLayer += `${pageText}\n`;
    }
    textLayer = textLayer.trim();

    if (textLayer.length >= MIN_TEXT_LAYER_CHARS) {
      return { text: textLayer, title, usedOcr: false };
    }

    // Scanned/image-only PDF fallback: rasterize + OCR a bounded number of pages.
    const pagesToOcr = Math.min(pdfDoc.numPages, MAX_OCR_FALLBACK_PAGES);
    let ocrText = '';
    for (let pageNum = 1; pageNum <= pagesToOcr; pageNum += 1) {
      const page = await pdfDoc.getPage(pageNum);
      const pngBuffer = await renderPageToPngBuffer(page);
      const pageOcrText = await ocrImage(pngBuffer);
      ocrText += `${pageOcrText}\n`;
    }
    return { text: ocrText.trim(), title, usedOcr: true };
  } finally {
    await pdfDoc.destroy();
  }
}

module.exports = { extractPdfText };
