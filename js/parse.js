// Pure text helpers: pull the card number, set code and name out of OCR text,
// and fuzzy-compare names. No DOM use, so these can be unit-tested in Node.

const DIGITISH = { O: '0', o: '0', Q: '0', D: '0', l: '1', I: '1', i: '1', '|': '1', '!': '1', S: '5', s: '5', B: '8', Z: '2', z: '2', G: '6' };
const fixDigits = s => s.replace(/[OoQDlIi|!SsBZzG]/g, ch => DIGITISH[ch] ?? ch);

/**
 * Find the collector number, e.g. "116/086", "TG12/TG30", "GG01/GG70", "SV045/SV094".
 * Returns { number: "116", total: "086", prefix: "" } or null.
 */
export function parseNumber(text) {
  if (!text) return null;
  const t = text.replace(/[\\⁄∕]/g, '/').replace(/\s*\/\s*/g, '/');
  const re = /(?:^|[^A-Za-z0-9])((?:TG|GG|SV|RC|SH|H)?)([0-9OoQDlIi|!SBZ]{1,3})\/((?:TG|GG|SV|RC|SH|H)?)([0-9OoQDlIi|!SBZ]{2,3})(?![0-9])/g;
  const hits = [];
  let m;
  while ((m = re.exec(t))) {
    const num = fixDigits(m[2]);
    const tot = fixDigits(m[4]);
    if (!/^\d+$/.test(num) || !/^\d+$/.test(tot)) continue;
    const n = +num, total = +tot;
    if (total < 5 || total > 400 || n < 1 || n > 500) continue;
    // Plausibility: secret rares go past the total, but not absurdly.
    if (!m[1] && n > total + 150) continue;
    let score = 0;
    if (/^\d+$/.test(m[2]) && /^\d+$/.test(m[4])) score += 2; // clean read
    if (m[2].length === m[4].length) score += 1;             // 116/086 style padding
    if (m[1] && m[1] === m[3]) score += 1;
    hits.push({ number: (m[1] || '') + num, total: (m[3] || '') + tot, prefix: m[1] || '', n, totalN: total, score });
  }
  if (!hits.length) return parsePromo(text);
  hits.sort((a, b) => b.score - a.score);
  const { number, total, prefix } = hits[0];
  return { number, total, prefix };
}

const PROMO_SETS = { SVP: 'svp', SWSH: 'swshp', SM: 'smp', XY: 'xyp', BW: 'bwp', MEP: 'mep', HGSS: 'hgssp', DP: 'dpp' };
export function parsePromo(text) {
  const m = /\b(SVP|SWSH|MEP|HGSS|SM|XY|BW|DP)\s*[-#]?\s*([0-9OolIS]{2,3})\b/.exec(text || '');
  if (!m) return null;
  const num = fixDigits(m[2]);
  if (!/^\d+$/.test(num)) return null;
  return { number: num, total: null, prefix: m[1], promoSet: PROMO_SETS[m[1]] };
}

const NOT_CODES = new Set(['EN', 'HP', 'EX', 'GX', 'THE', 'AND', 'FOR', 'YOU', 'ITS', 'NOT', 'ALL', 'ONE', 'TWO', 'PSA', 'BGS', 'CGC', 'LV', 'TM', 'INC', 'GAME', 'FREAK']);
/** Three/four-letter printed set codes such as "CRI", "SVI", "PAL" near the number. */
export function parseSetCodes(text) {
  const out = [];
  for (const m of (text || '').matchAll(/\b([A-Z]{3,4})\b/g)) {
    if (!NOT_CODES.has(m[1]) && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

const STOP = new Set([
  'stage', 'stage1', 'stage2', 'basic', 'evolves', 'from', 'hp', 'ability', 'attack', 'damage', 'pokemon', 'pokémon',
  'energy', 'weakness', 'resistance', 'retreat', 'trainer', 'item', 'supporter', 'stadium', 'tool', 'illus', 'your',
  'this', 'that', 'opponent', 'opponents', 'turn', 'card', 'cards', 'hand', 'deck', 'discard', 'active', 'spot', 'bench',
  'benched', 'once', 'during', 'each', 'more', 'with', 'into', 'then', 'counters', 'counter', 'place', 'rule', 'when',
  'gets', 'knocked', 'takes', 'prize', 'prizes', 'nintendo', 'creatures', 'freak', 'game', 'evolution', 'mega',
]);

/** Best guess at the card name from the text in the name band. */
export function cleanName(text) {
  if (!text) return '';
  const lines = text.split(/\n+/).map(l => l
    .replace(/[^A-Za-zÀ-ÿ'’.\- ]+/g, ' ')
    .replace(/\b(STAGE ?[12]?|BASIC|Stage ?[12]?|Basic|HP|Evolves from.*$)\b/g, ' ')
    .replace(/\s+/g, ' ').trim());
  let best = '';
  let bestScore = 0;
  for (const l of lines) {
    const words = l.split(' ').filter(w => w.length >= 2 || /^[A-Z]$/.test(w));
    const s = words.join(' ');
    const letters = (s.match(/[A-Za-zÀ-ÿ]/g) || []).length;
    // Prefer lines with a capitalised word and lots of letters.
    const score = letters + (/[A-Z][a-z]{2,}/.test(s) ? 10 : 0);
    if (score > bestScore) { best = s; bestScore = score; }
  }
  return best.split(' ').slice(0, 6).join(' ');
}

/** Distinctive words to search the card database with (longest first). */
export function keywords(text, max = 3) {
  const words = (text || '').match(/[A-Za-zÀ-ÿ'’]{4,}/g) || [];
  const seen = new Set();
  const out = [];
  for (const w of words.sort((a, b) => b.length - a.length)) {
    const k = w.toLowerCase();
    if (STOP.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

export function norm(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function lev(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

export function sim(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  return 1 - lev(a, b) / Math.max(a.length, b.length);
}

/**
 * How well `name` appears somewhere inside noisy OCR `text` (0..1).
 * Compares against every run of 1–6 consecutive words.
 */
export function nameInText(name, text) {
  const n = norm(name);
  const words = norm(text).split(' ').filter(Boolean);
  if (!n || !words.length) return 0;
  const want = n.split(' ').length;
  let best = 0;
  for (let i = 0; i < words.length; i++) {
    for (let len = Math.max(1, want - 1); len <= Math.min(6, want + 2) && i + len <= words.length; len++) {
      const s = sim(n, words.slice(i, i + len).join(' '));
      if (s > best) best = s;
    }
  }
  // Squashed spacing, e.g. "MegaGreninjaex".
  const squashed = sim(n.replace(/ /g, ''), words.join('').slice(0, n.length + 4));
  return Math.max(best, squashed * 0.95);
}

/** "116" vs "116", "001" vs "1", "TG12" vs "TG12". */
export function sameNumber(a, b) {
  const A = String(a ?? '').toUpperCase().trim();
  const B = String(b ?? '').toUpperCase().trim();
  if (!A || !B) return false;
  if (A === B) return true;
  const pa = /^([A-Z]*)0*(\d+)([A-Z]?)$/.exec(A);
  const pb = /^([A-Z]*)0*(\d+)([A-Z]?)$/.exec(B);
  return !!(pa && pb && pa[1] === pb[1] && pa[2] === pb[2] && pa[3] === pb[3]);
}

/** Leading collector number from strings like "116/086", "#116", "116". */
export function leadNumber(s) {
  const m = /([A-Za-z]*\d+[a-z]?)/.exec(String(s ?? '').split('/')[0]);
  return m ? m[1] : '';
}
