'use strict';
function imageExtension(data) {
  if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) return null;
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return '.png';
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return '.jpg';
  if (b.length >= 12 && b.toString('ascii',0,4) === 'RIFF' && b.toString('ascii',8,12) === 'WEBP') return '.webp';
  return null;
}
module.exports = { imageExtension };
