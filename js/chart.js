// Price-history chart: daily Near Mint market price (line) with copies sold
// underneath in its own strip (one y-axis per plot – no dual axis).
// Touch / hover shows a crosshair with the day's price and sales.

const NS = 'http://www.w3.org/2000/svg';
const DAY = 864e5;
const money = (v, dec) => v == null ? '–' : '$' + v.toLocaleString('en-US', { minimumFractionDigits: dec ?? (v >= 1000 ? 0 : 2), maximumFractionDigits: dec ?? (v >= 1000 ? 0 : 2) });
const fmtDay = t => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

function niceTicks(min, max, count = 4) {
  if (min === max) { min = min * 0.9; max = max * 1.1 || 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= step0) || 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(6));
  return { lo, hi, ticks };
}

export function sliceRange(points, days) {
  if (!points.length) return [];
  const end = points[points.length - 1].t;
  return points.filter(p => p.t >= end - days * DAY);
}

export function stats(points) {
  if (!points.length) return null;
  const prices = points.map(p => p.price);
  const vols = points.filter(p => p.volume != null);
  const totalSold = vols.reduce((s, p) => s + p.volume, 0);
  const days = Math.max(1, Math.round((points[points.length - 1].t - points[0].t) / DAY) + 1);
  return {
    low: Math.min(...prices),
    high: Math.max(...prices),
    first: prices[0],
    last: prices[prices.length - 1],
    change: prices[0] ? (prices[prices.length - 1] - prices[0]) / prices[0] : null,
    totalSold: vols.length ? totalSold : null,
    avgDaily: vols.length ? totalSold / days : null,
    days,
  };
}

/**
 * Draw the chart into `box` (a .chart-box element).
 * @param {HTMLElement} box
 * @param {{t:number, price:number, volume:number|null}[]} points  already sliced to the range
 */
