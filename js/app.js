import * as store from './store.js';
import * as tcgdex from './tcgdex.js';
import * as ocr from './ocr.js';
import { identify, lookup } from './identify.js';
import * as prices from './prices.js';
import * as chart from './chart.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = chart.money;
const titleCase = s => String(s || '').replace(/\b([a-z])/g, (m, c) => c.toUpperCase());

/* =========================================================
   Theme (System / Light / Dark)
   ========================================================= */
const darkMQ = window.matchMedia('(prefers-color-scheme: dark)');
const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t === 'dark' || (t === 'system' && darkMQ.matches);
};
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('ps.theme', t); } catch (e) {}
  $('#metaTheme').setAttribute('content', isDark() ? '#0f1115' : '#f5f6f8');
  document.querySelectorAll('#themeSeg button').forEach(b => {
    b.classList.toggle('on', b.dataset.v === t);
    b.setAttribute('aria-checked', b.dataset.v === t);
  });
  // Re-draw an open chart so it picks up the new colours.
  if (currentChart) currentChart();
}
darkMQ.addEventListener?.('change', () => applyTheme(document.documentElement.dataset.theme));
$('#themeBtn').addEventListener('click', () => applyTheme(isDark() ? 'light' : 'dark'));
document.querySelectorAll('#themeSeg button').forEach(b => b.addEventListener('click', () => applyTheme(b.dataset.v)));

/* =========================================================
   Toast
   ========================================================= */
let toastTimer;
function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

/* =========================================================
   Routing (hash based so the phone's Back button works)
   ========================================================= */
let currentView = null;
let currentChart = null;
let chooseState = null;

function show(view, title) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('hidden', v.id !== 'view-' + view));
  const tab = { scan: 'scan', choose: 'scan', card: null, search: 'search', history: 'history', settings: 'settings' }[view];
  document.querySelectorAll('#tabbar button').forEach(b => b.classList.toggle('active', b.dataset.view === tab));
  $('#title').textContent = title || $('#view-' + view).dataset.title || 'PokeScan';
  $('#backBtn').classList.toggle('hidden', !['card', 'choose'].includes(view));
  if (view !== 'scan' && currentView === 'scan') camera.pause();
  if (view === 'scan' && camera.wanted) camera.start();
  if (view !== 'card') currentChart = null;
  currentView = view;
  window.scrollTo(0, 0);
}

function route() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const [view, ...rest] = h.split('/');
  const arg = rest.join('/');
  switch (view) {
    case 'card': return arg ? openCard(arg) : show('scan');
    case 'choose': return chooseState ? renderChoose() : (location.hash = '#scan');
    case 'search': return show('search');
    case 'history': renderHistory(); return show('history');
    case 'settings': renderSettings(); return show('settings');
    default: return show('scan');
  }
}
window.addEventListener('hashchange', route);
document.querySelectorAll('#tabbar button').forEach(b => b.addEventListener('click', () => { location.hash = '#' + b.dataset.view; }));
$('#backBtn').addEventListener('click', () => {
  if (history.length > 1) history.back(); else location.hash = '#scan';
});
const go = h => { if (location.hash === h) route(); else location.hash = h; };

/* =========================================================
   Camera
   ========================================================= */
