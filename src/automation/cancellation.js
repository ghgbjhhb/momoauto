'use strict';
function cancelled(code = 'ABORTED') { return Object.assign(new Error('Operation cancelled or deadline exceeded'), { code }); }
function checkSignal(signal) { if (signal?.aborted) throw cancelled(); }
function waitFor(pending, { signal, timeoutMs, timeoutCode = 'TIMEOUT' } = {}) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const finish = (fn, value) => { cleanup(); fn(value); };
    const abort = () => finish(reject, cancelled());
    Promise.resolve(pending).then(value => finish(resolve, value), error => finish(reject, error));
    signal?.addEventListener('abort', abort, { once: true });
    if (Number.isFinite(timeoutMs)) timer = setTimeout(() => finish(reject, cancelled(timeoutCode)), Math.max(1, timeoutMs));
    if (signal?.aborted) abort();
  });
}
function sleep(ms, signal) {
  checkSignal(signal);
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(cancelled()); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
module.exports = { checkSignal, waitFor,
  sleep: require('./timing').timed('automation.wait', sleep) };
