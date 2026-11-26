// Turn what the scanner read (name, number, set code) into an exact card + set.

import * as tcgdex from './tcgdex.js';
import { nameInText, sameNumber, keywords, sim } from './parse.js';

/**
 * @param {{name?:string, number?:{number:string,total:string|null,promoSet?:string}, setCodes?:string[], text?:string}} r
 * @returns {Promise<{candidates: Array, best: object|null, sure: boolean}>}
 */
export async function identify(r) {
  const sets = await tcgdex.getSets();
  const setById = new Map(sets.map(s => [s.id, s]));
  const text = [r.name, r.text].filter(Boolean).join('\n');
  const found = new Map(); // card id -> candidate

  const add = (brief, set, how) => {
    if (found.has(brief.id)) return;
    const nameScore = text.trim() ? Math.max(nameInText(brief.name, r.name || ''), nameInText(brief.name, text) * 0.9) : 0.5;
    const numberOk = r.number ? sameNumber(brief.localId, r.number.number) : false;
    let score = nameScore * 0.7 + (numberOk ? 0.3 : 0);
    const codeHit = set?.abbreviation && (r.setCodes || []).includes(String(set.abbreviation).toUpperCase());
    if (codeHit) score += 0.1;
    found.set(brief.id, {
      id: brief.id,
      name: brief.name,
      localId: brief.localId,
      image: brief.image,
      setId: set?.id || tcgdex.setIdOf(brief.id),
      setName: set?.name || setById.get(tcgdex.setIdOf(brief.id))?.name || '',
      setOrder: setById.get(set?.id || tcgdex.setIdOf(brief.id))?.order ?? -1,
      official: set?.official ?? setById.get(tcgdex.setIdOf(brief.id))?.official ?? null,
      nameScore, numberOk, codeHit: !!codeHit, score, how,
    });
  };

  // 1) Number + printed set size -> the sets that have that many cards -> the card at that number.
  if (r.number) {
    let candSets = [];
    if (r.number.promoSet) {
      candSets = sets.filter(s => s.id === r.number.promoSet);
    } else if (r.number.total) {
      const tot = parseInt(String(r.number.total).replace(/^[A-Z]+/, ''), 10);
      const prefix = String(r.number.total).match(/^[A-Z]+/)?.[0];
      candSets = sets.filter(s => s.official === tot);
      if (prefix) {
        // Trainer Gallery / Galarian Gallery subsets: "TG12/TG30".
        candSets = sets.filter(s => s.official === tot && /tg|gg|sv|rc/i.test(s.id)).concat(candSets);
      }
    }
    candSets = candSets.sort((a, b) => b.order - a.order).slice(0, 10);
    const full = await Promise.all(candSets.map(s => tcgdex.getSet(s.id).catch(() => null)));
    for (const set of full) {
      if (!set) continue;
      for (const c of set.cards) {
        if (sameNumber(c.localId, r.number.number)) add(c, set, 'number');
      }
    }
  }

  // 2) Name words -> database search (also catches a misread number).
  const strongNumberHit = [...found.values()].some(c => c.nameScore >= 0.7);
  if (!strongNumberHit) {
    const words = keywords(r.name || '', 2);
    if (words.length < 2) keywords(r.text || '', 3).forEach(w => { if (!words.includes(w)) words.push(w); });
    for (const w of words.slice(0, 3)) {
      let list = [];
      try { list = await tcgdex.searchByName(w); } catch (e) { continue; }
      if (list.length > 400) list = list.filter(c => sim(c.name, r.name || w) > 0.35);
      const sameNo = r.number ? list.filter(c => sameNumber(c.localId, r.number.number)) : [];
      // If some results carry the scanned number keep just those; otherwise the number was probably misread.
      for (const c of (sameNo.length ? sameNo : list.slice(0, 120))) add(c, null, 'name');
    }
  }

  let candidates = [...found.values()];
  candidates.sort((a, b) => b.score - a.score || b.setOrder - a.setOrder);
  candidates = candidates.slice(0, 40);

  const best = candidates[0] || null;
  const second = candidates[1];
  const sure = !!best && (
    (best.numberOk && best.nameScore >= 0.72 && (!second || best.score - second.score >= 0.08)) ||
    (best.numberOk && candidates.filter(c => c.numberOk).length === 1 && best.nameScore >= 0.45) ||
    (best.numberOk && best.codeHit && best.nameScore >= 0.5)
  );
  return { candidates, best, sure };
}

/** Manual lookup: name (and optional number). */
export async function lookup(name, number) {
  const n = (number || '').trim();
  const r = { name, text: name, number: n ? { number: n.split('/')[0], total: n.split('/')[1] || null } : null, setCodes: [] };
  const list = await tcgdex.searchByName(name.trim());
  const sets = await tcgdex.getSets();
  const order = new Map(sets.map(s => [s.id, s]));
  let out = list.map(c => {
    const set = order.get(tcgdex.setIdOf(c.id));
    return {
      id: c.id, name: c.name, localId: c.localId, image: c.image,
      setId: set?.id || tcgdex.setIdOf(c.id), setName: set?.name || '', setOrder: set?.order ?? -1, official: set?.official ?? null,
      numberOk: r.number ? sameNumber(c.localId, r.number.number) : false,
    };
  });
  if (r.number) {
    const exact = out.filter(c => c.numberOk);
    if (exact.length) out = exact;
  }
  out.sort((a, b) => (b.numberOk - a.numberOk) || (b.setOrder - a.setOrder));
  return out.slice(0, 80);
}
