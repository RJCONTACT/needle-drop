// Needle Drop — everything that moves.
//
//   search in the crate → results come back as records in sleeves
//   click (or drag) a sleeve → the record flies onto the platter,
//   the arm swings over, the needle drops and the song plays on the TV
//   click the arm or the record → pause (arm lifts home, platter slows down)
//
// No framework, no build step: plain browser JavaScript.
// Figma analogy: one prototype file. Each section below is like a Component
// with its Variants (states) and the interactions wired between them.

const $ = (s) => document.querySelector(s);
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ── Elements ───────────────────────────────────────────────────────────────
const el = {
  crate: $('#crate'), crateBtn: $('#crateBtn'), crateClose: $('#crateClose'), scrim: $('#scrim'),
  form: $('#searchForm'), q: $('#q'), status: $('#status'), chips: $('#chips'),
  results: $('#results'), played: $('#played'), recent: $('#recent'), recentWrap: $('#recentWrap'), hot: $('#hot'), hotWrap: $('#hotWrap'), tabs: document.querySelectorAll('.tab'),
  deck: $('#deck'), deckOn: $('#deckOn'), record: $('#record'), spin: $('#spin'), label: $('#recordLabel'),
  arm: $('#arm'), tv: document.querySelector('.tv'),
  nowTitle: $('#nowTitle'), nowArtist: $('#nowArtist'), nowTime: $('#nowTime'),
  vuL: $('#vuL'), vuR: $('#vuR'), knob: $('#knob'),
};

// ── Turntable geometry, measured on the photos ─────────────────────────────
// Figma analogy: the X/Y/W values you'd read in the Design panel, written
// down once so code can place layers as percentages of the parent frame.
const DECK = { w: 749, h: 691, platter: { x: 347, y: 345 }, recordR: 262, pivot: { x: 628, y: 141 }, armLength: 360 };
const ARM_IMG = { w: 723, h: 735, pivot: { x: 564, y: 163 }, angle: 135.2, length: 707 };
const REC_FILL = 0.9875; // the disc fills 98.75% of the record photo

// Arm angle that puts the stylus `r` px from the spindle (law of cosines).
const D = Math.hypot(DECK.platter.x - DECK.pivot.x, DECK.platter.y - DECK.pivot.y);
const TO_SPINDLE = Math.atan2(DECK.platter.y - DECK.pivot.y, DECK.platter.x - DECK.pivot.x) * 180 / Math.PI;
const angleFor = (r) => {
  const L = DECK.armLength;
  const c = Math.min(1, Math.max(-1, (L * L + D * D - r * r) / (2 * L * D)));
  return TO_SPINDLE - Math.acos(c) * 180 / Math.PI;
};
const ARM = { rest: 86, outer: angleFor(252), inner: angleFor(118) };

// Size and pivot of the arm layer inside the deck frame.
{
  const k = DECK.armLength / ARM_IMG.length;
  const pct = (n) => `${(n * 100).toFixed(3)}%`;
  Object.assign(el.arm.style, {
    left: pct((DECK.pivot.x - ARM_IMG.pivot.x * k) / DECK.w),
    top: pct((DECK.pivot.y - ARM_IMG.pivot.y * k) / DECK.h),
    width: pct((ARM_IMG.w * k) / DECK.w),
    transformOrigin: `${pct(ARM_IMG.pivot.x / ARM_IMG.w)} ${pct(ARM_IMG.pivot.y / ARM_IMG.h)}`,
  });
}
const setArm = (angle, { lifted = false, tracking = false } = {}) => {
  el.arm.style.setProperty('--rot', `${(angle - ARM_IMG.angle).toFixed(2)}deg`);
  el.arm.classList.toggle('is-lifted', lifted);
  el.arm.classList.toggle('is-tracking', tracking);
};
setArm(ARM.rest);

// ── State ──────────────────────────────────────────────────────────────────
// Figma analogy: the Variant properties of the whole player.
const state = {
  records: new Map(),   // id → { id, title, artist, cover }
  placed: null,         // record on the platter
  playing: false,
  arm: 'rest',          // rest | cueing | playing
};

