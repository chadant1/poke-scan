// On-device text recognition with Tesseract.js. The picture stays in memory
// (a <canvas>) and is discarded as soon as it has been read.

import { parseNumber, parseSetCodes, cleanName } from './parse.js';

let workerPromise = null;

function waitForTesseract(ms = 15000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function check() {
      if (window.Tesseract) return resolve(window.Tesseract);
      if (Date.now() - t0 > ms) return reject(new Error('The text reader could not be downloaded. Check your connection.'));
      setTimeout(check, 150);
    })();
  });
}

export function warmUp(onProgress) {
  if (!workerPromise) {
    workerPromise = (async () => {
      const T = await waitForTesseract();
      const worker = await T.createWorker('eng', 1, {
        logger: m => { if (onProgress && m.status) onProgress(m); },
      });
      return worker;
    })().catch(e => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

/** Copy a region (fractions of the source) into a new canvas, upscaled and contrast-stretched. */
function region(src, fx, fy, fw, fh, targetW, invert = false) {
  const sx = Math.round(src.width * fx), sy = Math.round(src.height * fy);
  const sw = Math.round(src.width * fw), sh = Math.round(src.height * fh);
  const scale = Math.max(1, Math.min(4, targetW / sw));
  const c = document.createElement('canvas');
  c.width = Math.round(sw * scale);
  c.height = Math.round(sh * scale);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  // Grayscale + histogram stretch (1st–99th percentile).
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const y = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
    d[i] = y; hist[y]++;
  }
  const n = d.length / 4;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > n * 0.01) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > n * 0.01) { hi = v; break; } }
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    let y = (d[i] - lo) * 255 / span;
    y = y < 0 ? 0 : y > 255 ? 255 : y;
    if (invert) y = 255 - y;
    d[i] = d[i + 1] = d[i + 2] = y;
  }
  g.putImageData(img, 0, 0);
  return c;
}

async function read(worker, canvas, psm) {
  await worker.setParameters({ tessedit_pageseg_mode: String(psm) });
  const { data } = await worker.recognize(canvas);
  canvas.width = canvas.height = 0; // free memory
  return { text: data.text || '', conf: data.confidence || 0 };
}

/**
 * Read a card image. `card` is a canvas holding just the card (portrait).
 * mode "frame": the card fills the image (camera guide). mode "photo": unknown framing.
 */
export async function readCard(card, { mode = 'frame', onStep } = {}) {
  const worker = await warmUp();
  const step = s => onStep && onStep(s);
  const out = { nameText: '', bottomText: '', fullText: '', number: null, setCodes: [], name: '' };

  if (mode === 'frame') {
    step('Reading card number…');
    // Bottom strip: collector number, set code, illustrator.
    let b = await read(worker, region(card, 0, 0.865, 1, 0.125, 1800), 11);
    out.bottomText = b.text;
    out.number = parseNumber(b.text);
    if (!out.number) {
      const bi = await read(worker, region(card, 0, 0.865, 1, 0.125, 1800, true), 11);
      out.bottomText += '\n' + bi.text;
      out.number = parseNumber(bi.text);
    }
    if (!out.number) {
      // Older cards put the number a little higher, bottom-right.
      const b2 = await read(worker, region(card, 0.45, 0.80, 0.55, 0.19, 1400), 11);
      out.bottomText += '\n' + b2.text;
      out.number = parseNumber(b2.text);
    }
    out.setCodes = parseSetCodes(out.bottomText);

    step('Reading card name…');
    const n1 = await read(worker, region(card, 0.02, 0.018, 0.78, 0.10, 1400), 6);
    let nameText = n1.text, conf = n1.conf;
    if (conf < 70 || cleanName(nameText).length < 3) {
      const n2 = await read(worker, region(card, 0.02, 0.018, 0.78, 0.10, 1400, true), 6);
      if (n2.conf > conf && cleanName(n2.text).length >= 3) { nameText = n2.text; conf = n2.conf; }
    }
    out.nameText = nameText;
    out.name = cleanName(nameText);
  }

  if (mode === 'photo' || !out.number || out.name.length < 3) {
    step('Reading the whole card…');
    const f = await read(worker, region(card, 0, 0, 1, 1, 1600), 11);
    out.fullText = f.text;
    if (!out.number) out.number = parseNumber(f.text);
    if (!out.setCodes.length) out.setCodes = parseSetCodes(f.text);
    if (out.name.length < 3) out.name = cleanName(f.text.split('\n').slice(0, 4).join('\n'));
  }
  return out;
}
