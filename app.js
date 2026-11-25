/* Training Log — personal workout tracker. All data lives on this device (localStorage)
   and is copied automatically to your Google Sheet backup when sync is set up. */
'use strict';
const KEY = 'trainingLog.v1';
const APP_VERSION = '2026.11.24-8';
const PREVIEW = !!window.PREVIEW;
const LS = (() => { try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); return localStorage; } catch (e) { const m = {}; return { getItem: k => k in m ? m[k] : null, setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; } }; } })();
const CORE = ['Back Squat', 'Deadlift', 'Strict Press', 'Pull-Up'];
const CORE_LABEL = { 'Back Squat': 'Back Squat', 'Deadlift': 'Deadlift', 'Strict Press': 'Strict Press', 'Pull-Up': 'Weighted Pull-Up' };
let PROGRAM = [];
const PROGRAM_NAME = 'Human Performance & Force Generation';

/* ---------- date helpers ---------- */
const pad = n => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const dnum = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
const daysBetween = (a, b) => dnum(b) - dnum(a);
const addDays = (s, n) => { const t = new Date((dnum(s) + n) * 864e5); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (s, yr = true) => { const [y, m, d] = s.split('-').map(Number); return `${MON[m - 1]} ${d}${yr ? ', ' + y : ''}`; };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slug = x => String(x).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
const r5 = x => Math.round(x / 5) * 5;
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };
const fmtNum = (n, d = 0) => n == null ? '–' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 });
const secToStr = s => { if (s == null || s === '') return ''; s = Math.round(s); const m = Math.floor(s / 60), r = s % 60; return `${m}:${pad(r)}`; };
const strToSec = t => { if (t == null || t === '') return null; t = String(t).trim(); if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t); const p = t.split(':').map(Number); if (p.some(isNaN)) return null; return p.reduce((a, b) => a * 60 + b, 0); };

/* ---------- state ---------- */
let S = null;
function freshState(SEED) {
  return {
    v: 1, created: new Date().toISOString(), updated: new Date().toISOString(),
    settings: { heightIn: 71, syncUrl: '', syncKey: '', lastSync: null, pauses: [] },
    programDays: SEED.program, workouts: SEED.workouts, bodyweights: SEED.bodyweights, tests: SEED.tests,
    twoRMs: Object.fromEntries(Object.entries(SEED.twoRM).map(([k, v]) => [k, [{ ...v, src: 'Imported (Jul–Aug 2026 test week)' }]])),
    program: { cycle: 1, started: null, completed: {} },
    templates: []
  };
}
function load() {
  try { const raw = LS.getItem(KEY); if (raw) S = JSON.parse(raw); } catch (e) { console.warn(e); }
  if (S) { PROGRAM = S.programDays || []; migrateMovements(); }
}
function adopt(st) { S = st; PROGRAM = S.programDays || []; migrateMovements(); invalidate(); }
let saveTimer = null;
function persist(sync = true) {
  S.updated = new Date().toISOString();
  try { LS.setItem(KEY, JSON.stringify(S)); }
  catch (e) { toast('⚠️ Could not save on this phone: ' + e.message); }
  if (sync) { LS.setItem(KEY + '.dirty', '1'); scheduleSync(); }
}
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => persist(true), 300); }
function saveNow() { clearTimeout(saveTimer); persist(true); }
window.addEventListener('pagehide', () => { if (saveTimer) saveNow(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && saveTimer) saveNow(); if (document.visibilityState === 'visible') scheduleSync(500); });

/* ---------- bodyweight ---------- */
function bwAt(date) {
  const list = [...S.bodyweights].sort((a, b) => a.date < b.date ? -1 : 1);
  let v = list.length ? list[0].lb : 155;
  for (const b of list) { if (b.date <= date) v = b.lb; else break; }
  return v;
}
const currentBW = () => bwAt(today());

/* ---------- lift math ---------- */
function e1(w, r) { if (!r || r < 1 || r > 10) return null; return r === 1 ? w : w * (1 + r / 30); }
function setE1(ex, s, bw) {
  if (!s || s.wu || s.done === false || !(s.r > 0)) return null;
  const w = +s.w || 0;
  if (ex === 'Pull-Up') { const t = e1(bw + w, s.r); return t == null ? null : t - bw; }
  if (!(w > 0)) return null;
  return e1(w, s.r);
}
function workoutBW(w) { return w.bw || bwAt(w.date); }
let _sessCache = null;
function invalidate() { _sessCache = null; _exl = null; }
function sessionsAll() {
  if (_sessCache) return _sessCache;
  const m = {};
  for (const w of S.workouts) {
    const bw = workoutBW(w);
    for (const b of w.blocks || []) {
      if (b.type !== 'strength' || !b.exercise) continue;
      const sets = (b.sets || []).filter(s => s.r > 0 && s.done !== false);
      if (!sets.length) continue;
      const ex = b.exercise;
      let best = null, bestSet = null, vol = 0, maxReps = 0;
      for (const s of sets) {
        const v = setE1(ex, s, bw);
        if (v != null && (best == null || v > best)) { best = v; bestSet = s; }
        if (!s.wu) vol += ((ex === 'Pull-Up' ? bw : 0) + (+s.w || 0)) * s.r;
        if (ex === 'Pull-Up' && !(+s.w)) maxReps = Math.max(maxReps, s.r);
      }
      (m[ex] = m[ex] || []).push({ date: w.date, wid: w.id, e1: best, best: bestSet, vol, sets, bw, maxReps });
    }
  }
  for (const k in m) m[k].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return (_sessCache = m);
}
const sessions = ex => sessionsAll()[ex] || [];
function liftSummary(ex) {
  const ss = sessions(ex).filter(s => s.e1 != null);
  if (!ss.length) return null;
  const last = ss[ss.length - 1];
  const win = ss.filter(s => daysBetween(s.date, last.date) <= 30);
  const cur = win.reduce((a, s) => s.e1 > a.e1 ? s : a, win[0]);
  const best = ss.reduce((a, s) => s.e1 > a.e1 ? s : a, ss[0]);
  return { last, current: cur.e1, currentDate: last.date, currentBW: cur.bw, best: best.e1, bestDate: best.date, bestBW: best.bw, count: sessions(ex).length };
}
function repMaxes(ex) {
  const out = {};
  for (const s of sessions(ex)) for (const set of s.sets) {
    if (set.wu || !(set.r > 0) || set.r > 12) continue;
    const w = +set.w || 0;
    if (ex !== 'Pull-Up' && !(w > 0)) continue;
    const cur = out[set.r];
    if (!cur || w > cur.w) out[set.r] = { w, date: s.date, wid: s.wid };
  }
  return out;
}
const twoRM = lift => { const l = S.twoRMs[lift] || []; return l.length ? l[l.length - 1] : null; };
function targetRange(rx) {
  const t = twoRM(rx.lift); if (!t) return null;
  const lo = r5(t.lb * rx.pct[0] / 100), hi = r5(t.lb * rx.pct[1] / 100);
  return [lo, hi];
}
const wLabel = (ex, w) => ex === 'Pull-Up' ? (w > 0 ? `+${fmtNum(w, 1)}` : 'BW') : fmtNum(w, 1);

/* ---------- fitness exam ---------- */
const lin = (v, lo, hi) => Math.max(0, Math.min(100, (v - lo) * 100 / (hi - lo)));
const linInv = (v, best, worst) => Math.max(0, Math.min(100, (worst - v) * 100 / (worst - best)));
const RATES = { strength: .02, grip: .03, power: .03, endurance: .03, speed: .03, anaerobic: .04, aerobic: .05 };
const CAT_LABEL = { strength: 'Max strength', grip: 'Grip / strength endurance', power: 'Power', endurance: 'Muscular endurance', speed: 'Speed / agility', anaerobic: 'Anaerobic conditioning', aerobic: 'Aerobic conditioning' };
const EVENTS = [
  { k: 'longjump', bounds: (bw, h) => [.6 * h, 1.5 * h], label: 'Standing Long Jump', short: 'Long Jump', unit: 'in', cat: 'power', range: '0.6× – 1.5× height', score: (v, bw, h) => lin(v, .6 * h, 1.5 * h) },
  { k: 'ttest', bounds: () => [15.5, 9.5], label: 'Agility T-Test', short: 'T-Test', unit: 's', time: false, lower: true, cat: 'speed', range: '15.5s – 9.5s', score: v => linInv(v, 9.5, 15.5) },
  { k: 'wpullup', bounds: bw => [.21 * bw, .5 * bw], label: 'Weighted Pull-up (added, 1RM)', short: 'Wtd Pull-up', unit: 'lb', cat: 'strength', feed: 'Pull-Up', range: '0.21× – 0.5× BW', score: (v, bw) => lin(v, .21 * bw, .5 * bw) },
  { k: 'frontsquat', bounds: bw => [.89 * bw, 1.85 * bw], label: 'Front Squat 1RM', short: 'Front Squat', unit: 'lb', cat: 'strength', feed: 'Front Squat', range: '0.89× – 1.85× BW', score: (v, bw) => lin(v, .89 * bw, 1.85 * bw) },
  { k: 'bench', bounds: bw => [.5 * bw, 1.65 * bw], label: 'Bench Press 1RM', short: 'Bench', unit: 'lb', cat: 'strength', feed: 'Bench Press', range: '0.5× – 1.65× BW', score: (v, bw) => lin(v, .5 * bw, 1.65 * bw) },
  { k: 'deadlift', bounds: bw => [bw, 3 * bw], label: 'Deadlift 1RM', short: 'Deadlift', unit: 'lb', cat: 'strength', feed: 'Deadlift', range: '1× – 3× BW', score: (v, bw) => lin(v, bw, 3 * bw) },
  { k: 'goblet', bounds: () => [4, 45], label: 'Goblet Squats (⅓ BW, 60s)', short: 'Goblet Sq', unit: 'reps', cat: 'endurance', range: '4 – 45 reps', score: v => lin(v, 4, 45) },
  { k: 'hrpu', bounds: () => [4, 30], label: 'Hand-Release Push-ups (60s)', short: 'HRPU', unit: 'reps', cat: 'endurance', range: '4 – 30 reps', score: v => lin(v, 4, 30) },
  { k: 'pullups', bounds: () => [2, 20], label: 'Pull-ups (max reps)', short: 'Pull-up Reps', unit: 'reps', cat: 'endurance', range: '2 – 20 reps', score: v => lin(v, 2, 20) },
  { k: 'sandbag', bounds: () => [20, 200], label: 'Sandbag Carry (BW bag)', short: 'Sandbag', unit: 'ft', cat: 'grip', range: '20 – 200 ft', score: v => lin(v, 20, 200) },
  { k: 'shuttle', bounds: () => [105, 60], label: '300m Shuttle (50m course)', short: '300m Shuttle', unit: 's', time: true, lower: true, cat: 'anaerobic', range: '1:45 – 1:00', score: v => linInv(v, 60, 105) },
  { k: 'mile', bounds: () => [570, 315], label: '1-Mile Run', short: '1 Mile', unit: 's', time: true, lower: true, cat: 'aerobic', range: '9:30 – 5:15', score: v => linInv(v, 315, 570) },
  { k: 'axle', bounds: () => [5, 60], label: 'Axle Bar Hold (1.5× BW)', short: 'Axle Hold', unit: 's', cat: 'grip', range: '5 – 60 s', score: v => lin(v, 5, 60) },
  { k: 'vertical', bounds: () => [10, 35], label: 'Standing Vertical Jump', short: 'Vertical', unit: 'in', cat: 'power', range: '10 – 35 in', score: v => lin(v, 10, 35) },
  { k: 'sprint40', bounds: () => [7, 5], label: '40 m Sprint', short: '40m Sprint', unit: 's', lower: true, cat: 'speed', range: '7.0s – 5.0s', score: v => linInv(v, 5, 7) }
];
const valAt = (ev, pct, bw, h) => { const [a, z] = ev.bounds(bw, h); return a + (z - a) * pct / 100; };
function fmtStd(ev, v) {
  if (ev.time) return secToStr(v);
  if (ev.unit === 'lb') return fmtNum(r5(v)) + ' lb';
  if (ev.unit === 'reps') return Math.ceil(v - 1e-9) + '';
  if (ev.unit === 'ft') return fmtNum(Math.round(v)) + ' ft';
  if (ev.unit === 'in') return fmtNum(v, 1) + '"';
  return fmtNum(v, 2) + ' s';
}
const fmtEv = (ev, v) => v == null ? '–' : ev.time ? secToStr(v) : ev.unit === 'lb' ? fmtNum(v, 0) + ' lb' : fmtNum(v, 2) + ' ' + ev.unit;
function pausedDays(from, to) {
  let n = 0;
  for (const p of S.settings.pauses || []) {
    const a = p.start > from ? p.start : from, bEnd = p.end || today(), b = bEnd < to ? bEnd : to;
    if (b > a) n += daysBetween(a, b);
  }
  return n;
}
function eventCandidates(ev) {
  const c = S.tests.filter(t => t.event === ev.k).map(t => ({ value: t.value, date: t.date, bw: t.bw || bwAt(t.date), src: 'test', note: t.note }));
  for (const t of testBlocks()) if (t.event === ev.k) c.push({ value: t.value, date: t.date, bw: t.bw, src: 'test', wid: t.wid });
  if (ev.feed) for (const s of sessions(ev.feed)) if (s.e1 != null) c.push({ value: s.e1, date: s.date, bw: s.bw, src: 'lift', wid: s.wid });
  return c;
}
function eventState(ev) {
  const c = eventCandidates(ev);
  if (!c.length) return { ev, none: true };
  const h = S.settings.heightIn || 71, bwNow = currentBW();
  // current = most recent evidence. For lift-fed events, the most recent 30-day training window counts
  let latest = c.reduce((a, x) => x.date > a.date ? x : a, c[0]);
  let cur = latest;
  if (latest.src === 'lift') {
    const ls = liftSummary(ev.feed);
    const testSame = c.filter(x => x.src === 'test' && x.date === latest.date);
    cur = { value: ls.current, date: ls.currentDate, src: 'lift', bw: ls.currentBW };
    if (testSame.length) cur = testSame[0];
  }
  const raw = ev.score(cur.value, bwNow, h);
  const eff = daysBetween(cur.date, today()) - pausedDays(cur.date, today());
  const months = Math.max(0, Math.floor(eff / 30));
  const rate = RATES[ev.cat];
  const mult = Math.max(.75, Math.pow(1 - rate, months));
  const now = raw * mult;
  let best = null;
  for (const x of c) { const sc = ev.score(x.value, x.bw, h); if (!best || sc > best.score) best = { score: sc, ...x }; }
  const nextDrop = mult > .75 ? addDays(cur.date, (months + 1) * 30 + pausedDays(cur.date, today())) : null;
  return { ev, cur, raw, now, mult, months, best, nextDrop, rate };
}
const allEvents = () => EVENTS.map(eventState);
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