// ── Crate (the hideable menu) ──────────────────────────────────────────────
const isOpen = () => el.crate.classList.contains('is-open');
// Below 1100px the crate covers the page (with a dim backdrop) instead of pushing it.
const narrow = () => innerWidth < 1100;
let crateEverOpened = false;
function openCrate() {
  crateEverOpened = true;
  el.crate.inert = false;
  el.crate.classList.add('is-open');
  document.body.classList.add('crate-open');
  el.crateBtn.setAttribute('aria-expanded', 'true');
  if (narrow()) { el.scrim.hidden = false; requestAnimationFrame(() => el.scrim.classList.add('is-on')); }
  setTimeout(() => el.q.focus(), reduced() ? 0 : 250);
}
function closeCrate() {
  el.crate.classList.remove('is-open');
  document.body.classList.remove('crate-open');
  el.crate.inert = true;
  el.crateBtn.setAttribute('aria-expanded', 'false');
  el.scrim.classList.remove('is-on');
  setTimeout(() => { el.scrim.hidden = true; }, 300);
}
el.crateBtn.addEventListener('click', () => (isOpen() ? closeCrate() : openCrate()));
// Search right at the turntable: the empty platter and the shelf label.
$('#pickBtn').addEventListener('click', openCrate);
$('#deckSearch').addEventListener('click', openCrate);
el.crateClose.addEventListener('click', () => { closeCrate(); el.crateBtn.focus(); });
el.scrim.addEventListener('click', closeCrate);
addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName);
  if (e.key === '/' && !typing) { e.preventDefault(); openCrate(); }
  else if (e.key === 'Escape' && isOpen()) { closeCrate(); el.crateBtn.focus(); }
  else if (e.key === ' ' && !typing && document.activeElement === document.body && state.placed) { e.preventDefault(); toggle(); }
});

// Tabs: Results / Played.
el.tabs.forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
function showTab(name) {
  el.tabs.forEach((t) => { const on = t.dataset.tab === name; t.classList.toggle('is-on', on); t.setAttribute('aria-selected', on); });
  el.results.hidden = name !== 'results';
  el.played.hidden = name !== 'played';
  el.chips.hidden = name !== 'results' || !!el.q.value.trim();
  if (name === 'played') renderPlayed();
}

// ── Search ─────────────────────────────────────────────────────────────────
const MESSAGES = {
  quota: "The record shop has closed for today (YouTube's daily search limit). Played records still work.",
  nokey: 'Search isn\'t set up yet: the YouTube key is missing.',
  default: "Couldn't reach the record shop. Check your connection and try again.",
};
let searchId = 0;
async function search(q) {
  q = q.trim();
  if (!q) return;
  el.q.value = q;
  qClear.hidden = false;
  showTab('results');
  el.chips.hidden = true;
  const id = ++searchId;
  setStatus(`Digging for “${q}”…`);
  el.results.replaceChildren(...Array.from({ length: 6 }, () => Object.assign(document.createElement('li'), { className: 'ghost' })));
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (id !== searchId) return; // a newer search started
    if (!res.ok) throw new Error(data.error || 'default');
    renderRecords(el.results, data.records);
    setStatus(data.records.length ? `${data.records.length} records for “${q}”` : `Nothing in the crate for “${q}”. Try another name.`);
  } catch (err) {
    if (id !== searchId) return;
    el.results.replaceChildren();
    setStatus(MESSAGES[err.message] || MESSAGES.default);
  }
}
const setStatus = (t) => { el.status.textContent = t; };
el.form.addEventListener('submit', (e) => { e.preventDefault(); search(el.q.value); });

// Clear: empty the field, the results and the status; bring the suggestions
// back. Figma analogy: resetting the search Component to its default Variant.
const qClear = $('#qClear');
function clearSearch() {
  searchId++;                                // ignore a search still in flight
  el.q.value = '';
  qClear.hidden = true;
  el.results.replaceChildren();
  setStatus('');
  showTab('results');
  showHotInCrate();
  el.q.focus();
}
qClear.addEventListener('click', clearSearch);
el.q.addEventListener('input', () => {
  qClear.hidden = !el.q.value;
  if (!el.q.value) clearSearch();            // deleting the text also resets
});
el.q.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && el.q.value) { e.preventDefault(); e.stopPropagation(); clearSearch(); }
});
el.chips.addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (c) search(c.dataset.q); });