const video = $('#video');
const camera = {
  stream: null,
  track: null,
  wanted: false,
  torch: false,
  async start() {
    this.wanted = true;
    if (this.stream) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      camMsg('This browser cannot open the camera. Use the photo button instead, or open the app over https.', false);
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
      });
    } catch (e) {
      this.stream = null;
      camMsg(e.name === 'NotAllowedError'
        ? 'Camera permission was denied. Allow camera access for this app in your phone settings, then tap Start camera.'
        : 'Could not open the camera (' + esc(e.message || e.name) + ').', true);
      return;
    }
    video.srcObject = this.stream;
    try { await video.play(); } catch (e) {}
    this.track = this.stream.getVideoTracks()[0];
    const caps = this.track.getCapabilities ? this.track.getCapabilities() : {};
    $('#torchBtn').disabled = !caps.torch;
    if (caps.focusMode && caps.focusMode.includes('continuous')) {
      this.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    }
    $('#camMsg').classList.add('hidden');
    $('#scanBtn').disabled = false;
    ocrWarm();
  },
  pause() {
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null; this.track = null; this.torch = false;
    $('#torchBtn').classList.remove('on');
    video.srcObject = null;
    $('#scanBtn').disabled = true;
  },
  async toggleTorch() {
    if (!this.track) return;
    this.torch = !this.torch;
    try { await this.track.applyConstraints({ advanced: [{ torch: this.torch }] }); }
    catch (e) { this.torch = false; toast('Flashlight is not available.'); }
    $('#torchBtn').classList.toggle('on', this.torch);
  },
};
function camMsg(html, showBtn) {
  $('#camMsg').classList.remove('hidden');
  $('#camMsgText').innerHTML = html;
  $('#startCamBtn').classList.toggle('hidden', !showBtn);
}
$('#startCamBtn').addEventListener('click', () => camera.start());
$('#torchBtn').addEventListener('click', () => camera.toggleTorch());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { const w = camera.wanted; camera.pause(); camera.wanted = w; }
  else if (currentView === 'scan' && camera.wanted) camera.start();
});

/** Grab the area inside the on-screen card guide at full camera resolution. */
function grabFrame() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const vr = video.getBoundingClientRect();
  const gr = $('#guide').getBoundingClientRect();
  const scale = Math.max(vr.width / vw, vr.height / vh); // object-fit: cover
  const offX = (vr.width - vw * scale) / 2, offY = (vr.height - vh * scale) / 2;
  let sx = (gr.left - vr.left - offX) / scale, sy = (gr.top - vr.top - offY) / scale;
  let sw = gr.width / scale, sh = gr.height / scale;
  sx = Math.max(0, sx); sy = Math.max(0, sy);
  sw = Math.min(vw - sx, sw); sh = Math.min(vh - sy, sh);
  const c = document.createElement('canvas');
  c.width = Math.round(sw); c.height = Math.round(sh);
  c.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

let ocrReady = false;
function ocrWarm() {
  if (ocrReady) return;
  ocr.warmUp(m => {
    if (busy) return;
    if (m.status && /load|init/i.test(m.status) && m.progress < 1) setStatus(`Preparing text reader… ${Math.round((m.progress || 0) * 100)}%`);
  }).then(() => { ocrReady = true; if (!busy) setStatus(null); })
    .catch(e => { if (!busy) setStatus(null); toast(e.message); });
}

let busy = false;
function setStatus(text) {
  $('#scanStatus').classList.toggle('hidden', !text);
  if (text) $('#scanStatusText').textContent = text;
}

$('#scanBtn').addEventListener('click', async () => {
  if (busy) return;
  const frame = grabFrame();
  if (!frame) return toast('Camera is not ready yet.');
  if (navigator.vibrate) navigator.vibrate(15);
  await runScan(frame, 'frame');
});

$('#photoInput').addEventListener('change', async e => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file || busy) return;
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (err) { return toast('Could not open that picture.'); }
  const max = 2200;
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  if (currentView !== 'scan') go('#scan');
  await runScan(c, 'photo');
});

async function runScan(canvas, mode) {
  busy = true;
  $('#scanBtn').disabled = true;
  setStatus(ocrReady ? 'Reading card…' : 'Preparing text reader…');
  try {
    const r = await ocr.readCard(canvas, { mode, onStep: s => setStatus(s) });
    canvas.width = canvas.height = 0; // the picture is gone from memory now
    ocrReady = true;
    $('#ocrText').textContent =
      `Name: ${r.name || '—'}\nNumber: ${r.number ? r.number.number + (r.number.total ? '/' + r.number.total : '') : '—'}` +
      `${r.setCodes.length ? '\nSet codes: ' + r.setCodes.join(', ') : ''}\n\n— raw —\n${(r.nameText + '\n' + r.bottomText + '\n' + r.fullText).trim()}`;
    if (!r.number && r.name.length < 3) {
      toast('Could not read the card. Move closer, avoid glare and try again.');
      return;
    }
    setStatus('Finding the card…');
    const res = await identify({ name: r.name, number: r.number, setCodes: r.setCodes, text: [r.nameText, r.fullText].join('\n') });
    if (res.sure) {
      go('#card/' + encodeURIComponent(res.best.id));
    } else {
      chooseState = { candidates: res.candidates, read: r };
      go('#choose');
    }
  } catch (e) {
    console.error(e);
    toast(e.message || 'Something went wrong while scanning.');
  } finally {
    canvas.width = canvas.height = 0;
    busy = false;
    setStatus(null);
    $('#scanBtn').disabled = !camera.stream;
  }
}