/* ---------- program ---------- */
const progDay = id => PROGRAM.find(d => d.id === id);
function nextProgramDay() { return PROGRAM.find(d => !S.program.completed[d.id]) || null; }
const activeWorkout = () => S.workouts.find(w => w.status === 'active');
function sigOf(b) { return (b.title + '|' + (b.movements || []).map(mvText).join('|')).toLowerCase().replace(/[^a-z0-9|]+/g, ''); }
function dayLabel(d) { return `Week ${d.week} · Day ${d.day}`; }
function daySummary(d) {
  if (d.kind === 'ruck') return d.ruck.text;
  const s = d.strength; const name = CORE_LABEL[s.lift];
  if (s.test) return `${name}: build to a 2-rep max`;
  return `${name}: ${s.sets}×${s.reps[0]}${s.reps[1] !== s.reps[0] ? '–' + s.reps[1] : ''} @ ${s.pct[0]}${s.pct[1] !== s.pct[0] ? '–' + s.pct[1] : ''}%`;
}
function workoutFromProgram(d) {
  const blocks = [];
  if (d.warmup && d.warmup.length) blocks.push({ type: 'warmup', items: d.warmup.map(t => ({ t, done: false })) });
  if (d.kind === 'ruck') {
    const r = d.ruck; const lb = r.fixedLb || (r.pct ? r5(currentBW() * r.pct / 100) : '');
    blocks.push({ type: 'ruck', rx: r, weight: lb, minutes: r.sets && r.minutes ? r.sets * r.minutes : '', distance: r.distanceMi || '', notes: '' });
  } else {
    const s = d.strength;
    if (s.test) blocks.push({ type: 'strength', exercise: s.lift, rx: s, sets: [{ w: '', r: '', done: false }] });
    else {
      const tr = targetRange(s);
      blocks.push({ type: 'strength', exercise: s.lift, rx: s, sets: Array.from({ length: s.sets }, () => ({ w: tr ? tr[0] : '', r: s.reps[0], done: false })) });
    }
    d.stamina.forEach((p, i) => {
      const lbl = d.stamina.length > 1 ? `Part ${'ABC'[i]} · ` : '';
      blocks.push(condFromProgram(p, lbl));
    });
  }
  return { id: uid(), date: today(), name: '', programDay: d.id, cycle: S.program.cycle, status: 'active', blocks, notes: '' };
}
function workoutTitle(w) {
  if (w.name) return w.name;
  if (w.programDay) { const d = progDay(w.programDay); return `W${d.week} D${d.day} · ${d.kind === 'ruck' ? 'Ruck' : CORE_LABEL[d.strength.lift]}`; }
  const ex = [...new Set((w.blocks || []).map(b => b.type === 'strength' ? b.exercise : b.type === 'cond' ? (b.title || 'Conditioning') : b.type === 'ruck' ? 'Ruck' : b.type === 'cardio' ? (b.mode || 'Cardio') : b.type === 'test' ? ((EVENTS.find(e => e.k === b.event) || {}).short || 'Test') : null).filter(Boolean))];
  return ex.slice(0, 3).join(', ') + (ex.length > 3 ? '…' : '') || 'Workout';
}
function condResultStr(b) {
  const r = b.result || {};
  const parts = [];
  if (b.format === 'amrap' && (r.rounds !== undefined && r.rounds !== '' || r.reps)) parts.push(`${r.rounds || 0} rds + ${r.reps || 0}`);
  if (r.time) parts.push(secToStr(r.time));
  if (r.score) parts.push(r.score);
  return parts.join(' · ');
}
function condHistory(sig, excludeWid) {
  const out = [];
  for (const w of S.workouts) { if (w.id === excludeWid) continue; for (const b of w.blocks || []) if (b.type === 'cond' && b.sig === sig && condResultStr(b)) out.push({ date: w.date, wid: w.id, res: condResultStr(b), b }); }
  return out.sort((a, b) => a.date < b.date ? 1 : -1);
}

/* ---------- sync with Google backup ---------- */
let syncTimer = null, syncing = false, syncStatus = '';
function scheduleSync(ms = 3000) {
  if (PREVIEW) return; clearTimeout(syncTimer); syncTimer = setTimeout(doSync, ms); }
async function doSync(force = false) {
  const { syncUrl, syncKey } = S.settings;
  if (!syncUrl || syncing) return;
  if (!force && LS.getItem(KEY + '.dirty') !== '1') return;
  if (!navigator.onLine) { syncStatus = 'offline – will sync later'; updateSyncBadge(); return; }
  syncing = true; syncStatus = 'syncing…'; updateSyncBadge();
  try {
    const res = await fetch(syncUrl, { method: 'POST', body: JSON.stringify({ key: syncKey, action: 'save', state: S }) });
    const j = await res.json();
    if (!j.ok) { syncStatus = 'backup refused: ' + (j.error || 'unknown'); syncing = false; updateSyncBadge(); return; }
    LS.setItem(KEY + '.dirty', '0');
    S.settings.lastSync = new Date().toISOString();
    try { LS.setItem(KEY, JSON.stringify(S)); } catch (e) { }
    syncStatus = '';
  } catch (e) { syncStatus = 'sync failed – will retry'; console.warn(e); scheduleSync(60000); }
  syncing = false; updateSyncBadge();
}
window.addEventListener('online', () => scheduleSync(1000));
async function fetchBackup(url, key) {
  const res = await fetch(url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key) + '&t=' + Date.now());
  const j = await res.json(); if (!j.ok) throw new Error(j.error || 'no backup'); return j;
}
function syncBadgeHTML() {
  if (PREVIEW) return '';
  if (!S.settings.syncUrl) return `<a class="sync muted" href="#more"><span class="dot" style="background:var(--warn)"></span>Backup not set up</a>`;
  const dirty = LS.getItem(KEY + '.dirty') === '1';
  const color = syncStatus.includes('fail') ? 'var(--bad)' : dirty || syncing ? 'var(--warn)' : 'var(--good)';
  const txt = syncStatus || (dirty ? 'changes waiting to back up' : S.settings.lastSync ? 'backed up ' + timeAgo(S.settings.lastSync) : 'backup on');
  return `<span class="sync muted"><span class="dot" style="background:${color}"></span>${esc(txt)}</span>`;
}
function updateSyncBadge() { document.querySelectorAll('[data-syncbadge]').forEach(el => el.innerHTML = syncBadgeHTML()); }
function timeAgo(iso) { const s = (Date.now() - new Date(iso)) / 1000; if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + ' min ago'; if (s < 86400) return Math.floor(s / 3600) + ' h ago'; return Math.floor(s / 86400) + ' d ago'; }

/* ---------- UI helpers ---------- */
const $ = s => document.querySelector(s);
function toast(msg, ms = 2600) { const t = document.createElement('div'); t.className = 'toast'; t.innerHTML = msg; document.body.appendChild(t); setTimeout(() => t.remove(), ms); }
function sheet(title, options) {
  return new Promise(res => {
    const el = document.createElement('div'); el.className = 'sheet';
    el.innerHTML = `<div class="panel"><h3>${esc(title)}</h3>${options.map((o, i) => `<button data-i="${i}" class="${o.cls || ''}">${o.label}</button>`).join('')}<button data-i="-1" class="btn-ghost" style="text-align:center">Cancel</button></div>`;
    el.addEventListener('click', e => { const b = e.target.closest('button'); if (!b && e.target !== el) return; el.remove(); res(b ? +b.dataset.i : -1); });
    document.body.appendChild(el);
  });
}