// ── Records in sleeves ─────────────────────────────────────────────────────
// Figma analogy: one "Sleeve" Component; each result is an Instance with the
// cover image, title and artist swapped in.
function renderRecords(list, records) {
  list.replaceChildren(...records.map((r) => {
    state.records.set(r.id, r);
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'sleeve';
    b.dataset.id = r.id;
    b.setAttribute('aria-label', `Play ${r.title} by ${r.artist}`);
    b.innerHTML = `
      <span class="sleeve__photo">
        <img class="sleeve__full" src="/img/sleeve-record.webp" alt="" width="908" height="613" loading="lazy">
        <img class="sleeve__empty" src="/img/sleeve-empty.webp" alt="" width="908" height="613" loading="lazy">
        <span class="sleeve__art"></span>
        <span class="sleeve__label"><span class="label"></span></span>
      </span>
      <span class="sleeve__title"></span>
      <span class="sleeve__artist"></span>`;
    b.querySelector('.sleeve__art').style.backgroundImage = `url("${r.cover}")`;
    b.querySelector('.label').style.backgroundImage = `url("${r.cover}")`;
    b.querySelector('.sleeve__title').textContent = r.title;
    b.querySelector('.sleeve__artist').textContent = r.artist;
    if (r.plays > 1) {
      const n = Object.assign(document.createElement('span'), { className: 'sleeve__plays', textContent: `${r.plays} listeners` });
      b.append(n);
    }
    markSleeve(b);
    li.append(b);
    return li;
  }));
}
const markSleeve = (b) => {
  const out = b.dataset.id === state.placed;
  b.classList.toggle('is-out', out);
  b.classList.toggle('is-playing', out);
};
const refreshSleeves = () => document.querySelectorAll('.sleeve').forEach(markSleeve);

// Click a sleeve → record goes to the platter. Drag works too (mouse/pen).
[el.results, el.played, el.recent, el.hot].forEach((list) => {
  list.addEventListener('click', (e) => {
    const b = e.target.closest('.sleeve');
    if (!b || b.dataset.dragged) { if (b) delete b.dataset.dragged; return; }
    if (b.dataset.id === state.placed) { toggle(); return; }
    const from = sleeveRecordRect(b);
    if (narrow()) closeCrate();
    put(b.dataset.id, from);
  });
  list.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.sleeve');
    if (b && e.pointerType !== 'touch' && e.button === 0) dragFromSleeve(b, e);
  });
});

// "Played" history, kept in this browser only.
const HISTORY_KEY = 'needle-drop:played';
const readHistory = () => { try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; } };
function remember(r) {
  const list = [r, ...readHistory().filter((x) => x.id !== r.id)].slice(0, 24);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch { /* private mode: skip */ }
}
// Hot this week: shared across everyone. Shown on the page, and in the crate
// whenever there's no search yet.
let hotRecords = [];
async function loadHot() {
  try {
    const res = await fetch('/api/hot');
    if (!res.ok) return;
    hotRecords = (await res.json()).records || [];
  } catch { return; }
  el.hotWrap.hidden = !hotRecords.length;
  renderRecords(el.hot, hotRecords.slice(0, 6));   // one row on the page; the crate shows all 8
  if (!el.q.value) showHotInCrate();
}
function showHotInCrate() {
  if (!hotRecords.length) return;
  renderRecords(el.results, hotRecords);
  el.chips.hidden = false;
  setStatus('Hot this week');
}
loadHot();
// Count a play for the Hot chart (anonymous; see privacy page).
const countPlay = (id) => fetch('/api/play', { method: 'POST', body: JSON.stringify({ id }), keepalive: true }).catch(() => {});