/* =========================================================
   Choose between possible matches
   ========================================================= */
function tile(c, best) {
  const num = c.localId + (c.official ? '/' + padTotal(c.localId, c.official) : '');
  return `<button class="tile${best ? ' best' : ''}" data-id="${esc(c.id)}">
    <img loading="lazy" src="${esc(tcgdex.img(c.image, 'low'))}" alt="" onerror="this.src='icons/card-back.svg'">
    <b>${esc(c.name)}</b><span>${esc(c.setName)} · ${esc(num)}</span></button>`;
}
function bindTiles(root) {
  root.querySelectorAll('.tile').forEach(t => t.addEventListener('click', () => go('#card/' + encodeURIComponent(t.dataset.id))));
}
function renderChoose() {
  const { candidates, read } = chooseState;
  const r = read || {};
  const what = [r.name && `“${r.name}”`, r.number && `#${r.number.number}${r.number.total ? '/' + r.number.total : ''}`].filter(Boolean).join(' ');
  $('#chooseLead').innerHTML = candidates.length
    ? `I read ${esc(what || 'the card')}. Tap the matching card:`
    : `I read ${esc(what || 'nothing clear')} but couldn't find a match. Try scanning again or type it below.`;
  const g = $('#chooseGrid');
  g.innerHTML = candidates.slice(0, 30).map((c, i) => tile(c, i === 0 && candidates.length > 1)).join('');
  bindTiles(g);
  $('#manualName').value = r.name || '';
  $('#manualNum').value = r.number ? r.number.number : '';
  show('choose');
}
$('#manualForm').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('#manualName').value.trim();
  if (!name) return;
  try {
    const list = await lookup(name, $('#manualNum').value);
    chooseState = { candidates: list, read: { name, number: $('#manualNum').value ? { number: $('#manualNum').value } : null } };
    renderChoose();
  } catch (err) { toast(err.message); }
});

/* =========================================================
   Search
   ========================================================= */
$('#searchForm').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('#searchName').value.trim();
  if (!name) return;
  $('#searchInfo').innerHTML = '<span class="loading"><span class="spinner dark"></span>Searching…</span>';
  $('#searchGrid').innerHTML = '';
  try {
    const list = await lookup(name, $('#searchNum').value);
    $('#searchInfo').textContent = list.length ? `${list.length}${list.length === 80 ? '+' : ''} cards, newest sets first.` : 'No cards found. Check the spelling.';
    $('#searchGrid').innerHTML = list.map(c => tile(c, false)).join('');
    bindTiles($('#searchGrid'));
  } catch (err) {
    $('#searchInfo').textContent = err.message;
  }
});

/* =========================================================
   Card details + prices
   ========================================================= */