/* in-page dialogs (no browser pop-ups) */
function form(title, fields, okLabel = 'OK', msg = '') {
  return new Promise(res => {
    const el = document.createElement('div'); el.className = 'sheet';
    el.innerHTML = `<div class="panel dlg"><h3>${esc(title)}</h3>${msg ? `<p class="sec small" style="white-space:pre-line">${esc(msg)}</p>` : ''}${fields.map((f, i) => `<label class="f">${esc(f.label)}</label><input data-i="${i}" type="${f.type || 'text'}" ${f.mode ? `inputmode="${f.mode}"` : ''} value="${esc(f.value ?? '')}" placeholder="${esc(f.ph || '')}" autocapitalize="off" autocorrect="off">`).join('')}<div class="row" style="margin-top:14px"><button class="grow" data-a="0">Cancel</button><button class="grow btn-primary" data-a="1">${esc(okLabel)}</button></div></div>`;
    const done = ok => { const v = [...el.querySelectorAll('input')].map(x => x.value); el.remove(); res(ok ? v : null); };
    el.addEventListener('click', e => { const b = e.target.closest('button'); if (b) done(b.dataset.a === '1'); else if (e.target === el) done(false); });
    el.addEventListener('keydown', e => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    document.body.appendChild(el); const first = el.querySelector('input'); if (first) setTimeout(() => { first.focus(); first.select(); }, 50);
  });
}
async function ask(title, value = '', opt = {}) { const r = await form(title, [{ label: opt.label || '', value, mode: opt.mode, ph: opt.ph }], opt.ok || 'Save'); return r ? r[0] : null; }
async function okay(msg, okLabel = 'OK') { const r = await form(okLabel === 'OK' ? 'Are you sure?' : okLabel + '?', [], okLabel, msg); return !!r; }
const ICONS = {
  today: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="17" rx="3"/><path d="M3 9h18M8 2v4M16 2v4"/></svg>',
  history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  lifts: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 12h20M5 8v8M8 6v12M16 6v12M19 8v8"/></svg>',
  fitness: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 2l9 6.5-3.5 11h-11L3 8.5z"/><path d="M12 7l4.5 3.3-1.7 5.2H9.2l-1.7-5.2z"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>'
};
function renderTabs(cur) {
  const t = [['today', 'Today'], ['history', 'History'], ['lifts', 'Lifts'], ['fitness', 'Fitness'], ['more', 'Me']];
  $('#tabs').innerHTML = t.map(([k, l]) => `<a href="#${k}" class="${cur === k ? 'on' : ''}">${ICONS[k]}${l}</a>`).join('');
}

/* ---------- charts (hand-built SVG) ---------- */
function lineChart(points, opts = {}) {
  // points: [{date, y, label}] ; returns html; interaction attached after render via attachCharts()
  const id = 'c' + uid();
  if (points.length < 1) return '<p class="muted small">Not enough data yet.</p>';
  const W = 340, H = opts.h || 180, L = 40, R = 10, T = 12, B = 24;
  const xs = points.map(p => dnum(p.date)), ys = points.map(p => p.y).concat(opts.refY != null ? [opts.refY] : []);
  let x0 = Math.min(...xs), x1 = Math.max(...xs); if (x1 === x0) { x0 -= 15; x1 += 15; }
  let y0 = Math.min(...ys), y1 = Math.max(...ys); const pad_ = (y1 - y0) * .12 || 10; y0 = Math.max(0, y0 - pad_); y1 += pad_;
  const sx = x => L + (x - x0) / (x1 - x0) * (W - L - R), sy = y => T + (1 - (y - y0) / (y1 - y0)) * (H - T - B);
  const ticks = niceTicks(y0, y1, 4);
  let g = ticks.map(t => `<line x1="${L}" x2="${W - R}" y1="${sy(t)}" y2="${sy(t)}" stroke="var(--surface-3)"/><text x="${L - 6}" y="${sy(t) + 4}" text-anchor="end" font-size="10" fill="var(--text-muted)">${fmtNum(t)}</text>`).join('');
  const xt = timeTicks(x0, x1);
  g += xt.map(t => `<text x="${sx(t.x)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="var(--text-muted)">${t.l}</text>`).join('');
  if (opts.refY != null) g += `<line x1="${L}" x2="${W - R}" y1="${sy(opts.refY)}" y2="${sy(opts.refY)}" stroke="var(--series-2)" stroke-width="1.5" stroke-dasharray="4 4"/>`;
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${sx(dnum(p.date)).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');
  g += `<path d="${path}" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round"/>`;
  if (points.length <= 60) g += points.map(p => `<circle cx="${sx(dnum(p.date))}" cy="${sy(p.y)}" r="3.5" fill="var(--series-1)" stroke="var(--surface-1)" stroke-width="2"/>`).join('');
  g += `<line class="xh" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="var(--text-muted)" stroke-width="1" style="display:none"/><circle class="xd" r="5" fill="var(--series-1)" stroke="var(--text-primary)" stroke-width="2" style="display:none"/>`;
  CHARTS[id] = { points: points.map(p => ({ ...p, px: sx(dnum(p.date)), py: sy(p.y) })), W, H, link: opts.link };
  return `<div class="chart" id="${id}"><svg viewBox="0 0 ${W} ${H}">${g}</svg><div class="tip"></div></div>`;
}
const CHARTS = {};
function niceTicks(a, b, n) { const span = b - a, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0))); const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= step0) || mag * 10; const out = []; for (let t = Math.ceil(a / step) * step; t <= b + 1e-9; t += step) out.push(+t.toFixed(6)); return out; }
function timeTicks(x0, x1) {
  const span = x1 - x0, out = []; const d0 = new Date(x0 * 864e5), d1 = new Date(x1 * 864e5);
  if (span > 730) { for (let y = d0.getUTCFullYear() + 1; y <= d1.getUTCFullYear(); y++) out.push({ x: Date.UTC(y, 0, 1) / 864e5, l: String(y) }); }
  else { const stepM = span > 300 ? 3 : span > 120 ? 2 : 1; let y = d0.getUTCFullYear(), m = d0.getUTCMonth() + 1; if (m > 11) { m = 0; y++; } while (Date.UTC(y, m, 1) / 864e5 <= x1) { out.push({ x: Date.UTC(y, m, 1) / 864e5, l: MON[m] + (m === 0 ? " '" + String(y).slice(2) : '') }); m += stepM; if (m > 11) { y += Math.floor(m / 12); m %= 12; } } }
  return out.length > 6 ? out.filter((_, i) => i % 2 === 0) : out;
}
function attachCharts() {
  document.querySelectorAll('.chart').forEach(el => {
    const c = CHARTS[el.id]; if (!c || el._on) return; el._on = 1;
    const svg = el.querySelector('svg'), tip = el.querySelector('.tip'), xh = svg.querySelector('.xh'), xd = svg.querySelector('.xd');
    const move = e => {
      const r = svg.getBoundingClientRect(); const x = (e.clientX - r.left) / r.width * c.W;
      let p = c.points[0]; for (const q of c.points) if (Math.abs(q.px - x) < Math.abs(p.px - x)) p = q;
      xh.setAttribute('x1', p.px); xh.setAttribute('x2', p.px); xh.style.display = ''; xd.setAttribute('cx', p.px); xd.setAttribute('cy', p.py); xd.style.display = '';
      tip.style.display = 'block'; tip.style.left = (p.px / c.W * r.width) + 'px'; tip.style.top = (p.py / c.H * r.height - 10) + 'px';
      tip.innerHTML = `<b>${esc(p.label || fmtNum(p.y, 1))}</b><br><span class="muted">${fmtDate(p.date)}</span>`; el._p = p;
    };
    svg.addEventListener('pointermove', move); svg.addEventListener('pointerdown', move);
    svg.addEventListener('pointerleave', () => { tip.style.display = 'none'; xh.style.display = 'none'; xd.style.display = 'none'; });
    if (c.link) svg.addEventListener('dblclick', () => { if (el._p && el._p.wid) location.hash = '#workout-' + el._p.wid; });
  });
}
function radarSVG(states, size = 340, labels = true) {
  const n = states.length, cx = size / 2, cy = size / 2, R = size / 2 - (labels ? 44 : 8);
  const pt = (i, v) => { const a = -Math.PI / 2 + i * 2 * Math.PI / n; return [cx + Math.cos(a) * R * v / 100, cy + Math.sin(a) * R * v / 100]; };
  let g = '';
  for (const ring of [25, 50, 75, 100]) g += `<polygon points="${states.map((_, i) => pt(i, ring).join(',')).join(' ')}" fill="none" stroke="var(--surface-3)" stroke-width="1"/>`;
  states.forEach((_, i) => { const [x, y] = pt(i, 100); g += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="var(--surface-3)"/>`; });
  if (labels) for (const ring of [50, 100]) { const [x, y] = pt(0, ring); g += `<text x="${x + 4}" y="${y + 10}" font-size="9" fill="var(--text-muted)">${ring}</text>`; }
  const best = states.map((s, i) => pt(i, s.none ? 0 : s.best.score).join(',')).join(' ');
  const cur = states.map((s, i) => pt(i, s.none ? 0 : s.now).join(',')).join(' ');
  g += `<polygon points="${best}" fill="none" stroke="var(--series-2)" stroke-width="2" stroke-dasharray="5 4" stroke-linejoin="round"/>`;
  g += `<polygon points="${cur}" fill="var(--series-1)" fill-opacity=".22" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round"/>`;
  states.forEach((s, i) => { if (s.none) return; const [x, y] = pt(i, s.now); g += `<circle cx="${x}" cy="${y}" r="3" fill="var(--series-1)" stroke="var(--surface-1)" stroke-width="1.5"/>`; });
  if (labels) states.forEach((s, i) => {
    const [x, y] = pt(i, 118); const a = Math.cos(-Math.PI / 2 + i * 2 * Math.PI / n);
    const anchor = Math.abs(a) < .2 ? 'middle' : a > 0 ? 'start' : 'end';
    g += `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="10.5" fill="var(--text-secondary)">${esc(s.ev.short)}</text><text x="${x}" y="${y + 12}" text-anchor="${anchor}" font-size="10" font-weight="600" fill="var(--text-primary)">${s.none ? '–' : Math.round(s.now)}</text>`;
  });
  const padX = labels ? 34 : 0;
  return `<svg viewBox="${-padX} 0 ${size + padX * 2} ${size}" role="img" aria-label="Fitness radar">${g}</svg>`;
}

/* ---------- views ---------- */
const views = {};
function route() {
  const h = location.hash.slice(1) || 'today';
  const m = h.match(/^(workout|lift|event)-(.+)$/);
  const name = m ? m[1] : h; let arg = m ? m[2] : undefined;
  if (name === 'lift' && arg) arg = Object.keys(sessionsAll()).concat(CORE).find(x => slug(x) === arg) || arg;
  const fn = views[name] || views.today;
  renderTabs({ workout: 'today', lift: 'lifts', event: 'fitness' }[name] || name);
  $('#app').oninput = null; $('#app').onchange = null;
  $('#app').innerHTML = (PREVIEW ? `<div class="card small" style="border-color:#6b5317;background:#2a2210"><b>Preview copy.</b> <span class="sec">This is your real data, so try anything. Nothing here touches your real app or backup, and changes may not stick.</span></div>` : '') + fn(arg);
  attachCharts();
  if (views[name + '_after']) views[name + '_after'](arg);
  if (typeof keepAwake === 'function') { const w = name === 'workout' ? S.workouts.find(x => x.id === arg) : null; keepAwake(!!(w && w.status === 'active') || !!T); }
}
window.addEventListener('hashchange', () => { if (!S) return welcome(); window.scrollTo(0, 0); route(); });
function rerender() { const y = window.scrollY; route(); window.scrollTo(0, y); }

views.today = () => {
  const act = activeWorkout(), nd = nextProgramDay(), st = allEvents().filter(s => !s.none);
  let h = `<div class="row between"><h1>Today</h1><div data-syncbadge>${syncBadgeHTML()}</div></div>`;
  if (act) h += `<div class="card tap" onclick="location.hash='#workout-${act.id}'"><div class="tag" style="background:#173455;color:#9cc8ff">In progress</div><h3 style="margin-top:8px">${esc(workoutTitle(act))}</h3><p class="muted small">Started ${fmtDate(act.date)} · tap to continue</p></div>`;
  h += `<h2>Program</h2>`;
  if (!nd) h += `<div class="card"><h3>Program complete 🎉</h3><p class="sec">All 14 weeks done. Start it over with your new 2-rep maxes when you're ready.</p><button class="btn-primary btn-block" onclick="restartProgram()">Start again at Week 1</button></div>`;
  else {
    const doneN = Object.keys(S.program.completed).length;
    h += `<div class="card"><div class="row between"><span class="tag">${PROGRAM_NAME}${S.program.cycle > 1 ? ' · round ' + S.program.cycle : ''}</span><span class="muted small">${doneN}/70 done</span></div>
      <div class="bar" style="margin:10px 0"><span style="width:${doneN / 70 * 100}%"></span></div>
      <h3 style="font-size:20px;margin-top:6px">${dayLabel(nd)}</h3>${dayPreview(nd)}
      <div class="row" style="margin-top:12px">${act && act.programDay === nd.id ? `<button class="btn-primary grow" onclick="location.hash='#workout-${act.id}'">Continue workout</button>` : `<button class="btn-primary grow" onclick="startProgramDay('${nd.id}')">${doneN ? 'Start workout' : 'Start the program'}</button>`}<button onclick="pickDay()">Other day</button></div></div>`;
  }
  h += `<h2>Log something else</h2><div class="grid2"><button onclick="newCustom()">＋ Custom workout</button><button onclick="location.hash='#fitness'">＋ Fitness test</button><button onclick="quickBW()">＋ Bodyweight</button><button onclick="location.hash='#history'">History</button></div>`;
  const a = avg(st.map(s => s.now));
  h += `<h2>Fitness right now</h2><div class="card tap" onclick="location.hash='#fitness'"><div class="row"><div style="width:130px">${radarSVG(allEvents(), 130, false)}</div><div class="grow"><div class="stat"><div class="v">${fmtNum(a, 1)}</div><div class="l">Current avg score</div></div><p class="small muted">Best ever ${fmtNum(avg(st.map(s => s.best.score)), 1)} · ${st.length}/15 events tested</p></div></div></div>`;
  h += `<h2>Core lifts</h2><div class="grid2">${CORE.map(coreMini).join('')}</div>`;
  return h;
};
function coreMini(ex) {
  const s = liftSummary(ex), t = twoRM(ex);
  return `<div class="card tap" style="margin:0" onclick="location.hash='#lift-${slug(ex)}'"><div class="small muted">${CORE_LABEL[ex]}</div><div class="stat"><div class="v">${t ? wLabel(ex, t.lb) : '–'}</div><div class="l">2-rep max</div></div><div class="small sec">est. 1RM ${s ? wLabel(ex, Math.round(s.current)) : '–'}</div></div>`;
}
function dayPreview(d) {
  if (d.kind === 'ruck') { const r = d.ruck; return `<p class="sec">🎒 ${esc(r.text)}</p>${r.pct ? `<p class="small muted">${r.pct}% of ${currentBW()} lb = <b class="sec">${r5(currentBW() * r.pct / 100)} lb</b></p>` : ''}`; }
  const s = d.strength; let h = `<p><b>${esc(daySummary(d))}</b></p>`;
  if (!s.test) { const tr = targetRange(s); if (tr) h += `<p class="small sec">Target: ${wLabel(s.lift, tr[0])}${tr[1] !== tr[0] ? '–' + wLabel(s.lift, tr[1]) : ''} lb · from 2RM ${wLabel(s.lift, twoRM(s.lift).lb)}</p>`; }
  else h += `<p class="small sec">15 minutes to work up. Your new 2RM sets every target weight after this.</p>`;
  h += d.stamina.map(p => `<p class="small muted">▸ ${esc(p.title)}</p>`).join('');
  return h;
}
window.startProgramDay = async id => {
  const act = activeWorkout();
  if (act && !(await okay('You have a workout in progress. Start a new one anyway? The other one stays saved.', 'Start new'))) return;
  if (act) act.status = 'done';
  const w = workoutFromProgram(progDay(id));
  if (!S.program.started) S.program.started = today();
  S.workouts.push(w); invalidate(); saveNow(); location.hash = '#workout-' + w.id;
};
window.pickDay = async () => {
  const weeks = [...new Set(PROGRAM.map(d => d.week))];
  const wi = await sheet('Pick a week', weeks.map(w => ({ label: `Week ${w}` + (PROGRAM.filter(d => d.week === w).every(d => S.program.completed[d.id]) ? ' ✓' : '') })));
  if (wi < 0) return;
  const days = PROGRAM.filter(d => d.week === weeks[wi]);
  const di = await sheet(`Week ${weeks[wi]}`, days.map(d => ({ label: `${S.program.completed[d.id] ? '✓ ' : ''}Day ${d.day} — ${esc(daySummary(d))}` })));
  if (di < 0) return;
  const d = days[di];
  const ai = await sheet(dayLabel(d), [{ label: 'Start this workout', cls: 'btn-primary' }, { label: S.program.completed[d.id] ? 'Mark as not done' : 'Mark as done / skipped (no log)' }]);
  if (ai === 0) startProgramDay(d.id);
  if (ai === 1) { if (S.program.completed[d.id]) delete S.program.completed[d.id]; else S.program.completed[d.id] = 'skipped'; saveNow(); rerender(); }
};
window.restartProgram = async () => {
  if (!(await okay('Start the program over at Week 1 Day 1? Your history stays; only the program checklist resets.', 'Restart'))) return;
  S.program = { cycle: (S.program.cycle || 1) + 1, started: null, completed: {} }; saveNow(); rerender(); toast('Program reset to Week 1 Day 1');
};
window.newCustom = () => {
  const w = { id: uid(), date: today(), name: '', status: 'active', blocks: [], notes: '' };
  S.workouts.push(w); saveNow(); location.hash = '#workout-' + w.id; setTimeout(() => addBlock(w.id), 50);
};
window.quickBW = async () => {
  const v = num(await ask('Bodyweight today', currentBW(), { label: 'lb', mode: 'decimal' })); if (!v) return;
  S.bodyweights = S.bodyweights.filter(b => b.date !== today()); S.bodyweights.push({ date: today(), lb: v }); invalidate(); saveNow(); rerender(); toast('Bodyweight saved');
};

/* ---------- workout editor ---------- */
const getW = id => S.workouts.find(w => w.id === id);
views.workout = id => {
  const w = getW(id); if (!w) return '<p>Workout not found.</p><a href="#history">Back to history</a>';
  const d = w.programDay ? progDay(w.programDay) : null;
  let h = `<div class="row between"><a href="${w.status === 'active' ? '#today' : '#history'}" class="btn-ghost" style="padding-left:0">‹ Back</a><div data-syncbadge>${syncBadgeHTML()}</div></div>`;
  h += `<input data-w="name" value="${esc(w.name)}" placeholder="${esc(workoutTitle({ ...w, name: '' }))}" style="font-size:22px;font-weight:700;background:transparent;border-color:transparent;padding-left:0" aria-label="Workout name">`;
  h += `<div class="row small muted" style="gap:8px"><input type="date" data-w="date" value="${w.date}" style="width:auto;min-height:36px;padding:6px 8px">${d ? `<span class="tag">${dayLabel(d)}</span>` : ''}${w.source === 'strengthlevel' ? '<span class="tag">Imported</span>' : ''}</div>`;
  if (w.prs && w.prs.length) h += `<div class="card" style="border-color:#6b5317"><b>🏆 New PRs</b>${w.prs.map(p => `<p class="small sec">${esc(p)}</p>`).join('')}</div>`;
  w.blocks.forEach((b, i) => h += blockHTML(w, b, i));
  h += `<button class="btn-block" style="margin-top:10px" onclick="addBlock('${w.id}')">＋ Add exercise or piece</button>`;
  h += `<label class="f">Notes</label><textarea data-w="notes" placeholder="How it felt, subs, anything…">${esc(w.notes || '')}</textarea>`;
  h += `<div style="margin-top:16px">${w.status === 'active' ? `<button class="btn-primary btn-block" onclick="finishWorkout('${w.id}')">Finish workout</button>` : `<p class="small muted" style="text-align:center">Changes save automatically.</p>`}</div>`;
  h += `<div class="row" style="margin-top:8px"><button class="btn-sm grow" onclick="saveAsTemplateWorkout('${w.id}')">Repeat this workout</button><button class="btn-sm btn-danger" onclick="deleteWorkout('${w.id}')">Delete</button></div>`;
  return h;
};
views.workout_after = id => {
  const w = getW(id); if (!w) return;
  const app = $('#app');
  app.oninput = e => {
    const t = e.target;
    if (t.dataset.w) { w[t.dataset.w] = t.value; if (t.dataset.w === 'date') invalidate(); save(); return; }
    const bi = t.dataset.b; if (bi === undefined) return;
    const b = w.blocks[+bi]; const f = t.dataset.f;
    if (t.dataset.s !== undefined) { const s = b.sets[+t.dataset.s]; s[f] = f === 'w' || f === 'r' ? (t.value === '' ? '' : +t.value) : t.value; invalidate(); save(); return; }
    if (t.dataset.m !== undefined) { const m = b.movements[+t.dataset.m]; m[f] = f === 'wt' ? (t.value === '' ? '' : +t.value) : t.value; b.sig = sigOf(b); save(); return; }
    if (f === 'testval') { const ev = EVENTS.find(e => e.k === b.event); b.value = t.value === '' ? '' : ev.time ? strToSec(t.value) : num(t.value); const sc = document.querySelector(`[data-score="${bi}"]`); if (sc) { const v = b.value; sc.textContent = v === '' || v == null ? '–' : Math.round(ev.score(v, workoutBW(w), S.settings.heightIn || 71)) + '%'; } invalidate(); save(); return; }
    if (f === 'every') { b.every = strToSec(t.value); save(); return; }
    if (f === 'movements') b.movements = t.value.split('\n');
    else if (f.startsWith('res.')) { b.result = b.result || {}; const k = f.slice(4); b.result[k] = k === 'time' ? strToSec(t.value) : t.value; }
    else b[f] = t.value;
    if (b.type === 'cond' && f === 'title') b.sig = sigOf(b);
    save();
  };
  app.onchange = e => { const t = e.target; if (['format', 'exercise', 'kind', 'unit', 'rounds', 'cap', 'every', 'count'].includes(t.dataset.f) || (t.dataset.m !== undefined && t.dataset.f === 'amt')) { invalidate(); saveNow(); rerender(); } };
};
function blockHTML(w, b, i) {
  const del = `<button class="x" onclick="blockMenu('${w.id}',${i})" aria-label="Block options">⋯</button>`;
  if (b.type === 'warmup') {
    const done = b.items.filter(x => x.done).length;
    return `<div class="card"><div class="blockhead"><span class="kind grow">Warm-up / movement prep · ${done}/${b.items.length}</span>${del}</div><ul class="warm">${b.items.map((x, j) => `<li><label><input type="checkbox" ${x.done ? 'checked' : ''} onchange="toggleWarm('${w.id}',${i},${j},this.checked)"><span class="${x.done ? 'muted' : ''}">${esc(x.t)}</span></label></li>`).join('')}</ul></div>`;
  }
  if (b.type === 'strength') return strengthHTML(w, b, i, del);
  if (b.type === 'cond') return condHTML(w, b, i, del);
  if (b.type === 'ruck') {
    const r = b.rx || {};
    return `<div class="card"><div class="blockhead"><span class="kind grow">🎒 Ruck</span>${del}</div>${r.text ? `<p class="sec small">${esc(r.text)}</p>` : ''}${r.pct ? `<p class="small muted">Target load ${r.pct}% × ${currentBW()} lb = ${r5(currentBW() * r.pct / 100)} lb</p>` : ''}
      <div class="grid2"><div><label class="f">Load (lb)</label><input inputmode="decimal" data-b="${i}" data-f="weight" value="${esc(b.weight)}"></div><div><label class="f">Total minutes</label><input inputmode="decimal" data-b="${i}" data-f="minutes" value="${esc(b.minutes)}"></div>
      <div><label class="f">Distance (mi)</label><input inputmode="decimal" data-b="${i}" data-f="distance" value="${esc(b.distance)}"></div><div><label class="f">Moving time</label><input data-b="${i}" data-f="res.time" value="${esc(secToStr(b.result && b.result.time))}" placeholder="h:mm:ss"></div></div>
      <label class="f">Notes</label><input data-b="${i}" data-f="notes" value="${esc(b.notes || '')}" placeholder="Terrain, pace, feet…"></div>`;
  }
  if (b.type === 'test') return testHTML(w, b, i, del);
  if (b.type === 'cardio') return cardioHTML(w, b, i, del);
  if (b.type === 'cardio_old') return `<div class="card"><div class="blockhead"><span class="kind grow">Cardio</span>${del}</div><div class="grid2"><div><label class="f">Type</label><input data-b="${i}" data-f="mode" value="${esc(b.mode || '')}" placeholder="Run, Row, Bike…" list="cardiolist"></div><div><label class="f">Distance</label><input data-b="${i}" data-f="distance" value="${esc(b.distance || '')}" placeholder="e.g. 2 mi, 5000 m"></div><div><label class="f">Time (mm:ss)</label><input data-b="${i}" data-f="res.time" value="${esc(secToStr(b.result && b.result.time))}"></div><div><label class="f">Calories</label><input inputmode="decimal" data-b="${i}" data-f="cals" value="${esc(b.cals || '')}"></div></div><datalist id="cardiolist"><option>Run</option><option>Row</option><option>Assault Bike</option><option>Ski Erg</option><option>Swim</option><option>Walk</option></datalist></div>`;
  if (b.type === 'note') return `<div class="card"><div class="blockhead"><span class="kind grow">Note</span>${del}</div><textarea data-b="${i}" data-f="text">${esc(b.text || '')}</textarea></div>`;
  return '';
}
function strengthHTML(w, b, i, del) {
  const ex = b.exercise || '', rx = b.rx, pull = ex === 'Pull-Up', bw = workoutBW(w);
  let h = `<div class="card"><div class="blockhead"><span class="kind">Strength</span><span class="grow"></span>${del}</div>`;
  h += `<button class="mvname btn-block" onclick="pickExercise('${w.id}',${i})">${esc(ex || 'Choose exercise')}</button>`;
  if (rx) {
    if (rx.test) h += `<p class="small sec" style="margin-top:8px">Build to a 2-rep max in ${rx.cap} minutes. Log every set; your heaviest 2-rep set becomes your new 2RM.</p>`;
    else { const tr = targetRange(rx); h += `<p class="small sec" style="margin-top:8px">${rx.sets} sets × ${rx.reps[0]}${rx.reps[1] !== rx.reps[0] ? '–' + rx.reps[1] : ''} reps @ ${rx.pct[0]}${rx.pct[1] !== rx.pct[0] ? '–' + rx.pct[1] : ''}% → <b>${tr ? wLabel(ex, tr[0]) + (tr[1] !== tr[0] ? '–' + wLabel(ex, tr[1]) : '') + ' lb' : 'set your 2RM'}</b>${rx.rest ? ' · ' + esc(rx.rest.toLowerCase()) : ''}</p>`; }
  }
  const last = lastSessionBefore(ex, w);
  if (last) h += `<p class="small muted">Last time (${fmtDate(last.date, false)}): ${last.sets.filter(s => !s.wu).slice(0, 6).map(s => `${wLabel(ex, +s.w || 0)}×${s.r}`).join(', ')}</p>`;
  h += `<table class="sets"><tr><th>#</th><th>${pull ? '+lb added' : 'lb'}</th><th>reps</th><th>e1RM</th><th></th><th></th></tr>`;
  b.sets.forEach((s, j) => {
    const v = setE1(ex, { ...s, done: true }, bw);
    h += `<tr><td class="muted small">${s.wu ? 'W' : j + 1}</td><td><input inputmode="decimal" data-b="${i}" data-s="${j}" data-f="w" value="${s.w === '' ? '' : s.w}" placeholder="${pull ? '0' : ''}"></td><td><input inputmode="numeric" data-b="${i}" data-s="${j}" data-f="r" value="${s.r === '' ? '' : s.r}"></td><td class="small muted">${v ? (pull ? '+' : '') + Math.round(v) : ''}</td><td><button class="chk ${s.done ? 'on' : ''}" onclick="toggleSet('${w.id}',${i},${j})" aria-label="Done">✓</button></td><td><button class="x" onclick="delSet('${w.id}',${i},${j})" aria-label="Remove set">×</button></td></tr>`;
  });
  h += `</table><div class="row" style="margin-top:6px"><button class="btn-sm grow" onclick="addSet('${w.id}',${i})">＋ Set</button><button class="btn-sm" onclick="addSet('${w.id}',${i},true)">＋ Warm-up set</button></div>`;
  h += `</div>`;
  return h;
}
function lastSessionBefore(ex, w) { const ss = sessions(ex).filter(s => s.wid !== w.id && s.date <= w.date); return ss.length ? ss[ss.length - 1] : null; }
let _exl = null;
function exDatalist() {
  if (!_exl) { const set = new Set(CORE.concat(['Front Squat', 'Bench Press'])); S.workouts.forEach(w => w.blocks.forEach(b => b.exercise && set.add(b.exercise))); _exl = `<datalist id="exlist">${[...set].sort().map(x => `<option>${esc(x)}</option>`).join('')}</datalist>`; }
  return _exl;
}
const FORMATS = { amrap: 'AMRAP', fortime: 'For Time', emom: 'EMOM', interval: 'Every X min / Intervals', rounds: 'Rounds', other: 'Other' };
window.toggleWarm = (wid, i, j, v) => { getW(wid).blocks[i].items[j].done = v; saveNow(); rerender(); };
window.addSet = (wid, i, wu) => { const b = getW(wid).blocks[i]; const l = b.sets[b.sets.length - 1] || { w: '', r: '' }; b.sets.push({ w: l.w, r: l.r, done: false, ...(wu ? { wu: true } : {}) }); saveNow(); rerender(); };
window.delSet = (wid, i, j) => { getW(wid).blocks[i].sets.splice(j, 1); invalidate(); saveNow(); rerender(); };
window.blockMenu = async (wid, i) => {
  const w = getW(wid), b = w.blocks[i];
  const opts = [{ label: 'Move up' }, { label: 'Move down' }];
  if (b.type === 'cond') opts.push({ label: 'Save as a reusable piece' });
  opts.push({ label: 'Remove', cls: 'btn-danger' });
  const k = await sheet('Options', opts); if (k < 0) return;
  const lbl = opts[k].label;
  if (lbl === 'Move up' && i > 0) [w.blocks[i - 1], w.blocks[i]] = [w.blocks[i], w.blocks[i - 1]];
  if (lbl === 'Move down' && i < w.blocks.length - 1) [w.blocks[i + 1], w.blocks[i]] = [w.blocks[i], w.blocks[i + 1]];
  if (lbl === 'Save as a reusable piece') { const name = await ask('Name this piece', b.title || 'My workout'); if (name) { S.templates.push({ id: uid(), name, block: JSON.parse(JSON.stringify({ ...b, result: {}, label: '' })) }); toast('Saved. Find it under ＋ Add → Saved pieces.'); } }
  if (lbl === 'Remove' && await okay('Remove this from the workout?', 'Remove')) w.blocks.splice(i, 1);
  invalidate(); saveNow(); rerender();
};
window.finishWorkout = wid => {
  const w = getW(wid); stopRest(); keepAwake(false);
  // drop empty sets
  w.blocks.forEach(b => { if (b.type === 'strength') { b.sets = b.sets.filter(s => s.r !== '' && s.r > 0); b.sets.forEach(s => s.done = true); } });
  w.blocks = w.blocks.filter(b => b.type !== 'strength' || b.sets.length);
  // PRs vs. everything before this workout
  const prs = [];
  w.status = 'done'; invalidate();
  for (const b of w.blocks.filter(b => b.type === 'strength')) {
    const others = S.workouts.filter(x => x.id !== w.id); const saved = S.workouts; S.workouts = others; invalidate();
    const before = repMaxes(b.exercise), prevSum = liftSummary(b.exercise); S.workouts = saved; invalidate();
    const bw = workoutBW(w);
    for (const s of b.sets) {
      if (s.wu || s.done === false) continue;
      const pm = before[s.r];
      if (pm && (+s.w || 0) > pm.w) prs.push(`${b.exercise}: ${wLabel(b.exercise, +s.w)} × ${s.r} (old best ${wLabel(b.exercise, pm.w)})`);
      const v = setE1(b.exercise, s, bw); if (prevSum && v && v > prevSum.best + .5 && !prs.some(p => p.startsWith('Est'))) prs.push(`Est. 1RM ${b.exercise}: ${wLabel(b.exercise, Math.round(v))} (all-time best)`);
    }
    if (b.rx && b.rx.test) {
      const two = b.sets.filter(s => s.r >= 2 && s.done !== false && !s.wu).reduce((a, s) => Math.max(a, +s.w || 0), -1);
      if (two >= 0 && (two > 0 || b.exercise === 'Pull-Up')) { (S.twoRMs[b.exercise] = S.twoRMs[b.exercise] || []).push({ lb: two, date: w.date, src: `Week ${progDay(w.programDay).week} test` }); prs.push(`New 2-rep max for the program: ${wLabel(b.exercise, two)} lb`); }
    }
  }
  w.prs = [...new Set(prs)];
  if (w.programDay) S.program.completed[w.programDay] = w.id;
  invalidate(); saveNow(); rerender(); window.scrollTo(0, 0);
  toast(prs.length ? '🏆 Workout saved — new PRs!' : '✅ Workout saved');
};
window.deleteWorkout = async wid => {
  if (!(await okay('Delete this workout for good?', 'Delete'))) return;
  const w = getW(wid); S.workouts = S.workouts.filter(x => x.id !== wid);
  if (w.programDay && S.program.completed[w.programDay] === wid) delete S.program.completed[w.programDay];
  invalidate(); saveNow(); location.hash = '#history';
};
window.saveAsTemplateWorkout = wid => {
  const w = getW(wid);
  const n = { id: uid(), date: today(), name: w.name, programDay: undefined, status: 'active', notes: '', blocks: JSON.parse(JSON.stringify(w.blocks)).map(b => { if (b.sets) b.sets.forEach(s => s.done = false); if (b.items) b.items.forEach(x => x.done = false); if (b.result) b.result = {}; return b; }) };
  delete n.programDay; S.workouts.push(n); invalidate(); saveNow(); location.hash = '#workout-' + n.id; toast('Copied as a new workout for today');
};

/* ---------- history ---------- */
let histFilter = '', histLimit = 60;
views.history = () => {
  const ws = [...S.workouts].filter(w => w.status === 'done' || w.status === 'active').sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
  const q = histFilter.toLowerCase();
  const list = q ? ws.filter(w => (workoutTitle(w) + ' ' + w.blocks.map(b => (b.exercise || '') + ' ' + (b.title || '') + ' ' + (b.movements || []).join(' ')).join(' ') + ' ' + (w.notes || '')).toLowerCase().includes(q)) : ws;
  let h = `<h1>History</h1><input id="hq" placeholder="Search workouts, exercises, names…" value="${esc(histFilter)}"><p class="small muted">${list.length} workouts</p><div class="card list" style="padding:4px 14px">`;
  let month = '';
  for (const w of list.slice(0, histLimit)) {
    const m = w.date.slice(0, 7);
    if (m !== month) { month = m; h += `<div class="small muted" style="padding:12px 0 2px;text-transform:uppercase;letter-spacing:.05em">${MON[+m.slice(5) - 1]} ${m.slice(0, 4)}</div>`; }
    const top = w.blocks.filter(b => b.type === 'strength').map(b => { const ss = b.sets.filter(s => !s.wu && s.r > 0); if (!ss.length) return ''; const t = ss.reduce((a, s) => (+s.w || 0) > (+a.w || 0) ? s : a, ss[0]); return `${b.exercise} ${wLabel(b.exercise, +t.w || 0)}×${t.r}`; }).filter(Boolean);
    const cond = w.blocks.filter(b => b.type === 'cond' && condResultStr(b)).map(b => condResultStr(b)).concat(w.blocks.filter(b => b.type === 'test' && b.value !== '' && b.value != null).map(b => { const ev = EVENTS.find(e => e.k === b.event); return ev ? `${ev.short} ${fmtEv(ev, b.value)}` : ''; }));
    h += `<div class="item" onclick="location.hash='#workout-${w.id}'"><div style="width:44px;text-align:center"><div style="font-size:18px;font-weight:700">${+w.date.slice(8)}</div><div class="small muted">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(dnum(w.date) * 864e5).getUTCDay()]}</div></div><div class="grow"><div style="font-weight:600">${esc(workoutTitle(w))}${w.status === 'active' ? ' <span class="tag">in progress</span>' : ''}${w.prs && w.prs.length ? ' <span class="tag pr">PR</span>' : ''}</div><div class="small muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(top.concat(cond).join(' · ') || '—')}</div></div><span class="muted">›</span></div>`;
  }
  h += `</div>`;
  if (list.length > histLimit) h += `<button class="btn-block" onclick="histLimit+=100;rerender()">Show more</button>`;
  return h;
};
views.history_after = () => { const q = $('#hq'); q.oninput = () => { histFilter = q.value; histLimit = 60; const pos = q.selectionStart; route(); const n = $('#hq'); n.focus(); n.setSelectionRange(pos, pos); }; };

/* ---------- lifts ---------- */
views.lifts = () => {
  let h = `<h1>Lifts</h1>`;
  for (const ex of CORE) {
    const s = liftSummary(ex), t = twoRM(ex), bw = currentBW();
    const pts = sessions(ex).filter(x => x.e1 != null && daysBetween(x.date, today()) <= 365).map(x => ({ date: x.date, y: x.e1 }));
    h += `<div class="card tap" onclick="location.hash='#lift-${slug(ex)}'"><div class="row between"><h3>${CORE_LABEL[ex]}</h3><span class="muted">›</span></div>
      <div class="grid2" style="grid-template-columns:repeat(3,1fr)"><div class="stat"><div class="v">${t ? wLabel(ex, t.lb) : '–'}</div><div class="l">Program 2RM</div></div><div class="stat"><div class="v">${s ? wLabel(ex, Math.round(s.current)) : '–'}</div><div class="l">Est. 1RM now</div></div><div class="stat"><div class="v">${s ? wLabel(ex, Math.round(s.best)) : '–'}</div><div class="l">Best ever</div></div></div>
      <p class="small muted">${s ? (ex === 'Pull-Up' ? `${fmtNum((bw + s.current) / bw, 2)}× BW total load` : `${fmtNum(s.current / bw, 2)}× bodyweight`) + ' · last trained ' + fmtDate(s.last.date) : ''}</p></div>`;
  }
  const others = Object.entries(sessionsAll()).filter(([k]) => !CORE.includes(k)).sort((a, b) => b[1].length - a[1].length);
  h += `<h2>Other exercises</h2><div class="card list" style="padding:4px 14px">${others.map(([k, v]) => `<div class="item" onclick="location.hash='#lift-${slug(k)}'"><div class="grow">${esc(k)}</div><span class="small muted">${v.length} sessions · last ${fmtDate(v[v.length - 1].date, false)} '${v[v.length - 1].date.slice(2, 4)}</span><span class="muted">›</span></div>`).join('')}</div>`;
  return h;
};
let liftRange = '1Y';
views.lift = ex => {
  const s = liftSummary(ex), t = twoRM(ex), all = sessions(ex);
  const pull = ex === 'Pull-Up';
  let h = `<a href="#lifts" class="btn-ghost" style="padding-left:0">‹ Lifts</a><h1>${esc(CORE_LABEL[ex] || ex)}</h1>`;
  if (!s) return h + '<p class="muted">No sets logged yet.</p>';
  h += `<div class="grid2" style="grid-template-columns:repeat(3,1fr)">${t ? `<div class="stat"><div class="v">${wLabel(ex, t.lb)}</div><div class="l">Program 2RM</div></div>` : ''}<div class="stat"><div class="v">${wLabel(ex, Math.round(s.current))}</div><div class="l">Est. 1RM now</div></div><div class="stat"><div class="v">${wLabel(ex, Math.round(s.best))}</div><div class="l">Best (${fmtDate(s.bestDate, false)} '${s.bestDate.slice(2, 4)})</div></div></div>`;
  if (CORE.includes(ex)) h += `<button class="btn-sm" style="margin-top:8px" onclick="edit2RM('${ex}')">Edit program 2RM</button>`;
  const cut = { '3M': 92, '1Y': 366, 'All': 1e9 }[liftRange];
  const pts = all.filter(x => x.e1 != null && daysBetween(x.date, today()) <= cut).map(x => ({ date: x.date, y: x.e1, wid: x.wid, label: `${wLabel(ex, Math.round(x.e1))} est. 1RM · ${wLabel(ex, +x.best.w || 0)}×${x.best.r}` }));
  h += `<h2>Estimated 1-rep max</h2><div class="chips">${['3M', '1Y', 'All'].map(r => `<button class="chip ${liftRange === r ? 'on' : ''}" onclick="liftRange='${r}';rerender()">${r === 'All' ? 'All time' : r === '1Y' ? '1 year' : '3 months'}</button>`).join('')}</div>`;
  h += `<div class="legend"><span><i style="border-color:var(--series-1)"></i>Best set each session${pull ? ' (added lb)' : ''}</span><span><i style="border-color:var(--series-2);border-top-style:dashed"></i>All-time best</span></div>`;
  h += pts.length ? lineChart(pts, { refY: s.best, link: true }) : `<p class="muted small">No sessions in this range. Try "All time".</p>`;
  h += `<p class="small muted">Tap or drag on the chart to read values. Estimates use the Epley formula on sets of 10 reps or fewer${pull ? ', counting your bodyweight on the bar' : ''}.</p>`;
  const vp = all.filter(x => daysBetween(x.date, today()) <= cut).map(x => ({ date: x.date, y: x.vol, wid: x.wid, label: `${fmtNum(x.vol)} lb total` }));
  if (vp.length > 1) h += `<h2>Volume per session</h2><div class="legend"><span><i style="border-color:var(--series-1)"></i>Total lb lifted (weight × reps${pull ? ', incl. bodyweight' : ''})</span></div>` + lineChart(vp, { h: 140, link: true });
  if (pull) { const rp = all.filter(x => x.maxReps > 0 && daysBetween(x.date, today()) <= cut).map(x => ({ date: x.date, y: x.maxReps, wid: x.wid, label: `${x.maxReps} bodyweight reps` })); if (rp.length > 1) h += `<h2>Bodyweight reps (best set)</h2>` + lineChart(rp, { h: 140, link: true }); }
  const rm = repMaxes(ex);
  h += `<h2>Rep maxes</h2><table class="tbl"><tr><th>Reps</th><th class="n">Best weight</th><th class="n">Date</th></tr>${Object.keys(rm).map(Number).sort((a, b) => a - b).map(r => `<tr onclick="location.hash='#workout-${rm[r].wid}'"><td>${r}</td><td class="n">${wLabel(ex, rm[r].w)} lb</td><td class="n muted">${fmtDate(rm[r].date)}</td></tr>`).join('')}</table>`;
  if (t) h += `<h2>2RM history</h2><table class="tbl"><tr><th>Date</th><th class="n">2RM</th><th>Source</th></tr>${[...S.twoRMs[ex]].reverse().map(x => `<tr><td>${fmtDate(x.date)}</td><td class="n">${wLabel(ex, x.lb)}</td><td class="muted small">${esc(x.src || '')}</td></tr>`).join('')}</table>`;
  h += `<h2>Sessions</h2><table class="tbl"><tr><th>Date</th><th>Best set</th><th class="n">e1RM</th></tr>${[...all].reverse().slice(0, 40).map(x => `<tr onclick="location.hash='#workout-${x.wid}'"><td>${fmtDate(x.date)}</td><td>${x.best ? wLabel(ex, +x.best.w || 0) + '×' + x.best.r : '–'}</td><td class="n">${x.e1 != null ? wLabel(ex, Math.round(x.e1)) : '–'}</td></tr>`).join('')}</table>`;
  return h;
};
window.edit2RM = async ex => {
  const t = twoRM(ex); const v = await ask(`New 2-rep max: ${CORE_LABEL[ex]}`, t ? t.lb : '', { label: ex === 'Pull-Up' ? 'lb added' : 'lb', mode: 'decimal' });
  if (v === null) return; const n = num(v); if (n == null) return;
  (S.twoRMs[ex] = S.twoRMs[ex] || []).push({ lb: n, date: today(), src: 'Edited by hand' }); saveNow(); rerender();
};

/* ---------- fitness ---------- */
views.fitness = () => {
  const st = allEvents(), tested = st.filter(s => !s.none);
  let h = `<h1>Fitness</h1>`;
  if ((S.settings.pauses || []).some(p => !p.end)) h += `<div class="card" style="border-color:var(--warn)"><b>Injury pause is on.</b> <span class="sec small">Decay is frozen.</span></div>`;
  h += `<div class="grid2"><div class="stat card" style="margin:0"><div class="v">${fmtNum(avg(tested.map(s => s.now)), 1)}</div><div class="l">Current average</div></div><div class="stat card" style="margin:0"><div class="v">${fmtNum(avg(tested.map(s => s.best.score)), 1)}</div><div class="l">Best-ever average</div></div></div>`;
  h += `<div class="legend" style="margin-top:14px"><span><i style="border-color:var(--series-1)"></i>Current (with decay)</span><span><i style="border-color:var(--series-2);border-top-style:dashed"></i>Best ever</span></div>`;
  h += `<div class="card" style="padding:6px">${radarSVG(st, 360)}</div>`;
  h += `<p class="small muted">Each spoke uses your most recent result. After 30 days without a new one it drops a set % every 30 days (never below 75% of that score). Deadlift, bench, front squat and weighted pull-up refresh from your normal training; the rest refresh when you log a test.</p>`;
  h += `<button class="btn-primary btn-block" onclick="logTest()">＋ Log a test result</button>`;
  const bwN = currentBW(), hN = S.settings.heightIn || 71;
  h += `<h2>Standards</h2><p class="small muted">What each score takes at your current ${bwN} lb and ${hN}". Bar = score now; ┊ = best ever. Tap an event for the full ladder.</p>`;
  for (const s of st) {
    const ev = s.ev, now = s.none ? 0 : s.now, best = s.none ? 0 : s.best.score;
    h += `<div class="card tap std" onclick="location.hash='#event-${ev.k}'">
      <div class="row between"><div class="grow"><b>${esc(ev.label)}</b><div class="small muted">${s.none ? 'Not tested yet' : `You: <b class="sec">${fmtEv(ev, s.cur.value)}</b> · ${fmtDate(s.cur.date)}${s.cur.src === 'lift' ? ' (training)' : ''}`}</div></div>
      <div style="text-align:right"><div style="font-size:22px;font-weight:700;font-variant-numeric:tabular-nums">${s.none ? '–' : Math.round(now) + '%'}</div><div class="small muted">${s.none ? '' : (s.mult < 1 ? `${Math.round(s.raw)}% before decay` : 'no decay yet')}</div></div></div>
      <div class="sbar"><span style="width:${now}%"></span>${s.none ? '' : `<i style="left:${best}%"></i>`}</div>
      <div class="sgrid">${[0, 50, 75, 100].map(p => `<div><div class="muted">${p}%</div><b>${fmtStd(ev, valAt(ev, p, bwN, hN))}</b></div>`).join('')}</div>
    </div>`;
  }
  h += `<h2>Decay rates</h2><table class="tbl"><tr><th>Type</th><th class="n">Per 30 days</th></tr>${Object.entries(RATES).map(([k, r]) => `<tr><td>${CAT_LABEL[k]}<div class="small muted">${EVENTS.filter(e => e.cat === k).map(e => e.short).join(', ')}</div></td><td class="n">${r * 100}%</td></tr>`).join('')}</table>`;
  return h;
};
views.event = k => {
  const ev = EVENTS.find(e => e.k === k), s = eventState(ev);
  let h = `<a href="#fitness" class="btn-ghost" style="padding-left:0">‹ Fitness</a><h1 style="font-size:24px">${esc(ev.label)}</h1><p class="small muted">Scoring: ${esc(ev.range)} = 0–100 · ${CAT_LABEL[ev.cat]}, −${RATES[ev.cat] * 100}% per 30 days</p>`;
  if (!s.none) {
    h += `<div class="grid2" style="grid-template-columns:repeat(3,1fr)"><div class="stat"><div class="v">${fmtNum(s.now, 0)}</div><div class="l">Score now</div></div><div class="stat"><div class="v">${fmtNum(s.raw, 0)}</div><div class="l">Before decay</div></div><div class="stat"><div class="v">${fmtNum(s.best.score, 0)}</div><div class="l">Best ever</div></div></div>`;
    h += `<div class="card"><p>Current result: <b>${fmtEv(ev, s.cur.value)}</b> on ${fmtDate(s.cur.date)} ${s.cur.src === 'lift' ? '(estimated from training)' : ''}</p><p class="small sec">${s.months} decay step${s.months === 1 ? '' : 's'} so far (×${fmtNum(s.mult, 3)}).${s.nextDrop ? ` Next drop on ${fmtDate(s.nextDrop)} unless you retest.` : ' At the 75% floor.'}</p><p class="small muted">Best ever: ${fmtEv(ev, s.best.value)} on ${fmtDate(s.best.date)}</p></div>`;
  }
  h += `<button class="btn-primary btn-block" onclick="logTest('${k}')">＋ Log a new result</button>`;
  { const bwN = currentBW(), hN = S.settings.heightIn || 71, me = s.none ? -1 : s.now, raw = s.none ? -1 : s.raw;
    h += `<h2>Standards ladder</h2><p class="small muted">At ${bwN} lb${ev.k === 'longjump' ? ` and ${hN}"` : ''}. ${ev.lower ? 'Lower is better.' : 'Higher is better.'}</p><table class="tbl"><tr><th>Score</th><th class="n">${ev.lower ? 'Need at most' : 'Need'}</th><th></th></tr>`;
    for (let p = 100; p >= 0; p -= 10) { const mark = me >= p && me < p + 10 ? '◀ now' : raw >= p && raw < p + 10 && raw !== me ? '◀ before decay' : ''; h += `<tr${mark === '◀ now' ? ' style="background:var(--surface-2)"' : ''}><td>${p}%</td><td class="n"><b>${fmtStd(ev, valAt(ev, p, bwN, hN))}</b></td><td class="small" style="color:var(--series-1)">${mark}</td></tr>`; }
    h += `</table>`; }
  const tests = S.tests.filter(t => t.event === k).concat(testBlocks().filter(t => t.event === k).map(t => ({ ...t, id: null, note: 'Logged in a workout' }))).sort((a, b) => a.date < b.date ? 1 : -1);
  h += `<h2>Test results</h2>${tests.length ? `<table class="tbl"><tr><th>Date</th><th class="n">Result</th><th class="n">Score</th><th></th></tr>${tests.map(t => `<tr><td>${fmtDate(t.date)}<div class="small muted">${esc(t.note || '')}</div></td><td class="n">${fmtEv(ev, t.value)}</td><td class="n">${fmtNum(ev.score(t.value, t.bw || bwAt(t.date), S.settings.heightIn), 0)}</td><td class="n">${t.id ? `<button class="x" onclick="delTest('${t.id}','${k}')">×</button>` : `<a href="#workout-${t.wid}">›</a>`}</td></tr>`).join('')}</table>` : '<p class="muted">None yet.</p>'}`;
  if (ev.feed) h += `<p class="small muted">This event also updates from your ${esc(ev.feed)} training sets.</p>`;
  return h;
};
window.logTest = async k => {
  let ev = EVENTS.find(e => e.k === k);
  if (!ev) { const i = await sheet('Which event?', EVENTS.map(e => ({ label: esc(e.label) }))); if (i < 0) return; ev = EVENTS[i]; }
  const hint = ev.time ? 'mm:ss' : ev.unit;
  const r = await form(ev.label, [{ label: `Result (${hint})`, mode: ev.time ? 'text' : 'decimal', ph: ev.time ? '7:45' : '' }, { label: 'Date', type: 'date', value: today() }], 'Save result'); if (!r || r[0] === '') return;
  const v = r[0], date = r[1];
  const val = ev.time ? strToSec(v) : num(v); if (val == null) return toast('That number didn’t look right.');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  S.tests.push({ id: uid(), event: ev.k, date, value: val, bw: bwAt(date) }); saveNow();
  location.hash = '#event-' + ev.k; rerender(); toast('Result saved');
};
window.delTest = async (id, k) => { if (!(await okay('Delete this result?', 'Delete'))) return; S.tests = S.tests.filter(t => t.id !== id); saveNow(); rerender(); };

/* ---------- me / settings ---------- */
views.more = () => {
  const st = S.settings, paused = (st.pauses || []).some(p => !p.end);
  const bws = [...S.bodyweights].sort((a, b) => a.date < b.date ? -1 : 1);
  let h = `<h1>Me</h1>`;
  h += `<h2>Bodyweight</h2><div class="row"><div class="stat grow"><div class="v">${currentBW()} lb</div><div class="l">Current</div></div><button class="btn-primary" onclick="quickBW()">Log weight</button></div>`;
  h += `<div class="legend"><span><i style="border-color:var(--series-1)"></i>Bodyweight (lb)</span></div>` + lineChart(bws.map(b => ({ date: b.date, y: b.lb, label: b.lb + ' lb' })), { h: 150 });
  h += `<label class="f">Height (inches)</label><input inputmode="decimal" id="ht" value="${st.heightIn}">`;
  if (PREVIEW) h += `<h2>Backup to Google Sheet</h2><div class="card"><p class="small sec">Backup, restore and file export are turned off in this preview. They work in the installed app.</p></div>`;
  else h += `<h2>Backup to Google Sheet</h2><div class="card"><div data-syncbadge>${syncBadgeHTML()}</div>
    <label class="f">Backup web app URL</label><input id="su" value="${esc(st.syncUrl)}" placeholder="https://script.google.com/macros/s/…/exec" autocapitalize="off" autocorrect="off">
    <label class="f">Backup password</label><input id="sk" value="${esc(st.syncKey)}" placeholder="the SECRET you set in the script" autocapitalize="off" autocorrect="off">
    <div class="row wrap" style="margin-top:10px"><button class="btn-primary" onclick="saveSync()">Save &amp; back up now</button><button onclick="restoreBackup()">Restore from backup</button></div>
    <p class="small muted">Everything saves on this phone the moment you type. With this set up, it also copies to your Google Sheet automatically whenever you have signal.</p></div>`;
  h += `<h2>Program</h2><div class="card"><p>${PROGRAM_NAME}</p><p class="small muted">${Object.keys(S.program.completed).length}/70 days done${S.program.started ? ' · started ' + fmtDate(S.program.started) : ''}</p><button onclick="restartProgram()">Restart at Week 1 Day 1</button></div>`;
  h += `<h2>Injury pause</h2><div class="card"><p class="small sec">Freezes fitness decay while it's on. Off by default.</p><button onclick="togglePause()">${paused ? 'Turn pause OFF' : 'Turn pause on'}</button></div>`;
  if (!PREVIEW) h += `<h2>Extra safety copy</h2><div class="card"><p class="small sec">Save a full copy as a file (to Files / iCloud Drive), or load one back.</p><div class="row wrap"><button onclick="exportJSON()">Export file</button><button onclick="document.getElementById('imp').click()">Import file</button><input type="file" id="imp" accept="application/json,.json" style="display:none" onchange="importJSON(this)"></div></div>`;
  h += `<h2>App version</h2><div class="card"><div class="row between"><div><b>${APP_VERSION}</b><div class="small muted">Not seeing a new update? Tap this. Your data is not touched.</div></div><button class="btn-sm" onclick="forceUpdate()">Check for updates</button></div></div>`;
  h += `<p class="small muted" style="margin-top:20px">${S.workouts.length} workouts · ${S.workouts.reduce((a, w) => a + w.blocks.reduce((x, b) => x + (b.sets ? b.sets.length : 0), 0), 0)} sets stored on this phone.</p><p class="small muted" id="persist"></p>`;
  return h;
};
views.more_after = () => {
  $('#ht').onchange = e => { const v = num(e.target.value); if (v) { S.settings.heightIn = v; saveNow(); toast('Height saved'); } };
  if (navigator.storage && navigator.storage.persisted) navigator.storage.persisted().then(p => { const el = $('#persist'); if (el) el.textContent = p ? 'Storage: protected from automatic cleanup.' : 'Storage: normal (add to Home Screen for best protection).'; });
};
window.saveSync = async () => {
  S.settings.syncUrl = $('#su').value.trim(); S.settings.syncKey = $('#sk').value.trim(); saveNow();
  if (!S.settings.syncUrl) return toast('Backup turned off');
  try {
    const j = await fetchBackup(S.settings.syncUrl, S.settings.syncKey);
    if (j.state && j.state.created !== S.created && await okay(`A backup already exists (${j.state.workouts.length} workouts, saved ${new Date(j.savedAt || j.state.updated).toLocaleString()}).\n\nLoad it onto this phone? (Recommended. Cancel keeps this phone's data.)`, 'Load backup')) {
      const url = S.settings.syncUrl, key = S.settings.syncKey; adopt(j.state); S.settings.syncUrl = url; S.settings.syncKey = key; persist(false); LS.setItem(KEY + '.dirty', '0'); toast('✅ Restored from backup'); location.hash = '#today'; route(); return;
    }
  } catch (e) { if (/password/.test(e.message)) return toast('⚠️ Wrong backup password'); }
  toast('Backing up…'); LS.setItem(KEY + '.dirty', '1'); await doSync(true);
  toast(syncStatus ? '⚠️ ' + esc(syncStatus) : '✅ Backed up to Google'); rerender();
};
window.restoreBackup = async () => {
  const url = $('#su').value.trim(), key = $('#sk').value.trim();
  if (!url) return toast('Enter your backup URL first');
  try {
    const j = await fetchBackup(url, key);
    if (!j.state) return toast('No backup found yet');
    const st = j.state;
    if (!(await okay(`Replace what's on this phone with the backup from ${new Date(j.savedAt || st.updated).toLocaleString()}?\n(${st.workouts.length} workouts in backup, ${S.workouts.length} on phone)`, 'Restore'))) return;
    adopt(st); S.settings.syncUrl = url; S.settings.syncKey = key; persist(false); LS.setItem(KEY + '.dirty', '0'); toast('✅ Restored'); location.hash = '#today'; route();
  } catch (e) { toast('⚠️ Restore failed: ' + esc(e.message)); }
};
window.togglePause = () => {
  S.settings.pauses = S.settings.pauses || [];
  const open = S.settings.pauses.find(p => !p.end);
  if (open) { open.end = today(); toast('Pause off — decay running'); } else { S.settings.pauses.push({ start: today() }); toast('Pause on — decay frozen'); }
  saveNow(); rerender();
};
window.exportJSON = async () => {
  const blob = new Blob([JSON.stringify(S)], { type: 'application/json' }); const name = `training-log-${today()}.json`;
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
};
window.importJSON = inp => {
  const f = inp.files[0]; if (!f) return; const r = new FileReader();
  r.onload = async () => { try { const st = JSON.parse(r.result); if (!st.workouts) throw new Error('not a Training Log file'); if (!(await okay(`Replace this phone's data with this file? (${st.workouts.length} workouts)`, 'Replace'))) return; const keep = { syncUrl: S.settings.syncUrl, syncKey: S.settings.syncKey }; adopt(st); Object.assign(S.settings, keep); saveNow(); toast('✅ Imported'); location.hash = '#today'; route(); } catch (e) { toast('⚠️ ' + esc(e.message)); } };
  r.readAsText(f);
};


/* =====================================================================
   Pick lists, structured movements, test events, paces, timers
   ===================================================================== */

/* ---------- lists ---------- */
const BASE_CARDIO = ['Run', 'Row', 'Assault Bike', 'Ski Erg', 'Bike', 'Swim', 'Walk', 'Ruck', 'Jump Rope', 'Stair Climber', 'Sled Push'];
const BASE_EXERCISES = ['Back Squat', 'Front Squat', 'Deadlift', 'Romanian Deadlift', 'Strict Press', 'Push Press', 'Bench Press', 'Incline Bench Press', 'Pull-Up', 'Chin Ups', 'Barbell Row', 'Power Clean', 'Hang Power Clean', 'Clean', 'Clean and Jerk', 'Snatch', 'Hip Thrust', 'Dip', 'Lunge', 'Bulgarian Split Squat', 'Dumbbell Bench Press', 'Dumbbell Shoulder Press', 'Lat Pulldown', 'Good Morning', 'Barbell Shrug', 'Dumbbell Curl'];
const BASE_MOVES = ['Air Squat', 'Push-Up', 'Hand Release Push-Up', 'Pull-Up', 'Burpee', 'Sit-Up', 'Toes to Bar', 'Box Jump', 'Wall Ball', 'Kettlebell Swing', 'Thruster', 'Lunge', 'Walking Lunge', 'Double Under', 'Jump Rope', 'Plank', 'Farmer\'s Carry', 'Sandbag Carry', 'Run', 'Row', 'Assault Bike', 'Ski Erg', 'Rest'];
function ensureCustom() { S.custom = S.custom || { exercise: [], cardio: [], movement: [] }; return S.custom; }
function listFor(kind) {
  const c = ensureCustom(); const set = new Set();
  if (kind === 'exercise') { BASE_EXERCISES.concat(c.exercise).forEach(x => set.add(x)); S.workouts.forEach(w => (w.blocks || []).forEach(b => b.type === 'strength' && b.exercise && set.add(b.exercise))); }
  if (kind === 'cardio') { BASE_CARDIO.concat(c.cardio).forEach(x => set.add(x)); S.workouts.forEach(w => (w.blocks || []).forEach(b => b.type === 'cardio' && b.mode && set.add(b.mode))); }
  if (kind === 'movement') {
    BASE_MOVES.concat(c.movement).forEach(x => set.add(x));
    for (const d of PROGRAM) for (const p of d.stamina || []) for (const t of p.movements.concat([p.title])) { const m = parseMv(t); if (m.kind !== 'note' && m.kind !== 'rest' && m.name && m.name.length < 60) set.add(m.name); }
    S.workouts.forEach(w => (w.blocks || []).forEach(b => b.type === 'cond' && (b.movements || []).forEach(m => m && m.name && m.kind !== 'note' && m.kind !== 'rest' && set.add(m.name))));
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}
function pick(title, kind, current = '') {
  return new Promise(res => {
    const el = document.createElement('div'); el.className = 'sheet';
    el.innerHTML = `<div class="panel picker"><h3>${esc(title)}</h3><input class="pq" placeholder="Search or type a new one" value="" autocapitalize="words" autocorrect="off"><div class="plist"></div><button class="btn-ghost pcancel" style="text-align:center">Cancel</button></div>`;
    const all = listFor(kind), q = el.querySelector('.pq'), list = el.querySelector('.plist');
    const draw = () => {
      const v = q.value.trim(), lv = v.toLowerCase();
      const hits = all.filter(x => x.toLowerCase().includes(lv));
      const exact = all.some(x => x.toLowerCase() === lv);
      list.innerHTML = (v && !exact ? `<button class="padd" data-new="1">＋ Add “${esc(v)}”</button>` : '') + hits.map(x => `<button class="pitem ${x === current ? 'on' : ''}" data-v="${esc(x)}">${esc(x)}</button>`).join('') || '<p class="muted small">Nothing yet. Type a name above.</p>';
    };
    const done = v => { el.remove(); res(v); };
    el.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (e.target === el || (b && b.classList.contains('pcancel'))) return done(null);
      if (!b) return;
      if (b.dataset.new) { const v = q.value.trim(); const c = ensureCustom(); if (!c[kind].includes(v)) c[kind].push(v); saveNow(); return done(v); }
      if (b.dataset.v) done(b.dataset.v);
    });
    q.addEventListener('input', draw);
    q.addEventListener('keydown', e => { if (e.key === 'Enter') { const f = list.querySelector('button'); if (f) f.click(); } });
    document.body.appendChild(el); draw(); setTimeout(() => q.focus(), 60);
  });
}

/* ---------- movement parsing (program text → structured) ---------- */
const UNIT_LABEL = { reps: 'reps', cal: 'cal', m: 'm', ft: 'ft', mi: 'mi', time: 'time', rest: 'rest' };
function parseDur(t) {
  const m = String(t).match(/(\d+(?::\d+)?)\s*(second|sec|s\b|minute|min)/i);
  if (!m) return null;
  const v = m[1].includes(':') ? strToSec(m[1]) : +m[1];
  return /^s/i.test(m[2]) ? v : (m[1].includes(':') ? v : v * 60);
}
function parseMv(raw) {
  let t = String(raw || '').replace(/\s+/g, ' ').trim();
  const out = { name: '', kind: 'reps', amt: '', wt: '', note: '' };
  if (!t) return out;
  const sm = t.match(/^Minute (\d+):\s*(.*)$/i); if (sm) { out.slot = +sm[1]; t = sm[2]; }
  if (/^(Then|With Remaining Time.*|\d+ Rounds?)$/i.test(t)) return { name: t, kind: 'note', amt: '', wt: '', note: '' };
  const rest = t.match(/^(?:Walk\/)?Rest\b\s*(.*)$/i);
  if (rest) { const d = parseDur(rest[1]); return { name: 'Rest', kind: 'rest', amt: d ? secToStr(d) : '', wt: '', note: /after each round/i.test(t) ? 'after each round' : (/walk/i.test(t) ? 'walk/rest' : '') }; }
  const notes = [];
  t = t.replace(/\(([^)]*)\)/g, (_, x) => { notes.push(x.trim()); return ''; }).replace(/\s+/g, ' ').trim();
  let [main, ...atParts] = t.split(/\s@\s|\s@(?=\d)/); main = (main || '').trim(); let at = atParts.join(' @ ').trim();
  // @ part
  if (at) {
    at = at.replace(/(\d+(?:\.\d+)?)\/\d+(?:\.\d+)?\s*(lbs?|ins?|ft)\b/gi, (_, a, u) => {
      if (/^lb/i.test(u)) { out.wt = +a; return ''; }
      notes.push(`${a} ${/^in/i.test(u) ? 'in' : u}`); return '';
    });
    at = at.replace(/^(\d+(?:\.\d+)?)\s*lbs?\b/i, (_, a) => { out.wt = +a; return ''; });
    const pace = at.match(/(\d)K\s*pace from Week 1/i); if (pace) { out.pace = pace[1] + 'k'; at = at.replace(pace[0], ''); }
    const bwp = at.match(/(\d+)% of Bodyweight/i); if (bwp) { out.wtPct = +bwp[1]; at = at.replace(bwp[0], ''); }
    const cal = at.match(/^(\d+)\s*Calories?$/i); if (cal) { out.kind = 'cal'; out.amt = cal[1]; at = ''; }
    at = at.replace(/^[,\s]+|[,\s]+$/g, '');
    if (at) notes.unshift(at);
  }
  let mm;
  if ((mm = main.match(/^(\d+(?::\d+)?)\s*(second|seconds|minute|minutes)\s+(.+)$/i))) { out.kind = 'time'; out.amt = secToStr(/^s/i.test(mm[2]) ? +mm[1] : (mm[1].includes(':') ? strToSec(mm[1]) : +mm[1] * 60)); out.name = mm[3]; }
  else if ((mm = main.match(/^(\d+(?:\.\d+)?)\s*(km|k|m|mile|miles|mi|ft)\s+(.+)$/i))) { const u = mm[2].toLowerCase(); if (u === 'km' || u === 'k') { out.kind = 'm'; out.amt = String(+mm[1] * 1000); } else if (u.startsWith('mi')) { out.kind = 'mi'; out.amt = mm[1]; } else { out.kind = u; out.amt = mm[1]; } out.name = mm[3]; }
  else if ((mm = main.match(/^(\d+(?:[–-]\d+)?)\s+(.+)$/))) { out.name = mm[2]; if (out.kind !== 'cal') { out.amt = mm[1].replace('–', '-'); out.kind = /^(Row|Run|Ski|Ski Erg|Bike)\b/i.test(mm[2]) && +mm[1] >= 100 ? 'm' : 'reps'; } }
  else out.name = main;
  out.name = out.name.replace(/\s+/g, ' ').trim();
  out.note = notes.filter(Boolean).join(' · ');
  return out;
}
const mvAmtStr = m => !m.amt ? '' : m.kind === 'reps' ? m.amt : m.kind === 'time' || m.kind === 'rest' ? m.amt : `${m.amt} ${UNIT_LABEL[m.kind]}`;
function mvText(m) {
  if (!m) return ''; if (typeof m === 'string') return m;
  if (m.kind === 'note') return m.name;
  if (m.kind === 'rest') return `Rest ${m.amt}${m.note ? ' ' + m.note : ''}`;
  return [m.slot ? `Min ${m.slot}:` : '', mvAmtStr(m), m.name, m.wt ? `@ ${m.wt} lb` : '', m.note ? `(${m.note})` : ''].filter(Boolean).join(' ');
}
function mvFromText(t) { const m = parseMv(t); if (m.wtPct) m.wt = r5(currentBW() * m.wtPct / 100); return m; }
function migrateMovements() {
  for (const w of S.workouts) for (const b of w.blocks || []) if (b.type === 'cond' && (b.movements || []).some(m => typeof m === 'string')) b.movements = b.movements.filter(m => typeof m !== 'string' || m.trim()).map(m => typeof m === 'string' ? mvFromText(m) : m);
}
function condFromProgram(p, lbl) {
  let mv = p.movements.map(mvFromText);
  if (!mv.length) { const m = mvFromText(p.title.replace(/\s*[–-]\s*For Time$/i, '')); if (m.kind !== 'reps' || m.amt) mv = [m]; }
  const b = { type: 'cond', title: p.title, label: lbl, format: p.format, cap: p.cap || '', movements: mv, restAfter: p.restAfter || '', result: {} };
  const r = p.title.match(/(\d+)\s+(Rounds|Sets)/i); if (r) b.rounds = +r[1];
  const ev = p.title.match(/Every (\d+(?::\d+)?) Minutes?/i);
  if (p.format === 'emom') { b.every = 60; b.count = p.cap || ''; }
  else if (ev) { b.every = ev[1].includes(':') ? strToSec(ev[1]) : +ev[1] * 60; b.count = r ? +r[1] : (p.cap ? Math.round(p.cap * 60 / b.every) : ''); }
  b.sig = sigOf(b);
  return b;
}