// Starter crate for first-time visitors: six retro records in the site's
// 70s spirit (disco, funk, city pop, Bollywood, soul, jazz). IDs checked as
// playable on Needle Drop. Figma analogy: placeholder content in an empty state.
const thumb = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
const STARTERS = [
  { id: 'B2mmDEv0OEk', title: 'September', artist: 'Earth, Wind & Fire' },
  { id: 'aXgSHL7efKg', title: 'Le Freak', artist: 'CHIC' },
  { id: 'T_lC2O1oIew', title: 'Plastic Love', artist: 'Mariya Takeuchi' },
  { id: 'Gqv7n-lNfT0', title: 'Chura Liya Hai Tumne Jo Dil Ko', artist: 'Asha Bhosle · R.D. Burman' },
  { id: 'oaLDut30Br0', title: 'Lovely Day', artist: 'Bill Withers' },
  { id: 'P6fxBUzOrcU', title: 'Take Five', artist: 'Dave Brubeck Quartet' },
].map((r) => ({ ...r, cover: thumb(r.id) }));

// The 6 most recent on the page itself; the starter crate until there are any.
function renderRecent() {
  const list = readHistory().slice(0, 6);
  $('#recentTitle').textContent = list.length ? 'Recently played' : 'Start with these';
  el.recentWrap.hidden = false;
  renderRecords(el.recent, list.length ? list : STARTERS);
}
renderRecent();

function renderPlayed() {
  const list = readHistory();
  renderRecords(el.played, list);
  if (!list.length) setStatus('Records you play show up here.');
  else setStatus('');
}