const ENERGY = { Grass: 'G', Fire: 'R', Water: 'W', Lightning: 'L', Psychic: 'P', Fighting: 'F', Darkness: 'D', Metal: 'M', Fairy: 'Y', Dragon: 'N', Colorless: 'C' };
const energy = list => (list || []).map(t => `<span class="energy" title="${esc(t)}">${esc(ENERGY[t] || t)}</span>`).join('');
const padTotal = (localId, official) => {
  const l = String(localId);
  return /^\d+$/.test(l) ? String(official).padStart(l.length, '0') : String(official);
};
const pct = v => (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
const arrow = up => up
  ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>'
  : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg>';
const when = t => {
  if (!t) return '';
  const d = new Date(t);
  return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

let cardToken = 0;
async function openCard(id) {
  const token = ++cardToken;
  const v = $('#view-card');
  v.innerHTML = '<div class="loading"><span class="spinner dark"></span>Loading card…</div>';
  show('card', 'Card');
  let card, set;
  try {
    card = await tcgdex.getCard(id);
    set = await tcgdex.getSet(card.set?.id || tcgdex.setIdOf(id)).catch(() => null);
  } catch (e) {
    if (token !== cardToken) return;
    v.innerHTML = `<div class="notice">Could not load this card: ${esc(e.message)}</div><button class="btn" id="retryCard">Try again</button>`;
    $('#retryCard').onclick = () => openCard(id);
    return;
  }
  if (token !== cardToken) return;
  $('#title').textContent = card.name;

  const official = card.set?.cardCount?.official ?? set?.official;
  const numberStr = card.localId + (official ? '/' + padTotal(card.localId, official) : '');
  const setLabel = (set?.abbreviation ? set.abbreviation + ': ' : '') + (card.set?.name || set?.name || '');

  v.innerHTML = `
    <div class="card-head">
      <img src="${esc(tcgdex.img(card.image))}" alt="${esc(card.name)}" onerror="this.onerror=null;this.src='${esc(card.image ? card.image + '/high.png' : 'icons/card-back.svg')}'">
      <div>
        <h2>${esc(card.name)} – ${esc(numberStr)}</h2>
        <div class="setline">${card.set?.symbol ? `<img src="${esc(tcgdex.setImg(card.set.symbol))}" alt="" onerror="this.remove()">` : ''}<span id="setLabel">${esc(setLabel)}</span></div>
        <div class="chips">
          ${card.rarity ? `<span class="chip">${esc(titleCase(card.rarity))}</span>` : ''}
          ${set?.releaseDate ? `<span class="chip">Released ${esc(when(set.releaseDate + 'T12:00:00'))}</span>` : ''}
          ${set?.serie ? `<span class="chip">${esc(set.serie)}</span>` : ''}
        </div>
      </div>
    </div>
    <div id="priceArea"><div class="panel"><div class="loading"><span class="spinner dark"></span>Getting TCGplayer prices…</div></div></div>
    <div class="panel details-text">
      <h3>Product details</h3>
      ${detailsHTML(card, numberStr)}
    </div>
    <div class="actions">
      <button class="btn primary" id="scanAnother">Scan another card</button>
    </div>`;
  $('#scanAnother').onclick = () => go('#scan');

  addHistory(card, numberStr, null);
  loadPrices(card, numberStr, token, false);
}

function detailsHTML(c, numberStr) {
  const rows = [];
  rows.push(`<p><b>Card Number / Rarity:</b> ${esc(numberStr)}${c.rarity ? ' / ' + esc(titleCase(c.rarity)) : ''}</p>`);
  if (c.category === 'Pokemon') {
    rows.push(`<p><b>Card Type / HP / Stage:</b> ${esc((c.types || []).join(', ') || '–')} / ${esc(c.hp ?? '–')} / ${esc((c.stage || '–').replace(/^Stage(\d)$/, 'Stage $1'))}</p>`);
    if (c.evolveFrom) rows.push(`<p><b>Evolves from:</b> ${esc(c.evolveFrom)}</p>`);
    for (const a of c.abilities || []) rows.push(`<p><b>${esc(a.type || 'Ability')}: ${esc(a.name)}</b> ${esc(a.effect || '')}</p>`);
    (c.attacks || []).forEach((a, i) => rows.push(`<p><b>Attack ${i + 1}:</b> ${energy(a.cost)} <b>${esc(a.name)}</b>${a.damage ? ' (' + esc(a.damage) + ')' : ''}${a.effect ? '<br>' + esc(a.effect) : ''}</p>`));
    const wk = (c.weaknesses || []).map(w => `${w.type} ${w.value || ''}`.trim()).join(', ') || '–';
    const rs = (c.resistances || []).map(w => `${w.type} ${w.value || ''}`.trim()).join(', ') || '–';
    rows.push(`<p><b>Weakness / Resistance / Retreat Cost:</b> ${esc(wk)} / ${esc(rs)} / ${esc(c.retreat ?? '–')}</p>`);
  } else {
    rows.push(`<p><b>Card Type:</b> ${esc(c.category || '')}${c.trainerType ? ' – ' + esc(c.trainerType) : ''}${c.energyType ? ' – ' + esc(c.energyType) : ''}</p>`);
    if (c.effect) rows.push(`<p><b>Card Text:</b> ${esc(c.effect)}</p>`);
  }
  if (c.illustrator) rows.push(`<p><b>Artist:</b> ${esc(c.illustrator)}</p>`);
  if (c.regulationMark) rows.push(`<p><b>Regulation Mark:</b> ${esc(c.regulationMark)}</p>`);
  return rows.join('');
}

async function loadPrices(card, numberStr, token, force) {
  const area = $('#priceArea');
  if (force) area.innerHTML = '<div class="panel"><div class="loading"><span class="spinner dark"></span>Refreshing prices…</div></div>';
  let p;
  try {
    p = await prices.getPrices(card, { force });
  } catch (e) {
    if (token !== cardToken) return;
    const fb = prices.fromTcgdex(card);
    area.innerHTML = `<div class="notice">${esc(e.message)}</div>` + priceHTML(card, fb, numberStr);
    wirePriceArea(card, fb, numberStr, token);
    return;
  }
  if (token !== cardToken) return;
  if (p.setName) $('#setLabel').textContent = p.setName;
  area.innerHTML = (p.note ? `<div class="notice">${esc(p.note)}</div>` : '') + priceHTML(card, p, numberStr);
  wirePriceArea(card, p, numberStr, token);
  addHistory(card, numberStr, p.market);
}

function priceHTML(card, p, numberStr) {
  const s1y = chart.stats(p.history || []);
  const delta = s1y && s1y.change != null
    ? `<span class="delta ${s1y.change >= 0 ? 'up' : 'down'}">${arrow(s1y.change >= 0)}${pct(s1y.change)} <span class="muted small">(${s1y.days >= 330 ? '1Y' : s1y.days + 'd'})</span></span>` : '';
  const last = p.history?.length ? p.history[p.history.length - 1] : null;
  const noKey = p.source === 'tcgdex';
  const q = encodeURIComponent(`${card.name} ${numberStr}`);

  let html = `
  <div class="panel">
    <div class="price-hero">
      <div>
        <div class="label">TCGplayer market price · Near Mint${p.printing ? ' ' + esc(p.printing) : ''}</div>
        <div class="big">${money(p.market)}</div>
      </div>
      ${delta}
    </div>
    <dl class="kv" style="margin-top:10px">
      ${last ? `<dt>Latest daily price</dt><dd>${money(last.price)} <span class="muted small">${esc(when(last.t))}</span></dd>` : ''}
      ${p.low != null ? `<dt>${noKey ? 'Low listing' : 'Lowest listing'}</dt><dd>${money(p.low)}</dd>` : ''}
      ${p.mid != null ? `<dt>Mid listing</dt><dd>${money(p.mid)}</dd>` : ''}
      ${p.high != null ? `<dt>High listing</dt><dd>${money(p.high)}</dd>` : ''}
      ${p.listings != null ? `<dt>Current listings</dt><dd>${esc(p.listings)}</dd>` : ''}
      ${p.sellers != null ? `<dt>Current sellers</dt><dd>${esc(p.sellers)}</dd>` : ''}
      ${p.updated ? `<dt>Price updated</dt><dd>${esc(when(p.updated))}</dd>` : ''}
    </dl>
    <div class="actions">
      <a class="btn" href="${esc(p.url)}" target="_blank" rel="noopener">View on TCGplayer</a>
      ${noKey ? '' : '<button class="btn ghost" id="refreshPrices">Refresh</button>'}
    </div>
    ${p.cached ? `<p class="small muted" style="margin:8px 0 0">Saved ${esc(ago(p.fetchedAt))} – tap Refresh for the newest data.</p>` : ''}
  </div>`;

  if (noKey) {
    html += `<div class="notice">Add your free <a href="#settings">PokemonPriceTracker key in Settings</a> to see the 1-year price graph and PSA 8 / 9 / 10 prices.</div>`;
    if (p.market == null) html += `<div class="notice">No TCGplayer price is listed for this card yet.</div>`;
    return html;
  }

  // Price history
  html += `
  <div class="panel">
    <div class="chart-head">
      <h3 style="margin:0">Market price history <small>Near Mint</small></h3>
      <div class="ranges" role="tablist">
        <button data-d="30">1M</button><button data-d="91">3M</button><button data-d="182">6M</button><button data-d="366" class="on">1Y</button>
      </div>
    </div>
    <div class="chart-box" id="chartBox"></div>
    <p class="chart-sub" id="chartSub"></p>
    <details class="table-toggle"><summary>Show as a table</summary><div class="table-wrap" id="chartTable"></div></details>
  </div>`;

  // 1-year snapshot
  if (s1y) {
    html += `
    <div class="panel">
      <h3>1 year snapshot <small>${esc(when(p.history[0].t))} – ${esc(when(last.t))}</small></h3>
      <dl class="kv">
        <dt>Low market price</dt><dd>${money(s1y.low)}</dd>
        <dt>High market price</dt><dd>${money(s1y.high)}</dd>
        ${s1y.totalSold != null ? `<dt>Total sold (NM)</dt><dd>${s1y.totalSold.toLocaleString()}</dd>
        <dt>Avg. daily sold</dt><dd>${s1y.avgDaily < 10 ? s1y.avgDaily.toFixed(1) : Math.round(s1y.avgDaily)}</dd>` : ''}
      </dl>
    </div>`;
  }

  // Graded
  const g = p.graded || {};
  const gradeTile = n => {
    const d = g[n];
    const ebay = `https://www.ebay.com/sch/i.html?_nkw=${q}+PSA+${n}&LH_Sold=1&LH_Complete=1`;
    return `<a class="grade" href="${esc(ebay)}" target="_blank" rel="noopener" style="text-decoration:none;color:inherit">
      <div class="g">PSA ${n}</div>
      <div class="p">${d && d.price ? money(d.price) : '–'}</div>
      <div class="n">${d && d.last ? 'Last sale ' + money(d.last.price) + (d.last.date ? ' · ' + esc(when(d.last.date)) : '') : d && d.count ? esc(d.count) + ' sale' + (d.count == 1 ? '' : 's') : 'No recent sales'}</div>
    </a>`;
  };
  html += `
  <div class="panel">
    <h3>Graded prices <small>recent eBay &amp; Fanatics sales</small></h3>
    <div class="graded">${gradeTile(8)}${gradeTile(9)}${gradeTile(10)}</div>
    <p class="small muted" style="margin:8px 0 0">Market value from recent sold graded copies. Tap a grade to see sold listings on eBay.</p>
  </div>`;
  return html;
}

function wirePriceArea(card, p, numberStr, token) {
  const rb = $('#refreshPrices');
  if (rb) rb.onclick = () => loadPrices(card, numberStr, token, true);
  const box = $('#chartBox');
  if (!box || !p.history?.length) {
    if (box) box.innerHTML = '<p class="muted small">No price history is available for this card yet.</p>';
    return;
  }
  let days = 366;
  const draw = () => {
    const pts = chart.sliceRange(p.history, days);
    chart.render(box, pts);
    const st = chart.stats(pts);
    $('#chartSub').innerHTML = st
      ? `Range ${money(st.low)} – ${money(st.high)} · <span class="delta ${st.change >= 0 ? 'up' : 'down'}" style="font-size:11px">${arrow(st.change >= 0)}${pct(st.change)}</span>${st.totalSold != null ? ` · ${st.totalSold.toLocaleString()} sold` : ''}. Bars show copies sold${pts.length && (pts[pts.length - 1].t - pts[0].t) / 864e5 > 120 ? ' per week' : ' per day'}.`
      : '';
    $('#chartTable').innerHTML = `<table><thead><tr><th>Date</th><th>Market</th><th>Sold</th></tr></thead><tbody>${
      pts.slice().reverse().map(x => `<tr><td>${esc(when(x.t))}</td><td>${money(x.price)}</td><td>${x.volume ?? '–'}</td></tr>`).join('')}</tbody></table>`;
  };
  document.querySelectorAll('.ranges button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.ranges button').forEach(x => x.classList.toggle('on', x === b));
    days = +b.dataset.d;
    draw();
  }));
  currentChart = draw;
  draw();
}
let resizeT;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => currentChart && currentChart(), 150); });