/* ---------- paces from Week 1 rows ---------- */
function rowTime(dist) {
  let best = null;
  for (const w of S.workouts) for (const b of w.blocks || []) {
    if (b.type !== 'cond' || !(b.result && b.result.time > 0)) continue;
    const mv = (b.movements || []).filter(m => m && m.kind !== 'note' && m.kind !== 'rest');
    if (mv.length === 1 && /row/i.test(mv[0].name) && mv[0].kind === 'm' && +mv[0].amt === dist && (!best || w.date >= best.date)) best = { date: w.date, sec: b.result.time };
  }
  return best;
}
function paceInfo(m) {
  if (!m || !m.pace) return null;
  const ref = rowTime(m.pace === '2k' ? 2000 : 1000);
  if (!ref) return { missing: true, txt: `Log your ${m.pace === '2k' ? '2k' : '1k'} row time (Week 1) and the target pace shows here.` };
  const per500 = ref.sec / (m.pace === '2k' ? 4 : 2);
  const meters = m.kind === 'm' ? +m.amt : m.kind === 'mi' ? +m.amt * 1609.34 : null;
  return { per500, target: meters ? per500 * meters / 500 : null, txt: `${m.pace} pace ${secToStr(per500)}/500m${meters ? ` → <b>${secToStr(per500 * meters / 500)}</b> for ${fmtNum(meters)} m` : ''} <span class="muted">(from ${fmtDate(ref.date, false)})</span>` };
}

