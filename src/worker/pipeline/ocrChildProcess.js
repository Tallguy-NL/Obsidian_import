// Hosts the tesseract.js worker in its own OS process, forked by ocrEngine.js. Runs in complete
// isolation from the main worker process so a wedged native/WASM decode here can only ever freeze
// this process, never the tick loop — ocrEngine.js recovers a hang by SIGKILLing this whole
// process, which the kernel guarantees works even if this process is blocked in a way no
// in-process Promise.race timeout could preempt.
const path = require('path');
const fs = require('fs');
const { createWorker } = require('tesseract.js');
const { resolveUserDataPath } = require('../../shared/userDataPath');

const BUNDLED_TESSDATA_DIR = path.join(__dirname, '..', '..', '..', 'resources', 'tessdata');
const TESSDATA_CACHE_DIR = path.join(resolveUserDataPath(), 'tessdata-cache');

let workerPromise = null;

function getOcrWorker() {
  if (!workerPromise) {
    fs.mkdirSync(TESSDATA_CACHE_DIR, { recursive: true });
    const hasBundledTessdata = fs.existsSync(path.join(BUNDLED_TESSDATA_DIR, 'eng.traineddata.gz'));
    workerPromise = createWorker('eng', 1, {
      langPath: hasBundledTessdata ? BUNDLED_TESSDATA_DIR : undefined,
      cachePath: TESSDATA_CACHE_DIR,
      gzip: true,
      // Without this, tesseract.js's internal message handler both rejects the failed job's
      // promise (which the try/catch below already handles) AND, redundantly, throws
      // synchronously inside that handler — uncatchable from our side, crashing this process.
      // A no-op errorHandler suppresses that second throw; the promise rejection alone is
      // enough for the recognize() call below to see the failure.
      errorHandler: (err) => console.error('[ocrChildProcess] tesseract worker reported an error:', err),
    });
  }
  return workerPromise;
}

// The parent (worker/index.js, or pdfExtractorChildProcess.js for the nested OCR case) dying —
// for any reason, including a SIGKILL neither side can run cleanup code for — closes this
// process's IPC channel, which is what actually fires 'disconnect'. process.exit() elsewhere
// only runs on a clean shutdown; this is the one exit path that also covers a crash or an
// external kill(), which is exactly how this process was ending up orphaned before.
process.on('disconnect', () => process.exit(0));

process.on('message', async ({ id, input }) => {
  try {
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(input);
    process.send({ id, ok: true, text: (data.text || '').trim() });
  } catch (err) {
    process.send({ id, ok: false, error: String((err && err.message) || err) });
  }
});
