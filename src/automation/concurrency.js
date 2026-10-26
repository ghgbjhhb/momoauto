'use strict';

// Bounded independent reads; preserve order, stop admitting work on failure,
// and settle already-running reads before the caller can perform a write.
async function mapLimit(values, limit, read, signal) {
  const results = new Array(values.length);
  let cursor = 0, failed = false, firstError;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (!failed && cursor < values.length) {
      const index = cursor++;
      try {
        if (signal?.aborted) throw signal.reason ?? new Error('Read cancelled');
        results[index] = await read(values[index], index);
      } catch (error) { if (!failed) firstError = error; failed = true; }
    }
  }));
  if (failed) throw firstError;
  if (signal?.aborted) throw signal.reason ?? new Error('Read cancelled');
  return results;
}

module.exports = { mapLimit };