/* ---------- fitness test blocks ---------- */
function testBlocks() {
  const out = [];
  for (const w of S.workouts) (w.blocks || []).forEach(b => { if (b.type === 'test' && b.value !== '' && b.value != null && isFinite(b.value)) out.push({ event: b.event, value: +b.value, date: w.date, wid: w.id, bw: workoutBW(w) }); });
  return out;
}
function testHTML(w, b, i, del) {
  const ev = EVENTS.find(e => e.k === b.event); if (!ev) return '';
  const bw = workoutBW(w), h_ = S.settings.heightIn || 71;
  const v = b.value === '' || b.value == null ? null : +b.value;
  const sc = v != null && isFinite(v) ? ev.score(v, bw, h_) : null;
  return `<div class="card"><div class="blockhead"><span class="kind grow">Fitness test</span>${del}</div><b>${esc(ev.label)}</b>
    <p class="small muted">0% = ${fmtStd(ev, valAt(ev, 0, bw, h_))} · 50% = ${fmtStd(ev, valAt(ev, 50, bw, h_))} · 100% = ${fmtStd(ev, valAt(ev, 100, bw, h_))}</p>
    <div class="grid2"><div><label class="f">Result (${ev.time ? 'mm:ss' : ev.unit})</label><input data-b="${i}" data-f="testval" ${ev.time ? '' : 'inputmode="decimal"'} value="${v == null ? '' : esc(ev.time ? secToStr(v) : v)}" placeholder="${ev.time ? '7:45' : ''}"></div><div><label class="f">Score</label><div class="stat"><div class="v" data-score="${i}">${sc == null ? '–' : Math.round(sc) + '%'}</div></div></div></div>
    ${ev.k === 'goblet' ? `<p class="small muted">Goblet weight ⅓ BW ≈ ${r5(bw / 3)} lb</p>` : ev.k === 'axle' ? `<p class="small muted">Axle load 1.5× BW ≈ ${r5(bw * 1.5)} lb</p>` : ev.k === 'sandbag' ? `<p class="small muted">Sandbag = bodyweight ≈ ${r5(bw)} lb</p>` : ''}
    <input data-b="${i}" data-f="notes" value="${esc(b.notes || '')}" placeholder="Notes" style="margin-top:8px"></div>`;
}