// ── Moving records: flight and drag ────────────────────────────────────────
// Where the record peeking out of a sleeve photo is, on screen.
function sleeveRecordRect(b) {
  const r = b.querySelector('.sleeve__photo').getBoundingClientRect();
  const k = r.width / 908;
  const size = (286 * 2 * k) / REC_FILL;
  return new DOMRect(r.left + 616 * k - size / 2, r.top + 309 * k - size / 2, size, size);
}
function platterRect() {
  const r = el.deck.getBoundingClientRect();
  const k = r.width / DECK.w;
  const size = (DECK.recordR * 2 / REC_FILL) * k;
  return new DOMRect(r.left + DECK.platter.x * k - size / 2, r.top + DECK.platter.y * k - size / 2, size, size);
}
function makeFlyer(cover, size) {
  const f = document.createElement('div');
  f.className = 'flyer';
  f.style.width = f.style.height = `${size}px`;
  f.innerHTML = '<img src="/img/record.webp" alt=""><span class="label"></span>';
  f.querySelector('.label').style.backgroundImage = `url("${cover}")`;
  document.body.append(f);
  return f;
}
// A record travels along an arc (quadratic Bézier), growing to platter size,
// eased slow–fast–slow. Figma analogy: Smart Animate on a curved motion path.
function fly(cover, from, to, ms = 950) {
  return new Promise((done) => {
    if (reduced() || !from) return done();
    const size = Math.max(from.width, to.width);
    const f = makeFlyer(cover, size);
    const a = { x: from.left + from.width / 2, y: from.top + from.height / 2 };
    const b = { x: to.left + to.width / 2, y: to.top + to.height / 2 };
    const c = { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - Math.min(220, 40 + Math.hypot(b.x - a.x, b.y - a.y) * 0.3) };
    const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
    const frames = [];
    for (let i = 0; i <= 36; i++) {
      const u = ease(i / 36);
      const x = (1 - u) ** 2 * a.x + 2 * (1 - u) * u * c.x + u * u * b.x;
      const y = (1 - u) ** 2 * a.y + 2 * (1 - u) * u * c.y + u * u * b.y;
      const s = ((from.width + (to.width - from.width) * u) / size) * (1 + 0.07 * Math.sin(Math.PI * u));
      const lift = Math.sin(Math.PI * u);
      frames.push({
        transform: `translate(${x - size / 2}px, ${y - size / 2}px) scale(${s}) rotate(${110 * u}deg)`,
        filter: `drop-shadow(0 ${4 + 18 * lift}px ${4 + 14 * lift}px rgba(0,0,0,${0.5 - 0.1 * lift}))`,
      });
    }
    f.animate(frames, { duration: ms, easing: 'linear', fill: 'forwards' }).finished
      .then(() => { f.remove(); done(); });
  });
}
// Drag a record out of its sleeve; drop it on the turntable to play.
function dragFromSleeve(b, e) {
  const r = state.records.get(b.dataset.id);
  const sx = e.clientX, sy = e.clientY;
  let flyer = null;
  const over = (x, y) => { const p = platterRect(); return Math.hypot(x - (p.x + p.width / 2), y - (p.y + p.height / 2)) < p.width * 0.6; };
  const move = (ev) => {
    if (!flyer && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
    if (!flyer) { flyer = makeFlyer(r.cover, sleeveRecordRect(b).width * 1.15); flyer.classList.add('is-drag'); b.classList.add('is-out'); }
    const s = parseFloat(flyer.style.width);
    flyer.style.transform = `translate(${ev.clientX - s / 2}px, ${ev.clientY - s / 2}px)`;
    el.deck.classList.toggle('is-target', over(ev.clientX, ev.clientY));
  };
  const up = (ev) => {
    removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
    el.deck.classList.remove('is-target');
    if (!flyer) return;
    b.dataset.dragged = '1';                // swallow the click that follows
    const s = parseFloat(flyer.style.width);
    const from = new DOMRect(ev.clientX - s / 2, ev.clientY - s / 2, s, s);
    flyer.remove();
    if (over(ev.clientX, ev.clientY)) put(r.id, from, 450);
    else { fly(r.cover, from, sleeveRecordRect(b), 500).then(refreshSleeves); }
  };
  addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
}

// ── Turntable behaviour ────────────────────────────────────────────────────
// record on platter → arm swings over → needle drops → motor + music
// lift the arm → music pauses → arm swings home → platter slows to a stop
let flightToken = 0;
async function put(id, from, ms) {
  const r = state.records.get(id);
  if (!r) return;
  const token = ++flightToken;
  if (state.placed) { pause(); }
  state.placed = id;
  refreshSleeves();
  el.record.hidden = true;
  await fly(r.cover, from, platterRect(), ms);
  if (token !== flightToken) return;       // another record was picked mid-air
  el.label.style.backgroundImage = `url("${r.cover}")`;
  el.record.hidden = false;
  el.record.setAttribute('aria-label', `${r.title}: click to play or pause`);
  el.deck.classList.add('has-record');
  $('#deckSearchText').textContent = 'Search another song';
  showNow(r);
  remember(r);
  renderRecent();
  countPlay(r.id);
  needle('drop');
  load(r.id);
}

// Lower the arm and play. Called when a record lands, or the arm/record is clicked.
function play() {
  if (!state.placed) { el.arm.animate([{ rotate: '0deg' }, { rotate: '2deg' }, { rotate: '-1.5deg' }, { rotate: '0deg' }], 400); return; }
  clearTimers();
  state.arm = 'cueing';
  setArm(ARM.outer, { lifted: true });
  later(reduced() ? 0 : 850, () => {
    setArm(currentArmAngle(), { lifted: false });
    later(reduced() ? 0 : 260, () => {
      state.arm = 'playing'; motor(true); yt?.playVideo?.();
      // Some phones block playback that doesn't start straight from a tap.
      later(2500, () => {
        if (state.arm === 'playing' && yt?.getPlayerState?.() !== YT.PlayerState.PLAYING) {
          el.nowArtist.textContent = 'Tap play on the TV to start';
        }
      });
    });
  });
}
function pause() {
  clearTimers();
  state.arm = 'rest';
  yt?.pauseVideo?.();
  setArm(currentArmAngle(), { lifted: true });
  later(reduced() ? 0 : 220, () => setArm(ARM.rest, { lifted: false }));
  motor(false);
}
const toggle = () => (state.arm === 'rest' ? play() : pause());
el.arm.addEventListener('click', toggle);
el.record.addEventListener('click', toggle);

let timers = [];
const later = (ms, fn) => timers.push(setTimeout(fn, ms));
const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };

