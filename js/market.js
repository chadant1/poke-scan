// Free TCGplayer prices + 1-year history, collected daily from TCGCSV by this
// repo's GitHub Action and published on the `data` branch.

import { fetchJSON } from './net.js';
import * as store from './store.js';
import { norm, sim, sameNumber, leadNumber } from './parse.js';

export const DATA_BASE = 'https://raw.githubusercontent.com/chadant1/poke-scan/data';
const DAY = 864e5;
const EPOCH = Date.UTC(2024, 0, 1);

async function groups() {
  const c = store.cached('mk.groups', 6 * store.HOUR);
  if (c) return c;
  const { data } = await fetchJSON(`${DATA_BASE}/groups.json`);
  store.putCache('mk.groups', data);
  return data;
}

const mem = new Map();
async function group(id) {
  if (mem.has(id)) return mem.get(id);
  const { data } = await fetchJSON(`${DATA_BASE}/g/${id}.json`);
  mem.set(id, data);
  if (mem.size > 6) mem.delete(mem.keys().next().value);
  return data;
}

// "ME04: Chaos Rising" -> "chaos rising";  "SV: Scarlet & Violet 151" -> "scarlet violet 151"
const bare = s => norm(String(s || '').replace(/^[^:]{1,12}:\s*/, ''));
const SUBSET = /trainer gallery|galarian gallery|shiny vault|radiant collection|classic collection|promo|prize pack|jumbo|deck exclusives|league/i;

function rankGroups(list, setName, number) {
  const want = bare(setName);
  const wantSubset = /^(TG|GG|RC|SV)\d/i.test(String(number)) ? true : false;
  return list.map(g => {
    const b = bare(g.name);
    let s = b === want ? 1 : sim(b, want);
    if (s < 1 && want.length >= 3 && (b.startsWith(want) || b.endsWith(want) || want.endsWith(b))) s = Math.max(s, 0.88);
    if (s < 1 && want.length >= 4 && b.includes(want)) s = Math.max(s, 0.8);
    const subset = SUBSET.test(g.name);
    if (subset && !wantSubset && !/promo/i.test(setName)) s -= 0.15;
    if (wantSubset && subset) s += 0.1;
    return { g, s };
  }).filter(x => x.s >= 0.6).sort((a, b) => b.s - a.s);
}

const cleanProductName = n => String(n || '').replace(/\s*-\s*[A-Za-z]*\d+[a-z]?\s*\/\s*[A-Za-z]*\d+.*$/, '').replace(/\s*\(.*?\)\s*/g, ' ').trim();

function findProduct(g, name, number) {
  let best = null, bestS = 0;
  for (const [pid, pname, pnum, rarity] of g.products) {
    if (!sameNumber(leadNumber(pnum), number)) continue;
    const s = sim(cleanProductName(pname), name);
    if (s > bestS) { best = { id: pid, name: pname, number: pnum, rarity }; bestS = s; }
  }
  return bestS >= 0.45 ? best : null;
}

const PRINT_ORDER = ['Holofoil', 'Normal', '1st Edition Holofoil', 'Unlimited Holofoil', '1st Edition Normal', 'Unlimited', 'Reverse Holofoil'];

function expand(h, endDay) {
  // One point per day. In the last 120 days the data is daily and stored only
  // when the price changes, so a gap means "unchanged" (step). Older data is
  // sampled weekly, so there we draw a straight line between the samples.
  if (!h || !h.length) return [];
  const dailyFrom = endDay - 120;
  const out = [];
  for (let i = 0; i < h.length; i++) {
    const [d0, c0] = h[i];
    const next = h[i + 1];
    const d1 = next ? next[0] : endDay + 1;
    const gap = d1 - d0;
    for (let d = d0; d < d1 && d <= endDay; d++) {
      const v = next && gap >= 6 && d1 <= dailyFrom ? c0 + (next[1] - c0) * (d - d0) / gap : c0;
      out.push({ t: EPOCH + d * DAY + DAY / 2, price: Math.round(v) / 100, volume: null });
    }
  }
  return out;
}

/**
 * Prices for a TCGdex card: { productId, url, setName, printing, market, low, history, others, updated }
 * or null if the card isn't in the data.
 */
export async function lookup(card) {
  const ck = 'mk.card.' + card.id;
  const withHistory = o => ({ ...o, history: expand(o.h, o.endDay).slice(-366) });
  const c = store.cached(ck, 6 * store.HOUR);
  if (c) return withHistory(c);

  const gl = await groups();
  const ranked = rankGroups(gl.groups || [], card.set?.name || '', card.localId).slice(0, 4);
  let g = null, prod = null;
  for (const { g: cand } of ranked) {
    const full = await group(cand.id).catch(() => null);
    if (!full) continue;
    prod = findProduct(full, card.name, card.localId);
    if (prod) { g = full; break; }
  }
  if (!prod) return null;

  const subs = g.prices[String(prod.id)] || {};
  const keys = Object.keys(subs);
  const main = PRINT_ORDER.find(k => subs[k] && subs[k].m != null) || keys.find(k => subs[k].m != null) || keys[0];
  const endDay = gl.meta?.lastDay ?? Math.floor((Date.now() - EPOCH) / DAY);
  const pick = subs[main] || {};
  const out = {
    productId: prod.id,
    url: `https://www.tcgplayer.com/product/${prod.id}`,
    setName: g.name,
    productName: prod.name,
    printing: main || null,
    market: pick.m ?? null,
    low: pick.l ?? null,
    h: pick.h || [],
    endDay,
    others: keys.filter(k => k !== main && subs[k].m != null).map(k => ({ printing: k, market: subs[k].m, low: subs[k].l })),
    updated: gl.meta?.updated || null,
  };
  store.putCache(ck, out); // compact form; expanded on the way out
  return withHistory(out);
}