/* ---------- conditioning block UI ---------- */
const KIND_OPTS = [['reps', 'reps'], ['cal', 'cal'], ['m', 'meters'], ['ft', 'feet'], ['mi', 'miles'], ['time', 'time'], ['rest', 'rest'], ['note', 'text']];
function condHTML(w, b, i, del) {
  const r = b.result || {};
  let h = `<div class="card cond"><div class="blockhead"><span class="kind grow">${esc(b.label || '')}${FORMATS[b.format] || 'Conditioning'}</span>${del}</div>`;
  h += `<input data-b="${i}" data-f="title" value="${esc(b.title)}" placeholder="Title" style="font-weight:600">`;
  h += `<div class="grid3"><div><label class="f">Format</label><select data-b="${i}" data-f="format">${Object.entries(FORMATS).map(([k, l]) => `<option value="${k}" ${b.format === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`;
  if (b.format === 'emom' || b.format === 'interval') h += `<div><label class="f">Every</label><input data-b="${i}" data-f="every" value="${esc(b.every ? secToStr(b.every) : '')}" placeholder="1:00"></div><div><label class="f">Rounds</label><input inputmode="numeric" data-b="${i}" data-f="count" value="${esc(b.count || '')}"></div>`;
  else h += `<div><label class="f">Rounds</label><input inputmode="numeric" data-b="${i}" data-f="rounds" value="${esc(b.rounds || '')}" placeholder="1"></div><div><label class="f">Cap (min)</label><input inputmode="decimal" data-b="${i}" data-f="cap" value="${esc(b.cap || '')}"></div>`;
  h += `</div><label class="f">Movements</label><div class="mvs">`;
  (b.movements || []).forEach((m, j) => {
    if (m.kind === 'note') { h += `<div class="mv note"><input data-b="${i}" data-m="${j}" data-f="name" value="${esc(m.name)}"><button class="x" onclick="delMv('${w.id}',${i},${j})">×</button></div>`; return; }
    if (m.kind === 'rest') { h += `<div class="mv rest"><span class="muted small">Rest</span><input data-b="${i}" data-m="${j}" data-f="amt" value="${esc(m.amt)}" placeholder="1:00" style="width:90px"><span class="small muted grow">${esc(m.note || '')}</span><button class="x" onclick="delMv('${w.id}',${i},${j})">×</button></div>`; return; }
    const pi = paceInfo(m);
    h += `<div class="mv"><div class="row"><button class="mvname grow" onclick="pickMv('${w.id}',${i},${j})">${m.slot ? `<span class="muted">Min ${m.slot} · </span>` : ''}${esc(m.name || 'Choose movement')}</button><button class="x" onclick="delMv('${w.id}',${i},${j})">×</button></div>
      <div class="mvf"><input data-b="${i}" data-m="${j}" data-f="amt" value="${esc(m.amt)}" ${m.kind === 'time' ? 'placeholder="0:30"' : 'inputmode="decimal"'}><select data-b="${i}" data-m="${j}" data-f="kind">${KIND_OPTS.map(([k, l]) => `<option value="${k}" ${m.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select><div class="wt"><input data-b="${i}" data-m="${j}" data-f="wt" inputmode="decimal" value="${esc(m.wt)}" placeholder="—"><span>lb</span></div></div>
      ${m.note ? `<div class="small muted">${esc(m.note)}</div>` : ''}${pi ? `<div class="small pace">${pi.txt}</div>` : ''}</div>`;
  });
  h += `</div><div class="row" style="margin-top:6px"><button class="btn-sm grow" onclick="addMv('${w.id}',${i})">＋ Movement</button><button class="btn-sm" onclick="addMv('${w.id}',${i},'rest')">＋ Rest</button></div>`;
  h += `<button class="btn-primary btn-block tstart" onclick="openTimer('${w.id}',${i})">▶ Start timer · ${esc(timerLabel(b))}</button>`;
  h += `<label class="f">Result</label><div class="grid2">`;
  if (b.format === 'amrap') h += `<div><input inputmode="numeric" data-b="${i}" data-f="res.rounds" value="${esc(r.rounds ?? '')}" placeholder="Rounds"></div><div><input inputmode="numeric" data-b="${i}" data-f="res.reps" value="${esc(r.reps ?? '')}" placeholder="+ Reps"></div>`;
  else h += `<div><input data-b="${i}" data-f="res.time" value="${esc(secToStr(r.time))}" placeholder="Time mm:ss"></div>`;
  h += `<div style="${b.format === 'amrap' ? 'grid-column:1/-1' : ''}"><input data-b="${i}" data-f="res.score" value="${esc(r.score || '')}" placeholder="${b.format === 'amrap' ? 'Other score (optional)' : 'Score: cals, meters, rounds…'}"></div></div>`;
  h += `<input data-b="${i}" data-f="res.notes" value="${esc(r.notes || '')}" placeholder="Notes / subs" style="margin-top:8px">`;
  if (b.restAfter) h += `<p class="small muted" style="margin-top:8px">Then: ${esc(b.restAfter)}</p>`;
  const prev = b.sig ? condHistory(b.sig, w.id) : [];
  if (prev.length) h += `<p class="small muted" style="margin-top:8px">Previous: ${prev.slice(0, 3).map(p => `<a href="#workout-${p.wid}">${fmtDate(p.date, false)}: ${esc(p.res)}</a>`).join(' · ')}</p>`;
  return h + `</div>`;
}
window.pickMv = async (wid, i, j) => {
  const b = getW(wid).blocks[i], m = b.movements[j];
  const v = await pick('Movement', 'movement', m.name); if (!v) return;
  m.name = v; if (/^(Run|Row|Ski Erg|Bike|Assault Bike|Swim)$/i.test(v) && m.kind === 'reps' && !m.amt) m.kind = /Assault|Bike/i.test(v) ? 'cal' : 'm';
  b.sig = sigOf(b); saveNow(); rerender();
};
window.addMv = async (wid, i, kind) => {
  const b = getW(wid).blocks[i]; b.movements = b.movements || [];
  if (kind === 'rest') b.movements.push({ name: 'Rest', kind: 'rest', amt: '1:00', wt: '', note: '' });
  else { const v = await pick('Add movement', 'movement'); if (!v) return; b.movements.push({ name: v, kind: /^(Run|Row|Ski Erg|Swim)$/i.test(v) ? 'm' : /Bike/i.test(v) ? 'cal' : 'reps', amt: '', wt: '', note: '' }); }
  b.sig = sigOf(b); saveNow(); rerender();
};
window.delMv = (wid, i, j) => { const b = getW(wid).blocks[i]; b.movements.splice(j, 1); b.sig = sigOf(b); saveNow(); rerender(); };
window.pickExercise = async (wid, i) => {
  const b = getW(wid).blocks[i]; const v = await pick('Exercise', 'exercise', b.exercise); if (!v) return;
  b.exercise = v; invalidate(); saveNow(); rerender();
};
window.pickCardio = async (wid, i) => {
  const b = getW(wid).blocks[i]; const v = await pick('Cardio type', 'cardio', b.mode); if (!v) return;
  b.mode = v; saveNow(); rerender();
};
function cardioHTML(w, b, i, del) {
  const r = b.result || {};
  return `<div class="card"><div class="blockhead"><span class="kind grow">Cardio</span>${del}</div><button class="mvname btn-block" onclick="pickCardio('${w.id}',${i})">${esc(b.mode || 'Choose type')}</button>
    <div class="grid2"><div><label class="f">Distance</label><div class="row" style="gap:6px"><input inputmode="decimal" data-b="${i}" data-f="dist" value="${esc(b.dist ?? b.distance ?? '')}"><select data-b="${i}" data-f="unit" style="width:84px">${['mi', 'm', 'km'].map(u => `<option ${(b.unit || 'mi') === u ? 'selected' : ''}>${u}</option>`).join('')}</select></div></div>
    <div><label class="f">Time</label><input data-b="${i}" data-f="res.time" value="${esc(secToStr(r.time))}" placeholder="mm:ss"></div><div><label class="f">Calories</label><input inputmode="decimal" data-b="${i}" data-f="cals" value="${esc(b.cals || '')}"></div><div><label class="f">Pace</label><div class="small sec" style="padding-top:12px">${cardioPace(b)}</div></div></div>
    <button class="btn-sm btn-block" style="margin-top:8px" onclick="openTimer('${w.id}',${i})">▶ Stopwatch</button>
    <input data-b="${i}" data-f="notes" value="${esc(b.notes || '')}" placeholder="Notes" style="margin-top:8px"></div>`;
}
function cardioPace(b) {
  const t = b.result && b.result.time, d = num(b.dist ?? b.distance); if (!t || !d) return '–';
  const u = b.unit || 'mi'; const mi = u === 'mi' ? d : u === 'km' ? d / 1.60934 : d / 1609.34;
  return `${secToStr(t / mi)} /mi` + (/row|ski/i.test(b.mode || '') ? ` · ${secToStr(t / (mi * 1609.34) * 500)} /500m` : '');
}

/* ---------- add menu ---------- */
window.addBlock = async wid => {
  const w = getW(wid);
  const opts = [{ label: '🏋️ Strength exercise (sets × reps)' }, { label: '⏱️ AMRAP' }, { label: '🏁 For Time' }, { label: '🔁 EMOM' }, { label: '⏲️ Every X minutes' }, { label: '🔂 Rounds / intervals' }, { label: '🏃 Cardio (run, row, bike…)' }, { label: '🎒 Ruck' }, { label: '🎯 Fitness test event…' }, { label: '📝 Note' }];
  if (S.templates.length) opts.push({ label: '⭐ Saved pieces…' });
  const k = await sheet('Add to workout', opts); if (k < 0) return;
  let b; const lbl = opts[k].label;
  if (k === 0) { const ex = await pick('Exercise', 'exercise'); if (!ex) return; b = { type: 'strength', exercise: ex, sets: [{ w: '', r: '', done: false }] }; }
  else if (k >= 1 && k <= 5) {
    const f = ['amrap', 'fortime', 'emom', 'interval', 'rounds'][k - 1];
    b = { type: 'cond', title: { amrap: '20 Minutes – AMRAP', fortime: 'For Time', emom: '12 Minutes – EMOM', interval: 'Every 3 Minutes for 5 Rounds', rounds: '4 Rounds' }[f], format: f, cap: f === 'amrap' ? 20 : '', movements: [], result: {} };
    if (f === 'emom') { b.every = 60; b.count = 12; } if (f === 'interval') { b.every = 180; b.count = 5; } if (f === 'rounds') b.rounds = 4;
    b.sig = sigOf(b);
  }
  else if (k === 6) { const m = await pick('Cardio type', 'cardio'); if (!m) return; b = { type: 'cardio', mode: m, dist: '', unit: /row|ski/i.test(m) ? 'm' : 'mi', cals: '', result: {} }; }
  else if (k === 7) b = { type: 'ruck', weight: '', minutes: '', distance: '', notes: '', result: {} };
  else if (k === 8) { const e = await sheet('Fitness test event', EVENTS.map(e => ({ label: esc(e.label) }))); if (e < 0) return; b = { type: 'test', event: EVENTS[e].k, value: '', notes: '' }; }
  else if (k === 9) b = { type: 'note', text: '' };
  else { const t = await sheet('Saved pieces', S.templates.map(t => ({ label: esc(t.name) }))); if (t < 0) return; b = JSON.parse(JSON.stringify(S.templates[t].block)); b.result = {}; if (b.sets) b.sets.forEach(s => s.done = false); }
  w.blocks.push(b); invalidate(); saveNow(); rerender();
  setTimeout(() => { const cards = document.querySelectorAll('#app .card'); const c = cards[cards.length - 1]; if (c) c.scrollIntoView({ block: 'center' }); }, 40);
};

/* ---------- sound + screen ---------- */
let AC = null;
function audio() { try { if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)(); if (AC.state === 'suspended') AC.resume(); } catch (e) { } return AC; }
function beep(kind = 'short') {
  const ac = audio(); if (!ac) return;
  const tones = kind === 'long' ? [[1320, 0, .7]] : kind === 'go' ? [[988, 0, .18], [1320, .2, .5]] : kind === 'double' ? [[880, 0, .12], [880, .18, .12]] : [[880, 0, .16]];
  for (const [f, at, dur] of tones) {
    const o = ac.createOscillator(), g = ac.createGain(); o.type = 'square'; o.frequency.value = f;
    const t0 = ac.currentTime + at; g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.35, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(ac.destination); o.start(t0); o.stop(t0 + dur + .05);
  }
  const f = document.getElementById('flash'); if (f) { f.classList.remove('on'); void f.offsetWidth; f.classList.add('on'); }
}
let wakeLock = null, wantWake = false;
async function keepAwake(on) {
  wantWake = on;
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && wantWake) keepAwake(true); });

