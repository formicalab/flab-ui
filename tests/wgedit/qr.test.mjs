// node --test tests/wgedit/qr.test.mjs
// The QR matrix of www/js/core/qr.js (the encoder is the vendored qrcode-generator). The drawing itself needs a DOM and is covered by
// the browser suite; the matrix is checked for its size, its finder patterns and its refusal of a text that is too long. That the
// codes really decode was checked against an independent decoder when the library was vendored.
import assert from 'node:assert/strict';
import test from 'node:test';
import { qrMatrix } from '../../www/js/core/qr.js';

// Whether the 7x7 finder pattern (a dark ring, a light ring, a dark 3x3 center) starts at (row, col).
const finder = (rows, row, col) => {
  for (let r = 0; r < 7; r++)
    for (let c = 0; c < 7; c++) {
      const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
      if (rows[row + r][col + c] !== (ring !== 2)) return false;
    }
  return true;
};

test('a short text is a version 1 code with the three finder patterns', async () => {
  const rows = await qrMatrix('hello');
  assert.equal(rows.length, 21);
  assert.ok(rows.every(r => r.length === 21));
  assert.ok(finder(rows, 0, 0) && finder(rows, 0, 14) && finder(rows, 14, 0));
});

test('the code grows with the text and with the error correction level', async () => {
  const text = 'x'.repeat(400);
  const low = (await qrMatrix(text, 'L')).length, high = (await qrMatrix(text, 'H')).length;
  assert.ok(low > 21 && high > low, `${low} / ${high}`);
});

test('the text is encoded as UTF-8, not Latin-1', async () => {
  // 17 bytes fit a version 1 code at level L; "é" is one byte in Latin-1 but two in UTF-8, so 9 of them (18 bytes) need version 2.
  assert.equal((await qrMatrix('é'.repeat(8), 'L')).length, 21);
  assert.equal((await qrMatrix('é'.repeat(9), 'L')).length, 25);
});

test('a text longer than the largest code is refused', async () => {
  await assert.rejects(qrMatrix('x'.repeat(3000), 'L'));
});