function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  return h + ' hour' + (h === 1 ? '' : 's') + ' ago';
}

/* =========================================================
   Recent scans (no pictures – just ids, names and prices)
   ========================================================= */
function addHistory(card, numberStr, price) {
  const list = store.get('history', []).filter(h => h.id !== card.id);
  const prev = store.get('history', []).find(h => h.id === card.id);
  list.unshift({
    id: card.id, name: card.name, number: numberStr, set: card.set?.name || '',
    image: card.image || null, price: price ?? prev?.price ?? null, t: Date.now(),
  });
  store.set('history', list.slice(0, 100));
}
function renderHistory() {
  const list = store.get('history', []);
  const root = $('#historyList');
  if (!list.length) { root.innerHTML = '<p class="empty">Cards you scan will show up here.</p>'; return; }
  const total = list.reduce((s, h) => s + (h.price || 0), 0);
  root.innerHTML = `<p class="small muted">${list.length} card${list.length === 1 ? '' : 's'} · combined NM value ${money(total)}</p>` +
    list.map(h => `<button class="item" data-id="${esc(h.id)}">
      <img loading="lazy" src="${esc(tcgdex.img(h.image, 'low'))}" alt="" onerror="this.src='icons/card-back.svg'">
      <div><b>${esc(h.name)}</b><span>${esc(h.set)} · ${esc(h.number)}</span></div>
      <div class="v">${money(h.price)}</div></button>`).join('');
  root.querySelectorAll('.item').forEach(b => b.addEventListener('click', () => go('#card/' + encodeURIComponent(b.dataset.id))));
}