/* ---------- strength rest timer ---------- */
let REST = null;
function restSecs(b) { if (b.rx && b.rx.rest) { const d = parseDur(b.rx.rest); if (d) return d; } return 120; }
function startRest(sec, label) {
  stopRest(true); audio();
  REST = { end: Date.now() + sec * 1000, total: sec, label, fired: {} };
  let el = document.getElementById('restbar'); if (!el) { el = document.createElement('div'); el.id = 'restbar'; document.body.appendChild(el); }
  el.innerHTML = `<div class="rb-bar"><span></span></div><div class="row"><div class="grow"><div class="small muted">Rest · ${esc(label)}</div><div class="rb-t">0:00</div></div><button class="btn-sm" onclick="addRest(30)">+30s</button><button class="btn-sm btn-danger" onclick="stopRest()">Stop</button></div>`;
  REST.iv = setInterval(tickRest, 200); tickRest();
}
function tickRest() {
  if (!REST) return; const left = Math.ceil((REST.end - Date.now()) / 1000);
  const el = document.getElementById('restbar'); if (!el) return;
  el.querySelector('.rb-t').textContent = left > 0 ? secToStr(left) : 'Go!';
  el.querySelector('.rb-bar span').style.width = Math.max(0, Math.min(100, (1 - left / REST.total) * 100)) + '%';
  for (const s of [3, 2, 1]) if (left === s && !REST.fired[s]) { REST.fired[s] = 1; beep('short'); }
  if (left <= 0 && !REST.fired[0]) { REST.fired[0] = 1; beep('long'); setTimeout(() => stopRest(), 2500); }
}
window.addRest = s => { if (REST) { REST.end += s * 1000; REST.total += s; [3, 2, 1].forEach(k => delete REST.fired[k]); } };
window.stopRest = quiet => { if (REST) clearInterval(REST.iv); REST = null; const el = document.getElementById('restbar'); if (el) el.remove(); };
window.toggleSet = (wid, i, j) => {
  const b = getW(wid).blocks[i], s = b.sets[j]; s.done = !s.done; invalidate(); saveNow(); rerender();
  if (s.done && j < b.sets.length - 1) startRest(restSecs(b), b.exercise);
  else if (s.done) startRest(restSecs(b), b.exercise + ' · last set');
};

