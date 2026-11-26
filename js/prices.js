// Prices.
//  • PokemonPriceTracker API (needs a free key): TCGplayer Near Mint market price,
//    daily price history (1 year) and eBay graded sales (PSA 8 / 9 / 10).
//  • Without a key: TCGplayer market price that TCGdex carries (no history / graded).

import { fetchJSON, HttpError } from './net.js';
import * as store from './store.js';
import { norm, sim, sameNumber, leadNumber } from './parse.js';

const BASE = 'https://www.pokemonpricetracker.com/api/v2';
const PRICE_TTL = 12 * store.HOUR;

export const getKey = () => (store.get('pptKey', '') || '').trim();
export const setKey = k => store.set('pptKey', (k || '').trim());

export const credits = { remaining: null };

async function api(path, params = {}) {
  const key = getKey();
  if (!key) throw new HttpError('No price key set.', 401);
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const url = `${BASE}${path}${qs.toString() ? '?' + qs : ''}`;
  try {
    const { data, headers } = await fetchJSON(url, { headers: { Authorization: `Bearer ${key}` }, timeout: 30000 });
    const rem = headers.get('X-RateLimit-Total-Remaining') ?? headers.get('X-RateLimit-Daily-Remaining');
    if (rem != null) { credits.remaining = +rem; store.set('pptCredits', { n: +rem, t: Date.now() }); }
    return data;
  } catch (e) {
    if (e.status === 401 || e.status === 403) throw new HttpError('The price key was not accepted. Check it in Settings.', e.status);
    if (e.status === 429) {
      const b = e.body || {};
      const when = b.resetsAt ? new Date(b.resetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;
      throw new HttpError(b.limitType === 'per_minute'
        ? 'Too many price lookups in a minute. Wait a moment and tap Refresh.'
        : `Today's free price lookups are used up${when ? ` (resets ${when})` : ''}.`, 429);
    }
    throw e;
  }
}

const list = d => Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : d?.data ? [d.data] : d ? [d] : [];

/* ---------------- sets ---------------- */

async function pptSets(force = false) {
  if (!force) {
    const c = store.cached('ppt.sets', 3 * store.DAY);
    if (c) return c;
  }
  const d = await api('/sets', { limit: 500 });
  const sets = list(d).map(s => ({
    id: s.tcgPlayerNumericId ?? s.tcgPlayerId ?? s.id,
    name: s.name || s.setName || '',
    code: s.code || s.abbreviation || s.ptcgoCode || null,
  })).filter(s => s.id != null && s.name);
  store.putCache('ppt.sets', sets);
  return sets;
}

// "ME04: Chaos Rising" -> "chaos rising";  "SV03.5: 151" -> "151"
const bareSet = s => norm(String(s || '').replace(/^[A-Za-z]{1,5}\d*[\w.]*\s*:\s*/, ''));

async function findSet(setName) {
  const want = bareSet(setName);
  const match = sets => {
    let best = null, bestS = 0;
    for (const s of sets) {
      const b = bareSet(s.name);
      const sc = b === want ? 1 : (b.includes(want) || want.includes(b)) && Math.min(b.length, want.length) >= 4 ? 0.9 : sim(b, want);
      if (sc > bestS) { best = s; bestS = sc; }
    }
    return bestS >= 0.86 ? best : null;
  };
  let sets = await pptSets();
  let hit = match(sets);
  if (!hit && store.cacheAge('ppt.sets') > 6 * store.HOUR) { sets = await pptSets(true); hit = match(sets); }
  return hit;
}

/* ---------------- card matching ---------------- */

const cardNo = c => leadNumber(c.cardNumber ?? c.number ?? c.collectorNumber ?? c.localId ?? '');
const cardTcgId = c => c.tcgPlayerId ?? c.tcgplayerId ?? c.productId ?? null;
const cardSetName = c => c.setName ?? c.set?.name ?? c.set ?? '';

async function findPptId(card) {
  const mapKey = 'ppt.map.' + card.id;
  const known = store.get(mapKey);
  if (known) return known;

  const name = card.name;
  const number = String(card.localId);
  const setName = card.set?.name || '';
  const pick = (rows, needSet) => rows.find(c => sameNumber(cardNo(c), number) &&
    (!needSet || sim(bareSet(cardSetName(c)), bareSet(setName)) > 0.8) && sim(c.name || '', name) > 0.55);

  let set = null;
  try { set = await findSet(setName); } catch (e) { if (e.status === 401 || e.status === 403 || e.status === 429) throw e; }

  let hit = null;
  if (set) {
    hit = pick(list(await api('/cards', { setId: set.id, search: name, limit: 6 })));
    if (!hit) hit = pick(list(await api('/cards', { setId: set.id, search: number.replace(/^0+/, ''), limit: 5 })));
  }
  if (!hit) hit = pick(list(await api('/cards', { search: `${name} ${number.replace(/^0+/, '')}`, limit: 8 })), true);
  if (!hit) hit = pick(list(await api('/cards', { search: name, limit: 15 })), true);
  if (!hit) return null;

  const id = cardTcgId(hit) ?? hit.id;
  store.set(mapKey, id);
  return id;
}

/* ---------------- parsing the price payload ---------------- */

const num = v => {
  if (v == null) return null;
  if (typeof v === 'object') return num(v.price ?? v.value ?? v.market ?? v.amount);
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};

function pickPrinting(obj, preferred) {
  if (!obj || typeof obj !== 'object') return null;
  if (preferred && obj[preferred]) return preferred;
  const order = ['Holofoil', 'Normal', '1st Edition Holofoil', 'Unlimited Holofoil', 'Reverse Holofoil', '1st Edition', 'Unlimited'];
  return order.find(k => obj[k]) || Object.keys(obj)[0] || null;
}

function seriesFrom(card) {
  const ph = card.priceHistory;
  if (!ph) return { points: [], printing: null };
  const primary = card.prices?.primaryPrinting;
  let s = null, printing = null;
  if (ph.variants && typeof ph.variants === 'object') {
    printing = pickPrinting(ph.variants, primary);
    const byCond = printing ? ph.variants[printing] : null;
    s = byCond && (byCond['Near Mint'] || byCond.nearMint || byCond.NM || byCond[Object.keys(byCond)[0]]);
  }
  if (!s && ph.conditions) s = ph.conditions['Near Mint'] || ph.conditions.nearMint || ph.conditions[Object.keys(ph.conditions)[0]];
  if (!s && Array.isArray(ph)) s = { history: ph };
  if (!s && Array.isArray(ph.history)) s = ph;
  const raw = Array.isArray(s) ? s : (s?.history || []);
  const points = raw.map(p => {
    const date = p.date ?? p.d ?? p.timestamp ?? p.t;
    const t = typeof date === 'number' ? (date < 1e12 ? date * 1000 : date) : Date.parse(date);
    const price = num(p.market ?? p.marketPrice ?? p.price ?? p.value ?? p.p ?? p.avg);
    const volume = p.volume ?? p.v ?? p.sold ?? null;
    return { t, price, volume: volume == null ? null : +volume };
  }).filter(p => Number.isFinite(p.t) && p.price != null).sort((a, b) => a.t - b.t);
  // One point per calendar day (keep the latest).
  const byDay = new Map();
  for (const p of points) byDay.set(new Date(p.t).toISOString().slice(0, 10), p);
  return { points: [...byDay.values()], printing: printing || primary || null };
}

function gradedFrom(card) {
  const sbg = card.ebay?.salesByGrade || card.ebay?.grades || {};
  const listings = Array.isArray(card.ebay?.soldListings) ? card.ebay.soldListings : [];
  const out = {};
  for (const g of [8, 9, 10]) {
    const s = sbg[`psa${g}`] || sbg[`PSA${g}`] || sbg[`psa_${g}`] || sbg[`PSA ${g}`] || sbg[`psa-${g}`] || null;
    const recent = listings
      .filter(l => String(l.gradingCompany || '').toUpperCase() === 'PSA' && +l.grade === g && num(l.price ?? l.soldPrice))
      .sort((a, b) => Date.parse(b.soldDate ?? b.date ?? 0) - Date.parse(a.soldDate ?? a.date ?? 0))[0];
    if (!s && !recent) { out[g] = null; continue; }
    out[g] = {
      price: num(s?.smartMarketPrice) ?? num(s?.marketPrice7Day) ?? num(s?.medianPrice) ?? num(s?.averagePrice ?? s?.avgPrice ?? s?.average) ?? num(recent?.price ?? recent?.soldPrice),
      count: s?.count ?? s?.totalSales ?? null,
      last: recent ? { price: num(recent.price ?? recent.soldPrice), date: recent.soldDate ?? recent.date ?? null } : (num(s?.lastSoldPrice ?? s?.lastSale?.price) ? { price: num(s.lastSoldPrice ?? s.lastSale.price), date: s.lastSoldDate ?? s.lastSale?.date ?? null } : null),
    };
  }
  return out;
}

function normalise(card) {
  const pr = card.prices || {};
  const { points, printing } = seriesFrom(card);
  const variantNM = pr.variants && printing && pr.variants[printing];
  const market = num(pr.market) ?? num(variantNM?.market ?? variantNM) ?? (points.length ? points[points.length - 1].price : null);
  const tcgId = cardTcgId(card);
  return {
    source: 'ppt',
    tcgPlayerId: tcgId,
    url: tcgId ? `https://www.tcgplayer.com/product/${tcgId}` : (card.tcgPlayerUrl || null),
    setName: cardSetName(card) || null,
    rarity: card.rarity || null,
    printing: printing || pr.primaryPrinting || null,
    market,
    low: num(pr.low ?? pr.lowPrice ?? variantNM?.low),
    listings: pr.listings ?? null,
    sellers: pr.sellers ?? null,
    updated: card.lastUpdated || card.updatedAt || pr.lastUpdated || null,
    history: points,
    graded: gradedFrom(card),
    fetchedAt: Date.now(),
  };
}

/* ---------------- public ---------------- */

/** Price data for a TCGdex card object. */
export async function getPrices(card, { force = false } = {}) {
  const key = 'ppt.price.' + card.id;
  if (!getKey()) return fromTcgdex(card);
  if (!force) {
    const c = store.cached(key, PRICE_TTL);
    if (c) return { ...c, cached: true };
  }
  const id = await findPptId(card);
  if (!id) {
    const fb = fromTcgdex(card);
    return { ...fb, note: 'PokemonPriceTracker has no listing for this exact card yet – showing TCGplayer market price only.' };
  }
  const d = await api(`/cards/${encodeURIComponent(id)}`, { includeHistory: 'true', includeEbay: 'true', days: 365 });
  const row = list(d)[0];
  if (!row) throw new HttpError('No price data came back for this card.', 404);
  const out = normalise(row);
  if (out.market == null) {
    const fb = fromTcgdex(card);
    out.market = fb.market;
  }
  store.putCache(key, out);
  return out;
}

/** Free fallback: the TCGplayer prices TCGdex carries. */
export function fromTcgdex(card) {
  const tp = card.pricing?.tcgplayer;
  let variant = null, v = null;
  if (tp) {
    const order = ['holofoil', 'normal', 'unlimited-holofoil', '1st-edition-holofoil', 'reverse-holofoil', 'reverse', 'unlimited', '1st-edition'];
    variant = order.find(k => tp[k] && num(tp[k].marketPrice ?? tp[k].midPrice)) ||
      Object.keys(tp).find(k => tp[k] && typeof tp[k] === 'object' && num(tp[k].marketPrice));
    v = variant ? tp[variant] : null;
  }
  return {
    source: 'tcgdex',
    tcgPlayerId: null,
    url: `https://www.tcgplayer.com/search/pokemon/product?q=${encodeURIComponent(`${card.name} ${card.localId}`)}`,
    printing: variant ? variant.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : null,
    market: num(v?.marketPrice),
    low: num(v?.lowPrice),
    mid: num(v?.midPrice),
    high: num(v?.highPrice),
    updated: tp?.updated || null,
    history: [],
    graded: null,
    fetchedAt: Date.now(),
  };
}

export async function testKey() {
  const d = await api('/sets', { limit: 1 });
  return list(d).length >= 0;
}
