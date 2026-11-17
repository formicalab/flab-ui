// QR codes as inline SVG, for handing a text to a phone (the WireGuard app scans the configuration of a new client). The encoder
// is the vendored qrcode-generator (www/vendor/qrcode.js, MIT); it is imported on first use, so a page that never shows a QR code
// never loads it. Nothing leaves the browser: the text is encoded here and drawn with DOM calls, never parsed as HTML.
import { h } from './dom.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// The modules of the QR code of `text` (UTF-8 bytes) as rows of booleans (true = dark), without the quiet zone. Throws when the text is
// too long for the largest code at the error correction level `ecc` ('L', 'M', 'Q' or 'H'; M survives a smudged screen and still fits
// a WireGuard configuration).
export async function qrMatrix(text, ecc = 'M') {
  const { qrcode } = await import('../../vendor/qrcode.js');
  // The library encodes bytes as Latin-1 unless told otherwise; names and comments may hold any character.
  qrcode.stringToBytes = s => Array.from(new TextEncoder().encode(s));
  // Type number 0 picks the smallest version that fits.
  const qr = qrcode(0, ecc);
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, row) => Array.from({ length: n }, (_, col) => qr.isDark(row, col)));
}

// The QR code of `text` as an <svg> element (see qrMatrix for the errors). The colors are fixed, black on white with a quiet zone
// of `margin` modules, because scanners need that contrast whatever theme the page uses. `size` is the width in CSS pixels.
export async function qrSvg(text, { ecc = 'M', margin = 4, size = 340, label = 'QR code' } = {}) {
  const rows = await qrMatrix(text, ecc);
  const n = rows.length;
  // One path for every dark module: a unit square at (col, row).
  let d = '';
  rows.forEach((cells, row) => cells.forEach((dark, col) => { if (dark) d += `M${col + margin} ${row + margin}h1v1h-1z`; }));
  const total = n + margin * 2;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${total} ${total}`);
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  svg.setAttribute('shape-rendering', 'crispEdges');
  const back = document.createElementNS(SVG_NS, 'rect');
  back.setAttribute('width', total);
  back.setAttribute('height', total);
  back.setAttribute('fill', '#fff');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000');
  svg.append(back, path);
  return svg;
}

// A container for a QR code that fills in when the encoder is loaded; a text that cannot be encoded shows `fallback` instead.
export function qrBox(text, fallback, options) {
  const box = h('div', { className: 'fl-qr' });
  qrSvg(text, options).then(svg => box.replaceChildren(svg), () => box.replaceChildren(fallback));
  return box;
}
