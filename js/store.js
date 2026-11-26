// Small localStorage helpers with time-limited caching.
// Nothing image-related is ever stored here – only card ids, names and prices.

const P = 'ps.';

export function get(key, fallback = null) {
  try {
    const v = localStorage.getItem(P + key);
    return v == null ? fallback : JSON.parse(v);
  } catch (e) { return fallback; }
}

export function set(key, value) {
  try { localStorage.setItem(P + key, JSON.stringify(value)); return true; }
  catch (e) {
    // Storage full: drop the price cache and try once more.
    clearCache();
    try { localStorage.setItem(P + key, JSON.stringify(value)); return true; } catch (e2) { return false; }
  }
}

export function del(key) { try { localStorage.removeItem(P + key); } catch (e) {} }

/** Cached value or null if missing / older than maxAgeMs. */
export function cached(key, maxAgeMs) {
  const v = get('c.' + key);
  if (!v || typeof v.t !== 'number') return null;
  if (maxAgeMs != null && Date.now() - v.t > maxAgeMs) return null;
  return v.d;
}
export function cacheAge(key) {
  const v = get('c.' + key);
  return v && typeof v.t === 'number' ? Date.now() - v.t : Infinity;
}
export function putCache(key, data) { return set('c.' + key, { t: Date.now(), d: data }); }

export function clearCache() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(P + 'c.')) keys.push(k);
    }
    keys.forEach(k => localStorage.removeItem(k));
    return keys.length;
  } catch (e) { return 0; }
}

export function cacheBytes() {
  let n = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(P)) n += k.length + (localStorage.getItem(k) || '').length;
    }
  } catch (e) {}
  return n * 2;
}

export const HOUR = 3600e3;
export const DAY = 24 * HOUR;
