const path = require('path');
const { fork } = require('child_process');
const { withTimeout } = require('./withTimeout');
const { PDF_EXTRACTION_TIMEOUT_MS } = require('../../shared/constants');

const CHILD_ENTRY = path.join(__dirname, 'pdfExtractorChildProcess.js');

let child = null;
let nextRequestId = 1;
const pending = new Map(); // requestId -> {resolve, reject}

/**
 * Lazily forks a single persistent PDF-extraction child process, reused across extractPdfText()
 * calls (pdf.js's dynamic import() has real overhead, so we don't want to pay it per file). A
 * real OS process rather than an in-process call: a wedged pdf.js parse or @napi-rs/canvas
 * render — pdf.js's Node/worker-thread misdetection makes those indistinguishable from a slow
 * one — would otherwise block this worker's single JS thread past every Promise.race deadline,
 * silently freezing the whole tick loop (import polling AND backfill, across every vault) since
 * a new tick never starts until the previous one finishes. A hang like that can only be
 * recovered with an unconditional SIGKILL, which requires a process boundary, not just a
 * same-process timeout — the same reasoning ocrEngine.js already applies to tesseract.
 */
function spawnChild() {
  const proc = fork(CHILD_ENTRY, [], { stdio: 'pipe' });

  proc.on('message', ({ id, ok, result, error }) => {
    const waiter = pending.get(id);
    if (!waiter) return; // already timed out and abandoned
    pending.delete(id);
    if (ok) waiter.resolve(result);
    else waiter.reject(new Error(error));
  });

  proc.on('exit', (code) => {
    // A crash (or our own post-timeout SIGKILL) would otherwise leave any in-flight request's
    // promise unresolved forever.
    for (const waiter of pending.values()) {
      waiter.reject(new Error(`PDF extraction child process exited unexpectedly (code ${code})`));
    }
    pending.clear();
    if (child === proc) child = null;
  });

  proc.stdout?.on('data', (chunk) => process.stdout.write(`[pdfExtractorChild] ${chunk}`));
  proc.stderr?.on('data', (chunk) => process.stderr.write(`[pdfExtractorChild:err] ${chunk}`));

  return proc;
}

function getChild() {
  if (!child) child = spawnChild();
  return child;
}

// pdf.js's Node/worker-thread misdetection (see pdfExtractorChildProcess.js) makes a wedged
// render or parse indistinguishable from a slow one — this timeout is the backstop against a
// single bad PDF freezing the whole worker tick loop forever. Logged before starting so the
// last log line names the file if it does time out.
async function extractPdfText(filePath) {
  console.log(`[pdfExtractor] extracting: ${filePath}`);
  const proc = getChild();
  const id = nextRequestId;
  nextRequestId += 1;
  const resultPromise = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
  // A losing resultPromise below is abandoned, not cancelled — swallow its eventual settlement
  // so it doesn't surface as an unhandled rejection once the timeout has already won.
  resultPromise.catch(() => {});
  proc.send({ id, filePath });
  try {
    return await withTimeout(resultPromise, PDF_EXTRACTION_TIMEOUT_MS, `extractPdfText ${filePath}`);
  } catch (err) {
    if (String(err.message).startsWith('Timed out')) {
      console.error(`[pdfExtractor] ${err.message} — killing wedged PDF extraction child process`);
      pending.delete(id);
      if (child === proc) child = null;
      proc.kill('SIGKILL'); // SIGTERM assumes the process can still respond; a wedged one can't.
    }
    throw err;
  }
}

module.exports = { extractPdfText };