// Arm follows the song: outer groove at 0:00, near the label at the end.
function currentArmAngle() {
  const d = yt?.getDuration?.() || 0, t = yt?.getCurrentTime?.() || 0;
  const p = d ? Math.min(1, t / d) : 0;
  return ARM.outer + (ARM.inner - ARM.outer) * p;
}

// Platter spin with spin-up and run-down (33⅓ rpm = 200° a second).
let angle = 0, speed = 0, target = 0, raf = 0, last = 0;
function motor(on) {
  target = on ? 200 : 0;
  el.deckOn.classList.toggle('is-on', on);
  state.playing = on;
  if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); }
}
function tick(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  speed += (target - speed) * Math.min(1, dt * (target ? 2.2 : 1.4));
  if (!reduced()) { angle = (angle + speed * dt) % 360; el.spin.style.transform = `rotate(${angle}deg)`; }
  vu(now);
  if (Math.abs(speed - target) < 0.5 && !target) { speed = 0; raf = 0; vu(now, true); return; }
  raf = requestAnimationFrame(tick);
}

// Decorative VU meters (YouTube doesn't share the audio with the page).
let vuLast = 0;
function vu(now, rest) {
  if (rest || !state.playing || reduced()) { el.vuL.style.setProperty('--a', '-42deg'); el.vuR.style.setProperty('--a', '-42deg'); return; }
  if (now - vuLast < 110) return;
  vuLast = now;
  const vol = (yt?.getVolume?.() ?? 70) / 100;
  const base = -42 + 60 * vol * (speed / 200);
  el.vuL.style.setProperty('--a', `${base + (Math.random() * 22 - 8)}deg`);
  el.vuR.style.setProperty('--a', `${base + (Math.random() * 22 - 8)}deg`);
}

// Needle crackle, made with Web Audio (no sound files to download).
let ac;
function needle() {
  if (reduced()) return;
  try {
    ac ??= new AudioContext();
    const len = ac.sampleRate * 0.35, buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() < 0.004 ? Math.random() * 2 - 1 : (Math.random() * 2 - 1) * 0.04) * (1 - i / len);
    const src = ac.createBufferSource(), g = ac.createGain();
    g.gain.value = 0.35; src.buffer = buf; src.connect(g).connect(ac.destination); src.start();
  } catch { /* no audio: fine */ }
}

// ── Readout ────────────────────────────────────────────────────────────────
function showNow(r) {
  el.nowTitle.textContent = r.title;
  el.nowArtist.textContent = r.artist;
  const line = el.nowTitle.parentElement;
  line.classList.remove('is-scrolling');
  requestAnimationFrame(() => {
    const over = el.nowTitle.scrollWidth > line.clientWidth;
    line.classList.toggle('is-scrolling', over && !reduced());
    line.style.setProperty('--dur', `${Math.max(8, r.title.length * 0.35)}s`);
  });
}
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
setInterval(() => {
  if (!yt?.getCurrentTime) return;
  el.nowTime.textContent = `${fmt(yt.getCurrentTime())} / ${fmt(yt.getDuration() || 0)}`;
  if (state.arm === 'playing') setArm(currentArmAngle(), { tracking: true });
}, 600);

