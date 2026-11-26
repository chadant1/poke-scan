// Prices.
//  • Free, no key: TCGplayer Near Mint market price + 1-year daily history,
//    collected nightly from TCGCSV by this repo's GitHub Action (js/market.js).
//  • PSA 8 / 9 / 10 (optional): PokemonPriceTracker's free plan key. Only the
//    graded data is requested (2 credits per card), so 100 free credits ≈ 50 cards a day.
//  • If the free data is unavailable: the TCGplayer price that TCGdex carries.

import { fetchJSON, HttpError } from './net.js';
import * as store from './store.js';
import * as market from './market.js';

const PPT = 'https://www.pokemonpricetracker.com/api/v2';

export const getKey = () => (store.get('pptKey', '') || '').trim();
export const setKey = k => store.set('pptKey', (k || '').trim());

async function ppt(path, params = {}) {
  const key = getKey();
  if (!key) throw new HttpError('No PSA price key set.', 401);
  const qs = new URLSearchParams(params).toString();
  try {
    const { data, headers } = await fetchJSON(`${PPT}${path}${qs ? '?' + qs : ''}`, { headers: { Authorization: `Bearer ${key}` }, timeout: 30000 });
    const rem = headers.get('X-RateLimit-Total-Remaining') ?? headers.get('X-RateLimit-Daily-Remaining');
    if (rem != null) store.set('pptCredits', { n: +rem, t: Date.now() });
    return data;
  } catch (e) {
    if (e.status === 401 || e.status === 403) throw new HttpError('Your PSA price key was not accepted. Check it in Settings.', e.status);
    if (e.status === 429) {
      const b = e.body || {};
      const when = b.resetsAt ? new Date(b.resetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;
      throw new HttpError(b.limitType === 'per_minute'
        ? 'Too many PSA lookups in a minute. Wait a moment and tap Refresh.'
        : `Today's free PSA lookups are used up${when ? ` (resets ${when})` : ''}.`, 429);
    }
    throw e;
  }
}

const list = d => Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : d?.data ? [d.data] : d ? [d] : [];

const num = v => {
  if (v == null) return null;
  if (typeof v === 'object') return num(v.price ?? v.value ?? v.market ?? v.amount);
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};

function gradedFrom(card) {
  const sbg = card?.ebay?.salesByGrade || card?.ebay?.grades || {};
  const listings = Array.isArray(card?.ebay?.soldListings) ? card.ebay.soldListings : [];
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
      last: recent
        ? { price: num(recent.price ?? recent.soldPrice), date: recent.soldDate ?? recent.date ?? null }
        : (num(s?.lastSoldPrice ?? s?.lastSale?.price) ? { price: num(s.lastSoldPrice ?? s.lastSale.price), date: s.lastSoldDate ?? s.lastSale?.date ?? null } : null),
    };
  }
  return out;
}

/** PSA 8/9/10 for a TCGplayer product id (cached 24 h). */
export async function graded(tcgPlayerId, { force = false } = {}) {
  if (!getKey() || !tcgPlayerId) return null;
  const ck = 'ppt.graded.' + tcgPlayerId;
  if (!force) {
    const c = store.cached(ck, store.DAY);
    if (c) return c;
  }
  const d = await ppt(`/cards/${encodeURIComponent(tcgPlayerId)}`, { includeEbay: 'true', limit: 1 });
  const out = gradedFrom(list(d)[0]);
  store.putCache(ck, out);
  return out;
}

/** Everything the card page shows about price. */
export async function getPrices(card, { force = false } = {}) {
  if (force) { store.del('c.mk.card.' + card.id); store.del('c.mk.groups'); }
  let p = null, note = null;
  try {
    const m = await market.lookup(card);
    if (m) p = { source: 'tcgcsv', ...m };
    else note = 'This card isn’t in the daily TCGplayer price data yet, so there is no history. Showing the current market price.';
  } catch (e) {
    note = e.status === 404
      ? 'The free price history is still being collected for the first time (this takes up to an hour after setup). Showing the current market price.'
      : 'The price history could not be loaded right now. Showing the current market price.';
  }
  if (!p) p = { ...fromTcgdex(card), note };
  if (p.market == null) {
    const fb = fromTcgdex(card);
    if (fb.market != null) { p.market = fb.market; p.printing = p.printing || fb.printing; }
  }

  p.graded = null;
  p.gradedError = null;
  if (getKey() && p.productId) {
    try { p.graded = await graded(p.productId, { force }); }
    catch (e) { p.gradedError = e.message; }
  }
  p.fetchedAt = Date.now();
  return p;
}

/** Current TCGplayer prices that TCGdex carries (no history). */
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
    productId: null,
    url: `https://www.tcgplayer.com/search/pokemon/product?q=${encodeURIComponent(`${card.name} ${card.localId}`)}`,
    printing: variant ? variant.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : null,
    market: num(v?.marketPrice),
    low: num(v?.lowPrice),
    mid: num(v?.midPrice),
    high: num(v?.highPrice),
    updated: tp?.updated || null,
    history: [],
    others: [],
  };
}

export async function testKey() {
  await ppt('/sets', { limit: 1 });
  return true;
}