export function render(box, points) {
  box.innerHTML = '';
  if (points.length < 2) {
    box.innerHTML = '<p class="muted small">Not enough price history yet for this range.</p>';
    return;
  }
  const W = Math.max(280, Math.round(box.clientWidth || 340));
  const hasVol = points.some(p => p.volume != null && p.volume > 0);
  const padL = 50, padR = 8, padT = 8;
  const priceH = 170, gap = 26, volH = hasVol ? 46 : 0;
  const H = padT + priceH + gap + volH + (hasVol ? 4 : 0);
  const innerW = W - padL - padR;

  const t0 = points[0].t, t1 = points[points.length - 1].t;
  const x = t => padL + (t1 === t0 ? innerW / 2 : (t - t0) / (t1 - t0) * innerW);
  const pmin = Math.min(...points.map(p => p.price));
  const pmax = Math.max(...points.map(p => p.price));
  const yt = niceTicks(pmin, pmax, 4);
  const y = v => padT + priceH - (v - yt.lo) / (yt.hi - yt.lo || 1) * priceH;

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': `Near Mint market price from ${fmtDay(t0)} to ${fmtDay(t1)}` });

  // grid + y labels (price)
  for (const v of yt.ticks) {
    el('line', { class: 'gridline', x1: padL, x2: W - padR, y1: y(v), y2: y(v) }, svg);
    const tx = el('text', { class: 'axis-t', x: padL - 6, y: y(v) + 4, 'text-anchor': 'end' }, svg);
    tx.textContent = money(v, v >= 100 || Number.isInteger(v) ? 0 : 2);
  }

  // x labels
  const spanDays = (t1 - t0) / DAY;
  const xTicks = [];
  if (spanDays > 60) {
    const d = new Date(t0); d.setDate(1); d.setMonth(d.getMonth() + 1);
    const every = spanDays > 200 ? 2 : 1;
    for (let i = 0; d.getTime() <= t1; i++, d.setMonth(d.getMonth() + 1)) if (i % every === 0) xTicks.push(d.getTime());
  } else {
    const n = 4;
    for (let i = 0; i <= n; i++) xTicks.push(t0 + (t1 - t0) * i / n);
  }
  const xLabelY = padT + priceH + 16;
  for (const t of xTicks) {
    const tx = el('text', { class: 'axis-t', x: x(t), y: xLabelY, 'text-anchor': 'middle' }, svg);
    const d = new Date(t);
    tx.textContent = spanDays > 60
      ? d.toLocaleDateString('en-US', { month: 'short' }) + (d.getMonth() === 0 ? " '" + String(d.getFullYear()).slice(2) : '')
      : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // area + line
  const pts = points.map(p => `${x(p.t).toFixed(1)},${y(p.price).toFixed(1)}`);
  el('path', { class: 'area', d: `M${x(t0)},${padT + priceH} L${pts.join(' L')} L${x(t1)},${padT + priceH} Z` }, svg);
  el('path', { class: 'line', d: `M${pts.join(' L')}` }, svg);

  // volume strip (weekly buckets for long ranges so bars stay readable)
  let buckets = [];
  const volTop = padT + priceH + gap;
  if (hasVol) {
    const bucketDays = spanDays > 120 ? 7 : 1;
    const map = new Map();
    for (const p of points) {
      const k = Math.floor((p.t - t0) / (bucketDays * DAY));
      const b = map.get(k) || { k, t: t0 + k * bucketDays * DAY, v: 0 };
      b.v += p.volume || 0;
      map.set(k, b);
    }
    buckets = [...map.values()];
    const vmax = Math.max(1, ...buckets.map(b => b.v));
    const bw = Math.max(1, innerW / Math.max(1, Math.ceil(spanDays / bucketDays) + 1) - 2);
    for (const b of buckets) {
      const h = Math.max(b.v > 0 ? 2 : 0, b.v / vmax * volH);
      const bx = x(b.t + (bucketDays * DAY) / 2) - bw / 2;
      const cx = Math.min(Math.max(padL, bx), W - padR - bw);
      b.el = el('rect', { class: 'vbar', x: cx.toFixed(1), y: (volTop + volH - h).toFixed(1), width: bw.toFixed(1), height: h.toFixed(1), rx: Math.min(2, bw / 2) }, svg);
      b.bucketDays = bucketDays;
    }
    el('line', { class: 'gridline', x1: padL, x2: W - padR, y1: volTop + volH, y2: volTop + volH }, svg);
    const vt = el('text', { class: 'axis-t', x: padL - 6, y: volTop + 10, 'text-anchor': 'end' }, svg);
    vt.textContent = String(Math.round(vmax));
    const vl = el('text', { class: 'axis-t', x: padL - 6, y: volTop + volH, 'text-anchor': 'end' }, svg);
    vl.textContent = '0';
  }

  // crosshair layer
  const xh = el('line', { class: 'xhair', y1: padT, y2: hasVol ? volTop + volH : padT + priceH, visibility: 'hidden' }, svg);
  const dot = el('circle', { class: 'dot', r: 5, visibility: 'hidden' }, svg);
  const hit = el('rect', { x: padL, y: 0, width: innerW, height: H, fill: 'transparent' }, svg);
  box.appendChild(svg);

  const tip = document.createElement('div');
  tip.className = 'tip hidden';
  box.appendChild(tip);

  let lastBar = null;
  const show = clientX => {
    const r = svg.getBoundingClientRect();
    const sx = (clientX - r.left) * (W / r.width);
    const t = t0 + (sx - padL) / innerW * (t1 - t0);
    let best = points[0];
    for (const p of points) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    const px = x(best.t), py = y(best.price);
    xh.setAttribute('x1', px); xh.setAttribute('x2', px); xh.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.setAttribute('visibility', 'visible');
    if (lastBar) lastBar.classList.remove('hi');
    const b = buckets.find(b => best.t >= b.t && best.t < b.t + b.bucketDays * DAY);
    if (b && b.el) { b.el.classList.add('hi'); lastBar = b.el; }
    tip.innerHTML = `<b>${money(best.price)}</b><span>${fmtDay(best.t)}${best.volume != null ? ` · ${best.volume} sold` : ''}</span>`;
    tip.classList.remove('hidden');
    const scale = r.width / W;
    const left = Math.min(Math.max(0, px * scale - tip.offsetWidth / 2), r.width - tip.offsetWidth);
    tip.style.left = left + 'px';
    tip.style.top = Math.max(0, py * scale - tip.offsetHeight - 14) + 'px';
  };
  const hide = () => {
    xh.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden');
    tip.classList.add('hidden');
    if (lastBar) { lastBar.classList.remove('hi'); lastBar = null; }
  };
  hit.addEventListener('pointermove', e => show(e.clientX));
  hit.addEventListener('pointerdown', e => show(e.clientX));
  // On touch the readout stays after lifting the finger; with a mouse it hides on leave.
  hit.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') hide(); });
  hit.addEventListener('pointercancel', hide);
}

export { money, fmtDay };