// ── YouTube player (the TV) ────────────────────────────────────────────────
// Loaded only when the first record is played, so the page stays light.
// The player is always visible on the TV, at least 200 × 200 px, with
// YouTube's own controls and links left untouched.
let yt = null, ytReady = null;
function loadApi() {
  ytReady ??= new Promise((resolve) => {
    window.onYouTubeIframeAPIReady = resolve;
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { el.nowArtist.textContent = "Couldn't load the YouTube player. A blocker may be stopping it."; };
    document.head.append(s);
  });
  return ytReady;
}
async function load(id) {
  await loadApi();
  el.tv.classList.add('is-live');
  tvFirst();
  if (!yt) {
    await new Promise((ready) => {
      yt = new YT.Player('player', {
        videoId: id,
        playerVars: { playsinline: 1, rel: 0, origin: location.origin },
        events: { onReady: ready, onStateChange: onYtState, onError: onYtError },
      });
    });
    yt.setVolume(volume);
  } else {
    yt.cueVideoById(id);
  }
  if (id === state.placed) play();
}
// Phones: once music plays, move the TV above the turntable (animated with a
// View Transition where the browser supports it) and bring it into view.
function tvFirst() {
  if (document.body.classList.contains('tv-first') || innerWidth >= 860) return;
  const swap = () => document.body.classList.add('tv-first');
  if (document.startViewTransition && !reduced()) document.startViewTransition(swap);
  else swap();
  requestAnimationFrame(() => el.tv.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' }));
}

function onYtState({ data }) {
  // Someone used the TV's own controls: keep the turntable in step.
  if (data === YT.PlayerState.PLAYING) {
    const r = state.records.get(state.placed);
    if (r) el.nowArtist.textContent = r.artist;
    if (state.arm === 'rest') { state.arm = 'playing'; setArm(currentArmAngle()); motor(true); }
  }
  if (data === YT.PlayerState.PAUSED && state.arm === 'playing') pause();
  if (data === YT.PlayerState.ENDED) { pause(); setArm(ARM.rest); }
}
function onYtError({ data }) {
  const blocked = data === 101 || data === 150 || data === 100;
  pause();
  el.nowArtist.textContent = blocked ? "This one only plays on YouTube. Pick another record." : 'Playback error. Try another record.';
}

// ── Volume knob ────────────────────────────────────────────────────────────
// Drag up/down or use the arrow keys. Figma analogy: a slider Component with
// a rotation instead of a fill.
let volume = 70;
function setVolume(v) {
  volume = Math.round(Math.max(0, Math.min(100, v)));
  el.knob.style.setProperty('--k', `${-135 + volume * 2.7}deg`);
  el.knob.setAttribute('aria-valuenow', volume);
  yt?.setVolume?.(volume);
}
setVolume(70);
el.knob.addEventListener('pointerdown', (e) => {
  el.knob.setPointerCapture(e.pointerId);
  const start = e.clientY, v0 = volume;
  const move = (ev) => setVolume(v0 + (start - ev.clientY) * 0.6);
  const up = () => { el.knob.removeEventListener('pointermove', move); el.knob.removeEventListener('pointerup', up); };
  el.knob.addEventListener('pointermove', move); el.knob.addEventListener('pointerup', up);
});
el.knob.addEventListener('keydown', (e) => {
  const step = { ArrowUp: 5, ArrowRight: 5, ArrowDown: -5, ArrowLeft: -5, PageUp: 20, PageDown: -20 }[e.key];
  if (step) { e.preventDefault(); setVolume(volume + step); }
  if (e.key === 'Home') setVolume(0);
  if (e.key === 'End') setVolume(100);
});

// Don't open the crate on arrival. If someone has been here a while without
// playing anything or opening the crate, they're probably looking for search,
// so open it for them once (15 s on desktop, 20 s on phones). Never while
// they're mid-scroll or mid-click, and only once per visit.
// Figma analogy: an "After delay" prototype trigger that's cancelled by any
// other interaction with the frame.
(() => {
  let nudged = false, lastTouch = 0;
  try { nudged = sessionStorage.getItem('needle-drop:nudged') === '1'; } catch { /* ignore */ }
  if (nudged) return;
  const busy = () => performance.now() - lastTouch < 2500;
  ['pointerdown', 'wheel', 'touchmove', 'keydown', 'scroll'].forEach((t) =>
    addEventListener(t, () => { lastTouch = performance.now(); }, { passive: true }));
  const check = () => {
    if (state.placed || crateEverOpened) return;   // they found search, or are already playing
    if (busy()) { setTimeout(check, 2000); return; }
    try { sessionStorage.setItem('needle-drop:nudged', '1'); } catch { /* ignore */ }
    openCrate();
  };
  setTimeout(check, narrow() ? 20000 : 15000);
})();
