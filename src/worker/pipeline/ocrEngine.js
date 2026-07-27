const path = require('path');
const { fork } = require('child_process');
const { withTimeout } = require('./withTimeout');
const { OCR_TIMEOUT_MS } = require('../../shared/constants');

const CHILD_ENTRY = path.join(__dirname, 'ocrChildProcess.js');

let child = null;
let nextRequestId = 1;
const pending = new Map(); // requestId -> {resolve, reject}

/**
 * Lazily forks a single persistent OCR child process, reused across recognize() calls (tesseract
 * worker startup + trained-data load has real overhead, so we don't want to pay it per file).
 * A real OS process rather than an in-process worker_thread: this app once hung for over an hour
 * because a wedged tesseract recognize() call blocked its host thread past every JS-level
 * Promise.race deadline — a hang like that can only be recovered with an unconditional SIGKILL,
 * which requires a process boundary, not just a thread one.
 */
function spawnChild() {
  const proc = fork(CHILD_ENTRY, [], { stdio: 'pipe' });

  proc.on('message', ({ id, ok, text, error }) => {
    const waiter = pending.get(id);
    if (!waiter) return; // already timed out and abandoned
    pending.delete(id);
    if (ok) waiter.resolve(text);
    else waiter.reject(new Error(error));
  });

  proc.on('exit', (code) => {
    // A crash (or our own post-timeout SIGKILL) would otherwise leave any in-flight request's
    // promise unresolved forever.
    for (const waiter of pending.values()) {
      waiter.reject(new Error(`OCR child process exited unexpectedly (code ${code})`));
    }
    pending.clear();
    if (child === proc) child = null;
  });

  proc.stdout?.on('data', (chunk) => process.stdout.write(`[ocrChild] ${chunk}`));
  proc.stderr?.on('data', (chunk) => process.stderr.write(`[ocrChild:err] ${chunk}`));

  return proc;
}

function getChild() {
  if (!child) child = spawnChild();
  return child;
}

/**
 * Runs OCR on an image buffer (or file path) and returns the extracted text, trimmed.
 * A recognize() call that never resolves (a wedged tesseract worker) would otherwise freeze
 * every future call forever — so a timeout here SIGKILLs the whole child process and forgets
 * it, forcing the next call to fork a fresh one instead of queuing behind a dead one.
 */
async function ocrImage(input) {
  const proc = getChild();
  const id = nextRequestId;
  nextRequestId += 1;
  const resultPromise = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
  // A losing resultPromise below is abandoned, not cancelled — swallow its eventual settlement
  // so it doesn't surface as an unhandled rejection once the timeout has already won.
  resultPromise.catch(() => {});
  proc.send({ id, input });
  try {
    return await withTimeout(resultPromise, OCR_TIMEOUT_MS, 'ocrImage');
  } catch (err) {
    if (String(err.message).startsWith('Timed out')) {
      console.error(`[ocrEngine] ${err.message} — killing wedged OCR child process`);
      pending.delete(id);
      if (child === proc) child = null;
      proc.kill('SIGKILL'); // SIGTERM assumes the process can still respond; a wedged one can't.
    }
    throw err;
  }
}

async function terminateOcrWorker() {
  if (!child) return;
  const proc = child;
  child = null;
  proc.kill('SIGKILL'); // no in-flight request to wait on gracefully, same reasoning as above
}

module.exports = { ocrImage, terminateOcrWorker };
