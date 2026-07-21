const path = require('path');
const fs = require('fs');
const { createWorker } = require('tesseract.js');
const { resolveUserDataPath } = require('../../shared/userDataPath');
const { withTimeout } = require('./withTimeout');
const { OCR_TIMEOUT_MS } = require('../../shared/constants');

// Bundled, read-only source data (a packaged .app is typically read-only once signed) vs. a
// writable per-user location tesseract.js decompresses its working copy into — these must be
// different directories, or tesseract.js's cache write fails/pollutes the app bundle.
const BUNDLED_TESSDATA_DIR = path.join(__dirname, '..', '..', '..', 'resources', 'tessdata');
const TESSDATA_CACHE_DIR = path.join(resolveUserDataPath(), 'tessdata-cache');

let workerPromise = null;

/**
 * Lazily creates a single persistent tesseract.js worker, reused across recognize() calls
 * (worker startup + trained-data load has real overhead, so we don't want to pay it per file).
 * Points langPath at the bundled resources/tessdata/eng.traineddata.gz so first-run OCR needs
 * no network fetch.
 */
function getOcrWorker() {
  if (!workerPromise) {
    fs.mkdirSync(TESSDATA_CACHE_DIR, { recursive: true });
    const hasBundledTessdata = fs.existsSync(path.join(BUNDLED_TESSDATA_DIR, 'eng.traineddata.gz'));
    workerPromise = createWorker('eng', 1, {
      langPath: hasBundledTessdata ? BUNDLED_TESSDATA_DIR : undefined,
      cachePath: TESSDATA_CACHE_DIR,
      gzip: true,
      // Without this, tesseract.js's internal message handler both rejects the failed job's
      // promise (which our callers' try/catch already handles) AND, redundantly, throws
      // synchronously inside that handler — uncatchable from our side since it's outside our
      // call stack, crashing the whole worker utilityProcess. A no-op errorHandler suppresses
      // that second throw; the promise rejection alone is enough for callers to see the failure.
      errorHandler: (err) => console.error('[ocrEngine] tesseract worker reported an error:', err),
    });
  }
  return workerPromise;
}

/**
 * Runs OCR on an image buffer (or file path) and returns the extracted text, trimmed.
 * A recognize() call that never resolves (a wedged tesseract worker thread) would otherwise
 * freeze every future call on this same singleton worker forever, not just the current file —
 * so a timeout here also tears down and forgets the worker, forcing the next call to spin up a
 * fresh one instead of queuing behind a dead one.
 */
async function ocrImage(input) {
  const worker = await getOcrWorker();
  const recognizePromise = worker.recognize(input);
  // A losing recognizePromise below is abandoned, not cancelled — swallow its eventual
  // settlement so it doesn't surface as an unhandled rejection once the timeout has already won.
  recognizePromise.catch(() => {});
  try {
    const { data } = await withTimeout(recognizePromise, OCR_TIMEOUT_MS, 'ocrImage');
    return (data.text || '').trim();
  } catch (err) {
    if (String(err.message).startsWith('Timed out')) {
      console.error(`[ocrEngine] ${err.message} — resetting OCR worker`);
      workerPromise = null;
      await worker.terminate().catch((termErr) => {
        console.error('[ocrEngine] failed to terminate wedged worker:', termErr);
      });
    }
    throw err;
  }
}

async function terminateOcrWorker() {
  if (!workerPromise) return;
  const worker = await workerPromise;
  workerPromise = null;
  await worker.terminate();
}

module.exports = { ocrImage, terminateOcrWorker };