/* =========================================================
   Settings
   ========================================================= */
function renderSettings() {
  $('#apiKey').value = prices.getKey();
  const c = store.get('pptCredits');
  $('#keyStatus').textContent = prices.getKey()
    ? (c ? `Key saved. ${c.n.toLocaleString()} credits left (as of ${ago(c.t)}).` : 'Key saved.')
    : 'No key yet – the app will show TCGplayer market prices only.';
  $('#cacheInfo').textContent = `Using about ${Math.round(store.cacheBytes() / 1024)} KB on this phone.`;
  applyTheme(document.documentElement.dataset.theme);
}
$('#saveKey').addEventListener('click', () => {
  prices.setKey($('#apiKey').value);
  store.clearCache();
  renderSettings();
  toast(prices.getKey() ? 'Key saved.' : 'Key removed.');
});
$('#toggleKey').addEventListener('click', () => {
  const i = $('#apiKey');
  i.type = i.type === 'password' ? 'text' : 'password';
  $('#toggleKey').textContent = i.type === 'password' ? 'Show' : 'Hide';
});
$('#testKey').addEventListener('click', async () => {
  prices.setKey($('#apiKey').value);
  if (!prices.getKey()) return toast('Paste a key first.');
  $('#keyStatus').textContent = 'Testing…';
  try { await prices.testKey(); renderSettings(); toast('The key works.'); }
  catch (e) { $('#keyStatus').textContent = e.message; }
});
$('#clearCache').addEventListener('click', () => { const n = store.clearCache(); renderSettings(); toast(`Cleared ${n} saved items.`); });
$('#clearHistory').addEventListener('click', () => { store.del('history'); renderHistory(); toast('Recent scans cleared.'); });

/* =========================================================
   Start
   ========================================================= */
applyTheme(document.documentElement.dataset.theme || 'system');
route();
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
// Fetch the set list early so the first scan is quick.
tcgdex.getSets().catch(() => {});