/* ---------- workout timer ---------- */
function timedMv(m) { return m && (m.kind === 'time' || m.kind === 'rest') && strToSec(m.amt) > 0; }
function timerPlan(b) {
  if (b.type === 'cardio') return { mode: 'up' };
  const mv = (b.movements || []).filter(m => m && m.kind !== 'note');
  const cap = num(b.cap) ? num(b.cap) * 60 : null;
  if ((b.format === 'emom' || b.format === 'interval') && b.every && num(b.count)) return { mode: 'intervals', every: +b.every, count: num(b.count), slots: mv.filter(m => m.slot) };
  if (b.format === 'amrap') return { mode: 'down', total: cap || 600 };
  if (mv.some(timedMv)) {
    const R = Math.max(1, num(b.rounds) || 1), segs = [];
    for (let r = 1; r <= R; r++) mv.forEach((m, j) => {
      const last = r === R && mv.slice(j + 1).every(x => x.kind === 'rest');
      if (m.kind === 'rest' && last) return;
      segs.push({ r, R, m, dur: timedMv(m) ? strToSec(m.amt) : null, rest: m.kind === 'rest' });
    });
    return { mode: 'seq', segs };
  }
  if (b.format === 'other' && cap) return { mode: 'down', total: cap };
  return { mode: 'up', cap, rounds: num(b.rounds) || null };
}
function timerLabel(b) {
  const p = timerPlan(b);
  if (p.mode === 'down') return `${secToStr(p.total)} countdown`;
  if (p.mode === 'intervals') return `every ${secToStr(p.every)} × ${p.count}`;
  if (p.mode === 'seq') return `${p.segs.length} interval${p.segs.length === 1 ? '' : 's'}`;
  return p.cap ? `stopwatch, cap ${secToStr(p.cap)}` : 'stopwatch';
}
let T = null;
const mvShort = m => !m ? '' : m.kind === 'rest' ? 'Rest' : [m.kind === 'reps' ? m.amt : m.kind === 'time' ? m.amt : m.amt ? `${m.amt} ${UNIT_LABEL[m.kind]}` : '', m.name].filter(Boolean).join(' ');
const workMvs = b => (b.movements || []).filter(m => m && m.kind !== 'note' && m.kind !== 'rest');
window.openTimer = (wid, i) => {
  if (T) return toast('A timer is already running');
  const w = getW(wid), b = w.blocks[i]; audio(); keepAwake(true);
  T = { wid, i, b, plan: timerPlan(b), phase: 'ready', t0: null, paused: null, pausedTotal: 0, fired: {}, rounds: 0, segIdx: 0, segStart: 0, mvIdx: 0, lastIv: -1 };
  const el = document.createElement('div'); el.id = 'timer';
  el.innerHTML = `<div id="flash"></div><div class="tm-top"><span class="tm-title"></span><span class="tm-rl"></span></div>
    <div class="tm-clock">0:00</div>
    <div class="tm-cur" onclick="timerTap()"></div>
    <div class="tm-next"></div>
    <div class="tm-btns"></div>`;
  document.body.appendChild(el); drawTimerButtons(); T.iv = setInterval(tickTimer, 100); tickTimer();
};
function drawTimerButtons() {
  const el = document.querySelector('#timer .tm-btns'); if (!el || !T) return;
  let h = '';
  if (T.phase === 'ready') h = `<button class="btn-primary tm-go" onclick="timerGo()">Start</button><button onclick="closeTimer()">Close</button>`;
  else if (T.phase === 'done') h = `<button class="btn-primary" onclick="closeTimer(true)">Save result</button><button onclick="closeTimer()">Close without saving</button>`;
  else h = `<button onclick="timerPause()">${T.paused ? 'Resume' : 'Pause'}</button><button class="btn-danger" onclick="timerStop()">${T.plan.mode === 'down' ? 'End' : 'Stop'}</button>`;
  el.innerHTML = h;
}
window.timerGo = () => { audio(); T.phase = 'lead'; T.leadEnd = Date.now() + 10000; drawTimerButtons(); };
const tNow = () => (T.paused || Date.now()) - T.t0 - T.pausedTotal;
window.timerPause = () => { if (!T || !T.t0) return; if (T.paused) { T.pausedTotal += Date.now() - T.paused; T.paused = null; } else T.paused = Date.now(); drawTimerButtons(); };
window.timerStop = () => finishTimer();
// tap the exercise: move to the next movement; finishing the last one counts a round
window.timerTap = () => {
  if (!T || T.phase !== 'run' || T.paused) return;
  const p = T.plan;
  if (p.mode === 'seq') { const seg = p.segs[T.segIdx]; if (seg && !seg.dur) { T.segIdx++; T.segStart = tNow() / 1000; T.fired = {}; if (T.segIdx >= p.segs.length) finishTimer(); else beep('go'); } return; }
  const mv = p.mode === 'intervals' && p.slots.length ? [] : workMvs(T.b); if (!mv.length) return;
  T.mvIdx++;
  if (T.mvIdx >= mv.length) { T.mvIdx = 0; if (p.mode !== 'intervals') { T.rounds++; beep('double'); if (p.mode === 'up' && p.rounds && T.rounds >= p.rounds) return finishTimer(); } else beep('short'); }
  else beep('short');
};
function fireOnce(key, kind) { if (!T.fired[key]) { T.fired[key] = 1; beep(kind); } }
function showMv(cur, next, tappable) {
  const el = document.getElementById('timer'); if (!el) return;
  const c = el.querySelector('.tm-cur'), n = el.querySelector('.tm-next');
  if (c.dataset.v !== cur) { c.dataset.v = cur; c.textContent = cur; }
  c.classList.toggle('tap', !!tappable);
  const nv = next ? 'Next: ' + next : '';
  if (n.dataset.v !== nv) { n.dataset.v = nv; n.textContent = nv; }
}
function roundsLeftText() {
  const p = T.plan;
  if (p.mode === 'seq') { const seg = p.segs[Math.min(T.segIdx, p.segs.length - 1)]; const left = seg.R - seg.r + 1; return seg.R > 1 ? `${left} rd${left === 1 ? '' : 's'} left` : ''; }
  if (p.mode === 'intervals') { const s = tNow() / 1000, idx = Math.min(p.count - 1, Math.floor(s / p.every)), left = p.count - idx; return `${left} left`; }
  if (p.mode === 'up' && p.rounds) { const left = Math.max(0, p.rounds - T.rounds); return `${left} rd${left === 1 ? '' : 's'} left`; }
  return T.rounds ? `${T.rounds} rd${T.rounds === 1 ? '' : 's'}` : '';
}
function tickTimer() {
  if (!T) return; const el = document.getElementById('timer'); if (!el) return;
  const clock = el.querySelector('.tm-clock'), title = el.querySelector('.tm-title'), rl = el.querySelector('.tm-rl');
  const p = T.plan, mv = workMvs(T.b);
  const firstSeg = p.mode === 'seq' ? p.segs[0] : null;
  const firstCur = firstSeg ? mvShort(firstSeg.m) : p.mode === 'intervals' && p.slots.length ? mvShort(p.slots[0]) : mvShort(mv[0]);
  const firstNext = firstSeg ? mvShort((p.segs[1] || {}).m) : p.mode === 'intervals' && p.slots.length ? mvShort(p.slots[1 % p.slots.length]) : mv.length > 1 ? mvShort(mv[1]) : '';
  if (T.phase === 'ready') { title.textContent = T.b.title || T.b.mode || ''; rl.textContent = ''; clock.textContent = p.mode === 'down' ? secToStr(p.total) : p.mode === 'intervals' ? secToStr(p.every) : '0:00'; showMv(firstCur, firstNext); return; }
  if (T.phase === 'done') return;
  title.textContent = T.paused ? 'Paused' : '';
  if (T.phase === 'lead') {
    const left = Math.ceil((T.leadEnd - Date.now()) / 1000);
    clock.textContent = left > 0 ? left : 'GO'; rl.textContent = ''; showMv(firstCur, firstNext);
    for (const s of [3, 2, 1]) if (left === s) fireOnce('lead' + s, 'short');
    if (left <= 0) { fireOnce('go', 'go'); T.phase = 'run'; T.t0 = Date.now(); T.fired = {}; T.segStart = 0; drawTimerButtons(); }
    return;
  }
  if (T.phase === 'done') return;
  const s = tNow() / 1000;
  rl.textContent = roundsLeftText();
  if (p.mode === 'up' || p.mode === 'down') {
    if (p.mode === 'up') { clock.textContent = secToStr(Math.floor(s)); if (p.cap) { const left = Math.ceil(p.cap - s); capAlerts(left, p.cap); if (left <= 0) return finishTimer(); } }
    else { const left = Math.ceil(p.total - s); clock.textContent = secToStr(Math.max(0, left)); capAlerts(left, p.total); if (left <= 0) return finishTimer(); }
    if (mv.length) showMv(mvShort(mv[T.mvIdx % mv.length]), mv.length > 1 ? mvShort(mv[(T.mvIdx + 1) % mv.length]) : '', true);
    else showMv('', '');
  } else if (p.mode === 'intervals') {
    const idx = Math.floor(s / p.every), inLeft = Math.ceil(p.every - (s - idx * p.every));
    if (idx >= p.count) return finishTimer();
    if (idx !== T.lastIv) { if (idx > 0) beep('go'); T.lastIv = idx; T.mvIdx = 0; }
    clock.textContent = secToStr(inLeft);
    if (p.slots.length) showMv(mvShort(p.slots[idx % p.slots.length]), idx + 1 < p.count ? mvShort(p.slots[(idx + 1) % p.slots.length]) : '');
    else if (mv.length) showMv(mvShort(mv[Math.min(T.mvIdx, mv.length - 1)]), T.mvIdx + 1 < mv.length ? mvShort(mv[T.mvIdx + 1]) : (idx + 1 < p.count ? mvShort(mv[0]) : ''), true);
    for (const k of [3, 2, 1]) if (inLeft === k) fireOnce(`i${idx}-${k}`, 'short');
  } else if (p.mode === 'seq') {
    const seg = p.segs[T.segIdx]; if (!seg) return finishTimer();
    const inSeg = s - T.segStart, nx = p.segs[T.segIdx + 1];
    el.classList.toggle('resting', !!seg.rest);
    showMv(mvShort(seg.m), nx ? mvShort(nx.m) : '', !seg.dur);
    if (seg.dur) {
      const left = Math.ceil(seg.dur - inSeg); clock.textContent = secToStr(Math.max(0, left));
      for (const k of [3, 2, 1]) if (left === k) fireOnce(`s${T.segIdx}-${k}`, 'short');
      if (left <= 0) { T.segIdx++; T.segStart = T.segStart + seg.dur; T.fired = {}; if (T.segIdx >= p.segs.length) finishTimer(); else beep('go'); }
    } else clock.textContent = secToStr(Math.floor(inSeg));
  }
}
function capAlerts(left, total) {
  const half = Math.ceil(total / 2);
  if (total >= 120 && left === half) fireOnce('half', 'double');
  if (total > 90 && left === 60) fireOnce('60', 'double');
  if (total > 20 && left === 10) fireOnce('10', 'double');
  for (const k of [3, 2, 1]) if (left === k) fireOnce('c' + k, 'short');
}
function finishTimer() {
  if (!T || T.phase === 'done') return;
  const p = T.plan; const el = document.getElementById('timer');
  T.elapsed = Math.round(Math.min(tNow() / 1000, p.mode === 'down' ? p.total : Infinity));
  T.phase = 'done'; beep('long');
  if (el) {
    el.classList.remove('resting');
    el.querySelector('.tm-clock').textContent = secToStr(T.elapsed);
    el.querySelector('.tm-title').textContent = 'Done';
    el.querySelector('.tm-rl').textContent = T.rounds ? `${T.rounds} rds` : '';
    showMv('', '');
  }
  drawTimerButtons();
}
window.closeTimer = async saveIt => {
  if (!T) return; clearInterval(T.iv);
  const t = T; T = null; const el = document.getElementById('timer'); if (el) el.remove();
  if (saveIt) {
    const w = getW(t.wid), b = w && w.blocks[t.i];
    if (b) {
      b.result = b.result || {};
      if (b.format === 'amrap') {
        const r = await form('AMRAP result', [{ label: 'Full rounds', value: t.rounds, mode: 'numeric' }, { label: 'Extra reps', value: '', mode: 'numeric' }], 'Save');
        if (r) { b.result.rounds = r[0]; b.result.reps = r[1]; }
      } else b.result.time = t.elapsed;
      if (b.type === 'cond' && t.rounds && b.format !== 'amrap' && !b.result.score) b.result.score = `${t.rounds} rounds`;
      saveNow(); rerender(); toast('Result saved');
    }
  }
  if (!(location.hash.startsWith('#workout') && activeWorkout())) keepAwake(false);
};

window.forceUpdate = async () => {
  toast('Getting the newest version…');
  try { if (navigator.serviceWorker) { const regs = await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map(r => r.unregister())); } } catch (e) { }
  try { if (window.caches) { const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } } catch (e) { }
  setTimeout(() => location.reload(), 600);
};
/* ---------- first launch ---------- */
function welcome() {
  $('#tabs').innerHTML = '';
  $('#app').innerHTML = `<h1 style="margin-top:30px">Training Log</h1><p class="sec">First time on this phone. Load your data one of two ways:</p>
  <div class="card"><h3>1. Starter file</h3><p class="small sec">Pick <b>training-log-starter.json</b> from Files / iCloud Drive. It has your program and your Strength Level history.</p><button class="btn-primary btn-block" onclick="document.getElementById('st').click()">Choose starter file</button><input type="file" id="st" accept="application/json,.json" style="display:none" onchange="loadStarter(this)"></div>
  <div class="card"><h3>2. Restore from Google backup</h3><p class="small sec">Already set up the backup? Enter its URL and password.</p><label class="f">Backup URL</label><input id="wu" autocapitalize="off" autocorrect="off" placeholder="https://script.google.com/macros/s/…/exec"><label class="f">Password</label><input id="wk" autocapitalize="off" autocorrect="off"><button class="btn-block" style="margin-top:10px" onclick="welcomeRestore()">Restore</button></div>`;
}
window.loadStarter = inp => {
  const f = inp.files[0]; if (!f) return; const r = new FileReader();
  r.onload = () => {
    try {
      const j = JSON.parse(r.result);
      if (j.kind === 'starter') S = freshState(j);
      else if (j.workouts && j.programDays) S = j;
      else throw new Error('That file is not a Training Log starter or backup file.');
      adopt(S); persist(false); location.hash = '#today'; route(); toast('✅ Loaded ' + S.workouts.length + ' workouts');
    } catch (e) { toast('⚠️ ' + esc(e.message)); }
  };
  r.readAsText(f);
};
window.welcomeRestore = async () => {
  const url = $('#wu').value.trim(), key = $('#wk').value.trim(); if (!url) return;
  try { const j = await fetchBackup(url, key); if (!j.state) return toast('That backup is empty'); adopt(j.state); S.settings.syncUrl = url; S.settings.syncKey = key; persist(false); LS.setItem(KEY + '.dirty', '0'); location.hash = '#today'; route(); toast('✅ Restored'); }
  catch (e) { toast('⚠️ ' + esc(e.message)); }
};

/* ---------- boot ---------- */
load();
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { });
if (!PREVIEW && 'serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
if (S) { route(); scheduleSync(1500); }
else if (PREVIEW) fetch('training-log-starter.json').then(r => r.json()).then(j => { S = freshState(j); adopt(S); persist(false); route(); }).catch(() => welcome());
else welcome();
