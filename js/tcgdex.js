// TCGdex – free, open Pokémon card database (https://tcgdex.dev). Used to
// identify the card and its set, and for card details and images.

import { fetchJSON } from './net.js';
import * as store from './store.js';

const BASE = 'https://api.tcgdex.net/v2/en';

export async function getSets({ force = false } = {}) {
  if (!force) {
    const c = store.cached('tcgdex.sets', store.DAY);
    if (c) return c;
  }
  const { data } = await fetchJSON(`${BASE}/sets`);
  const sets = (Array.isArray(data) ? data : []).map((s, i) => ({
    id: s.id,
    name: s.name,
    logo: s.logo || null,
    symbol: s.symbol || null,
    official: s.cardCount?.official ?? null,
    total: s.cardCount?.total ?? null,
    order: i, // the list is in release order – later = newer
  }));
  store.putCache('tcgdex.sets', sets);
  return sets;
}

const setMem = new Map();
export async function getSet(id) {
  if (setMem.has(id)) return setMem.get(id);
  const c = store.cached('tcgdex.set.' + id, 3 * store.DAY);
  if (c) { setMem.set(id, c); return c; }
  const { data } = await fetchJSON(`${BASE}/sets/${encodeURIComponent(id)}`);
  const slim = {
    id: data.id,
    name: data.name,
    logo: data.logo || null,
    symbol: data.symbol || null,
    official: data.cardCount?.official ?? null,
    total: data.cardCount?.total ?? null,
    releaseDate: data.releaseDate || null,
    abbreviation: data.abbreviation?.official || data.tcgOnline || null,
    serie: data.serie?.name || null,
    cards: (data.cards || []).map(c => ({ id: c.id, localId: String(c.localId), name: c.name, image: c.image || null })),
  };
  store.putCache('tcgdex.set.' + id, slim);
  setMem.set(id, slim);
  return slim;
}

export async function getCard(id) {
  const c = store.cached('tcgdex.card.' + id, 12 * store.HOUR);
  if (c) return c;
  const { data } = await fetchJSON(`${BASE}/cards/${encodeURIComponent(id)}`);
  store.putCache('tcgdex.card.' + id, data);
  return data;
}

/** Cards whose name contains `name` (case-insensitive). Returns briefs. */
export async function searchByName(name) {
  const q = name.trim();
  if (!q) return [];
  const key = 'tcgdex.search.' + q.toLowerCase();
  const c = store.cached(key, store.DAY);
  if (c) return c;
  const { data } = await fetchJSON(`${BASE}/cards?name=${encodeURIComponent(q)}`);
  const list = (Array.isArray(data) ? data : []).map(c => ({ id: c.id, localId: String(c.localId), name: c.name, image: c.image || null }));
  store.putCache(key, list);
  return list;
}

/** Set id from a card id: "sv03.5-151" -> "sv03.5", "me04-116" -> "me04". */
export function setIdOf(cardId) {
  const i = String(cardId).lastIndexOf('-');
  return i > 0 ? cardId.slice(0, i) : cardId;
}

export function img(base, quality = 'high') {
  return base ? `${base}/${quality}.webp` : 'icons/card-back.svg';
}
export function setImg(base) {
  return base ? `${base}.webp` : '';
}
