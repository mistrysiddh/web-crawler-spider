// Headless logic test for the Web Crawler Spider desktop plugin.
// Run: node test.mjs   (needs `npm install` for jsdom; plugin path via PLUGIN env or default)
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const PLUGIN = process.env.PLUGIN || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'desktop', 'plugin.js');
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
  if (!ok) failures++;
};

// ---- DOM: a viewport with a status bar and a grid of buttons ----
const dom = new JSDOM('<!doctype html><body style="background:#10121f"></body>', { pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
const W = 1280;
const H = 800;
Object.defineProperty(window, 'innerWidth', { value: W, configurable: true });
Object.defineProperty(window, 'innerHeight', { value: H, configurable: true });

const rects = new Map();
const addEl = (tag, x, y, w, h) => {
  const el = window.document.createElement(tag);
  if (tag === 'a') el.setAttribute('href', '#');
  window.document.body.appendChild(el);
  rects.set(el, { left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, x, y });
  return el;
};
const buttons = [];
for (let r = 0; r < 4; r++) for (let c = 0; c < 6; c++) buttons.push(addEl(r % 2 ? 'a' : 'button', 80 + c * 190, 100 + r * 150, 120, 40));
// one button fully covered by a "modal" and one hidden
const covered = addEl('button', 600, 330, 100, 40);
const modal = addEl('div', 560, 300, 200, 120);
const hidden = addEl('button', 300, 700, 100, 40);
hidden.style.display = 'none';

window.Element.prototype.getBoundingClientRect = function () {
  return rects.get(this) || { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 };
};
window.document.elementFromPoint = (x, y) => {
  // modal sits on top of everything inside its box
  const m = rects.get(modal);
  if (x >= m.left && x <= m.right && y >= m.top && y <= m.bottom) return modal;
  for (const [el, r] of [...rects].reverse()) {
    if (el === modal) continue;
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return el;
  }
  return window.document.body;
};

// canvas 2d context: accept every call, draw nothing
window.HTMLCanvasElement.prototype.getContext = () =>
  new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => ({ addColorStop() {} })), set: (t, k, v) => ((t[k] = v), true) });

// controllable clock + rAF
let now = 1000;
const rafQueue = [];
window.requestAnimationFrame = (cb) => rafQueue.push(cb);
window.cancelAnimationFrame = () => {};
window.performance.now = () => now;
const frame = () => {
  now += 1000 / 60;
  const cbs = rafQueue.splice(0);
  cbs.forEach((cb) => cb(now));
};
const run = (seconds) => {
  for (let i = 0; i < seconds * 60; i++) frame();
};

for (const k of ['document', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia', 'innerWidth', 'innerHeight', 'addEventListener', 'removeEventListener']) {
  try {
    Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true });
  } catch (e) {
    /* ignore */
  }
}
globalThis.window = window;
globalThis.performance = window.performance;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.matchMedia = window.matchMedia = () => ({ matches: false });
window.addEventListener = window.addEventListener.bind(window);

// controllable window focus / visibility (jsdom: never focused, always visible)
let winFocused = true;
let docHidden = false;
window.document.hasFocus = () => winFocused;
Object.defineProperty(window.document, 'hidden', { get: () => docHidden, configurable: true });
const setWindowState = ({ focused = winFocused, hidden = docHidden }) => {
  const hiddenChanged = hidden !== docHidden;
  const focusChanged = focused !== winFocused;
  winFocused = focused;
  docHidden = hidden;
  if (hiddenChanged) window.document.dispatchEvent(new window.Event('visibilitychange'));
  if (focusChanged) window.dispatchEvent(new window.Event(focused ? 'focus' : 'blur'));
};

// ---- load the plugin with the SDK/React imports stubbed ----
let src = fs.readFileSync(PLUGIN, 'utf8')
  .replace(/^import .*$/gm, '')
  .replace('export default WebCrawlerSpiderPlugin;', 'export { startSpider, CONFIG, WebCrawlerSpiderPlugin, moodNow, handleGatewayEvent, togglePanel, closePanel, showHint };');
src = "const PALETTE_AREA='palette', useRef=()=>({}), useEffect=()=>{}, useState=(v)=>[v,()=>{}], jsx=()=>null;\n" + src;
const tmp = path.join(os.tmpdir(), `wcs-under-test-${process.pid}.mjs`);
fs.writeFileSync(tmp, src);
const mod = await import(pathToFileURL(tmp).href);
fs.unlinkSync(tmp);

const store = new Map();
const storage = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
const before = window.document.body.innerHTML;

check('babies are off by default', mod.CONFIG.babies === 0);
mod.CONFIG.babies = 2; // keep the (parked) baby code covered
mod.CONFIG.bugs = 0; // no random flies during the long walk test
mod.CONFIG.sleepAfterMs = 1e12; // no napping during the long walk test
check('explore (reading the page) is off by default', mod.CONFIG.explore === 0);
mod.CONFIG.explore = 1; // the walk-the-app tests below need it on; a block further down covers the default
const api = mod.startSpider({ storage });
check('overlay canvas + highlight added (data-wcs)', window.document.querySelectorAll('[data-wcs]').length === 2);
check('starts unpaused (no reduced motion, nothing stored)', api.isPaused() === false);

// ---- walk for 90 simulated seconds, sampling state ----
const visited = new Set();
let nan = false;
let outside = false;
let maxLegStretch = 0;
let coveredPicked = false;
let hiddenPicked = false;
let highlightShown = false;
let worstStretch = 0;
let guideSeen = 0;
let guideBad = 0;
for (let i = 0; i < 90 * 60; i++) {
  frame();
  const d = api._debug();
  if (![d.body.x, d.body.y, d.body.angle].every(Number.isFinite)) nan = true;
  { const m = 46 * mod.CONFIG.size; if (d.body.x < m - 1 || d.body.y < 56 * mod.CONFIG.size - 1 || d.body.x > W - m + 1 || d.body.y > H - m + 1) outside = true; }
  for (const leg of d.legs) {
    if (![leg.foot.x, leg.foot.y, leg.z].every(Number.isFinite)) nan = true;
  }
  for (const leg of d.legs) {
    const c = Math.cos(d.body.angle);
    const sn = Math.sin(d.body.angle);
    const hx = d.body.x + leg.baseLocal.fx * c - leg.baseLocal.ly * sn;
    const hy = d.body.y + leg.baseLocal.fx * sn + leg.baseLocal.ly * c;
    worstStretch = Math.max(worstStretch, Math.hypot(leg.foot.x - hx, leg.foot.y - hy) / (leg.l1 + leg.l2));
  }
  if (d.guide) {
    guideSeen++;
    const r = rects.get(d.state.currentEl);
    const ok = r && Math.abs(d.guide.x1 - (r.left + r.width / 2)) < 0.5 && Math.abs(d.guide.y1 - (r.top + r.height / 2)) < 0.5 && Number.isFinite(d.guide.x0) && Number.isFinite(d.guide.y0);
    if (!ok) guideBad++;
  }
  for (const cr of d.creatures) {
    if (![cr.body.x, cr.body.y].every(Number.isFinite)) nan = true;
    for (const lg of cr.legs) if (![lg.foot.x, lg.foot.y, lg.z].every(Number.isFinite)) nan = true;
  }
  if (d.state.currentEl && d.state.mode === 'dwell') visited.add(d.state.currentEl);
  if (d.state.currentEl === covered) coveredPicked = true;
  if (d.state.currentEl === hidden) hiddenPicked = true;
  const hl = window.document.querySelector('[data-wcs="highlight"]');
  if (hl && hl.style.opacity === '1') highlightShown = true;
}
check('no NaN in body/feet', !nan);
check('body never leaves the viewport', !outside);
check('visits many distinct elements', visited.size >= 10, `${visited.size} visited`);
check('never targets a covered element', !coveredPicked);
check('never targets a hidden element', !hiddenPicked);
check('highlight box is shown', highlightShown);

check('feet stay within leg reach for the whole run', worstStretch <= 1.0, `worst ${(worstStretch * 100).toFixed(0)}% of reach`);

// ---- babies, silk, moods, pointer, sleep ----
{
  const dd = api._debug();
  check('big spider plus two babies', dd.creatures.length === 3 && dd.creatures[1].role === 'baby');
  check('guide line points at the element it is walking to', guideSeen > 100 && guideBad === 0, `${guideSeen} frames, ${guideBad} wrong`);
  const far = dd.creatures.slice(1).map((b) => Math.hypot(b.body.x - dd.main.body.x, b.body.y - dd.main.body.y));
  check('babies stay near the big spider', far.every((x) => x < 400), far.map((x) => x.toFixed(0)).join('/') + ' px');

  const m = (t) => mod.moodNow(now);
  mod.handleGatewayEvent({ type: 'tool.start', payload: {} });
  check('mood: tool.start -> working', m().name === 'working' && m().pace > 1);
  mod.handleGatewayEvent({ type: 'approval.request', payload: {} });
  check('mood: approval.request -> waiting (amber)', m().name === 'waiting' && m().color === '#ffb020');
  mod.handleGatewayEvent({ type: 'approval.cancelled', payload: {} });
  check('mood: approval.cancelled clears waiting', m().name !== 'waiting');
  mod.handleGatewayEvent({ type: 'message.complete', payload: { status: 'error' } });
  check('mood: failed turn -> error (red)', m().name === 'error' && m().color === '#ff4d4d');
  now += 20000;
  check('mood: error fades back to idle', m().name === 'idle');
  mod.handleGatewayEvent({ type: 'message.complete', payload: { status: 'complete' } });
  check('mood: finished turn -> done (green)', m().name === 'done' && m().color === '#3ddc84');
  now += 6000;
  check('mood: done fades back to idle', m().name === 'idle');

  // scare: click right on the big spider
  const b0 = { x: dd.main.body.x, y: dd.main.body.y };
  window.dispatchEvent(new window.MouseEvent('pointerdown', { clientX: b0.x + 5, clientY: b0.y + 5 }));
  check('click on the spider scares it (hop + flee)', dd.main.state.scare > 0 && dd.main.state.hop > 0);
  run(2.5);
  check('scared spider scurries away from the click', Math.hypot(dd.main.body.x - b0.x, dd.main.body.y - b0.y) > 120);
  check('a click far away does not scare it', (() => {
    dd.main.state.scare = 0;
    window.dispatchEvent(new window.MouseEvent('pointerdown', { clientX: dd.main.body.x + 600, clientY: dd.main.body.y }));
    return dd.main.state.scare === 0;
  })());

  // sleep: quiet for a while -> walk to the nest and fold up; any input wakes it
  mod.CONFIG.sleepAfterMs = 3000;
  window.dispatchEvent(new window.MouseEvent('pointermove', { clientX: 5, clientY: 5 })); // reset the quiet timer
  run(40);
  check('quiet spell: spider naps (mode sleep, folded up)', dd.main.state.mode === 'sleep' && dd.main.state.curl > 0.9, `${dd.main.state.mode} curl ${dd.main.state.curl.toFixed(2)}`);
  check('babies curl up beside the sleeping parent', dd.creatures.slice(1).every((b) => b.state.curl > 0.5), dd.creatures.slice(1).map((b) => b.state.mode + ':' + b.state.curl.toFixed(2)).join(' '));
  window.dispatchEvent(new window.MouseEvent('pointermove', { clientX: 400, clientY: 400 }));
  run(3);
  check('input wakes the spider', dd.main.state.mode !== 'sleep' && dd.main.state.curl < 0.3, `${dd.main.state.mode} curl ${dd.main.state.curl.toFixed(2)}`);
  mod.CONFIG.sleepAfterMs = 1e12;
  api.nap();
  run(1.6);
  check('nap command forces a nap even when active', dd.main.state.mode === 'nest' || dd.main.state.mode === 'sleep', dd.main.state.mode);
  api.wake();
  run(2);
  check('wake command ends the nap', dd.main.state.mode !== 'sleep' && dd.main.state.mode !== 'nest', dd.main.state.mode);
}

// ---- flies, grooming, stretching ----
{
  const dd = api._debug();
  api.wake();
  run(2);
  check('no fly unless one is released', api._debug().bug === null);
  api.spawnBug();
  check('a fly can be released', api._debug().bug && api._debug().bug.state === 'fly');
  const modes = new Set();
  let finiteBug = true;
  let guideDuringHunt = false;
  for (let i = 0; i < 40 * 60; i++) {
    frame();
    const x = api._debug();
    modes.add(x.state.mode);
    if (x.bug && ![x.bug.x, x.bug.y, x.bug.z].every(Number.isFinite)) finiteBug = false;
    if (x.state.mode === 'hunt' && x.guide) guideDuringHunt = true;
    if (!x.bug && modes.has('eat') && x.state.mode === 'dwell') break;
  }
  check('spider hunts, pounces and eats the fly', modes.has('hunt') && modes.has('eat'), [...modes].join(','));
  check('fly is gone and the spider goes back to normal', api._debug().bug === null && api._debug().state.mode !== 'eat' && api._debug().state.mode !== 'hunt');
  check('fly position stays finite', finiteBug);
  check('no guide line while hunting', !guideDuringHunt);

  // grooming: the front legs lift and sweep
  api.stretch();
  let low = 0;
  for (let i = 0; i < 80; i++) {
    frame();
    low = Math.min(low, dd.main.state.curl);
  }
  check('stretch: body stands taller and legs reach out (curl < 0)', low < -0.2, `min curl ${low.toFixed(2)}`);
  run(2);
  check('stretch ends and the stance returns to normal', Math.abs(dd.main.state.curl) < 0.08, dd.main.state.curl.toFixed(2));
  dd.main.state.mode = 'dwell';
  dd.main.state.dwellUntil = now + 1e9;
  api.groom();
  let lifted = 0;
  for (let i = 0; i < 40; i++) {
    frame();
    lifted = Math.max(lifted, dd.main.legs[0].tapOffset, dd.main.legs[4].tapOffset);
  }
  check('groom: front legs lift and sweep', lifted > 3, `peak ${lifted.toFixed(1)}`);
  dd.main.state.dwellUntil = 0;
}

// ---- pause / resume ----
api.pause();
const px = api._debug().body.x;
run(2);
check('paused: spider frozen', api._debug().body.x === px && api.isPaused());
check('paused state persisted', store.get('wcs:paused') === true);
api.resume();
run(5);
check('resume: spider moves again', api._debug().body.x !== px || api._debug().body.y !== 0);
check('resume state persisted', store.get('wcs:paused') === false);

// ---- destroy leaves the page untouched ----
api.destroy();
check('destroy removes every data-wcs node', window.document.querySelectorAll('[data-wcs]').length === 0);
check('page markup identical after destroy', window.document.body.innerHTML === before);

// ---- a second start destroys the first instance ----
const a1 = mod.startSpider({ storage });
const a2 = mod.startSpider({ storage });
check('restart does not duplicate overlays', window.document.querySelectorAll('[data-wcs]').length === 2);
a2.destroy();
void a1;


// ---- helper spiders for subagents ----
{
  mod.CONFIG.babies = 0;
  mod.CONFIG.helpers = 1;
  mod.CONFIG.bugs = 0;
  const h = mod.startSpider({ storage });
  const ev = (type, payload) => mod.handleGatewayEvent({ type, payload });
  const helpers = () => h._debug().creatures.filter((c) => c.role === 'helper');
  run(1);
  check('no helpers without subagents', helpers().length === 0);
  ev('subagent.start', { subagent_id: 'a', goal: 'one' });
  ev('subagent.start', { subagent_id: 'b', goal: 'two' });
  run(1);
  check('one helper per running subagent', helpers().length === 2, String(helpers().length));
  check('helpers are small and tinted', helpers().every((c) => c.size < h._debug().main.size && c.tint));
  ev('subagent.progress', { subagent_id: 'a' });
  ev('subagent.start', { subagent_id: 'a' }); // duplicate start must not add a spider
  run(1);
  check('repeat events do not duplicate helpers', helpers().length === 2);
  for (const id of ['c', 'd', 'e', 'f']) ev('subagent.start', { subagent_id: id });
  run(1);
  check('helpers capped at maxHelpers', helpers().length === 4, String(helpers().length));
  // helpers wander and stay on screen
  let hBad = false;
  let moved = 0;
  const start = helpers().map((c) => ({ x: c.body.x, y: c.body.y }));
  for (let i = 0; i < 20 * 60; i++) {
    frame();
    for (const c of helpers()) if (![c.body.x, c.body.y].every(Number.isFinite) || c.body.x < -1 || c.body.y < -1 || c.body.x > W + 1 || c.body.y > H + 1) hBad = true;
  }
  helpers().forEach((c, i) => (moved += Math.hypot(c.body.x - start[i].x, c.body.y - start[i].y)));
  check('helpers wander and stay on screen', !hBad && moved > 100, `moved ${moved.toFixed(0)}`);
  ev('subagent.complete', { subagent_id: 'a', status: 'completed' });
  ev('subagent.complete', { subagent_id: 'b', status: 'failed' });
  run(0.1); // sooner than a helper standing near the edge could finish walking off
  const ca = helpers().find((c) => c.entry.id === 'a');
  const cb = helpers().find((c) => c.entry.id === 'b');
  check('finished helpers turn green (ok) / red (failed)', ca && cb && ca.tint === '#3ddc84' && cb.tint === '#ff4d4d');
  run(25);
  check('waiting subagents take the slots once finished helpers leave', helpers().some((c) => c.entry.id === 'e') && helpers().some((c) => c.entry.id === 'f'));
  check('finished helpers walk off and are removed', !helpers().some((c) => c.entry && (c.entry.id === 'a' || c.entry.id === 'b')), helpers().map((c) => c.entry.id).join(','));
  for (const id of ['c', 'd', 'e', 'f']) ev('subagent.complete', { subagent_id: id, status: 'completed' });
  run(30);
  check('all helpers gone when subagents finish', helpers().length === 0, String(helpers().length));
  // late events for a finished subagent do not bring it back
  ev('subagent.progress', { subagent_id: 'a' });
  run(1);
  ev('subagent.complete', { subagent_id: 'zzz', status: 'completed' });
  run(1);
  check('complete without start spawns nothing', helpers().length <= 1);
  ev('subagent.complete', { subagent_id: 'a', status: 'completed' });
  run(30);
  // stale subagent (no events) expires
  ev('subagent.start', { subagent_id: 'stale' });
  run(1);
  const had = helpers().length;
  now += mod.CONFIG.helperStaleMs + 1000;
  run(25);
  check('silent subagent helper leaves after the stale timeout', had >= 1 && helpers().length === 0, `${had}->${helpers().length}`);
  // helpers off
  mod.CONFIG.helpers = 0;
  ev('subagent.start', { subagent_id: 'off' });
  run(1);
  check('helpers option off -> none spawn', helpers().length === 0);
  mod.CONFIG.helpers = 1;
  ev('subagent.complete', { subagent_id: 'off', status: 'completed' });
  h.destroy();
  check('destroy cleans up after helpers', window.document.querySelectorAll('[data-wcs]').length === 0);
}

// ---- v19: work web, attention, spider-sense, wind, visiting spiders ----
{
  mod.CONFIG.helpers = 0;
  mod.CONFIG.bugs = 0;
  mod.CONFIG.babies = 0;
  mod.CONFIG.visitEveryMs = 1e12;
  mod.CONFIG.sleepAfterMs = 1e12;
  const chans = [];
  class FakeBC {
    constructor(name) { this.name = name; this.onmessage = null; chans.push(this); }
    postMessage(data) { for (const c of chans) if (c !== this && c.name === this.name && c.onmessage) c.onmessage({ data: JSON.parse(JSON.stringify(data)) }); }
    close() { const i = chans.indexOf(this); if (i >= 0) chans.splice(i, 1); }
  }
  window.BroadcastChannel = FakeBC;
  const ev = (type, payload) => mod.handleGatewayEvent({ type, payload: payload || {} });
  ev('approval.received');
  run(20); // let earlier moods settle
  const a = mod.startSpider({ storage });
  const dbg = () => a._debug();
  run(1);

  // work web
  ev('message.start');
  for (let i = 0; i < 5; i++) { ev('tool.start', { name: 'x' }); run(0.3); }
  check('work web: a strand per tool call, fully visible while working', dbg().run.strands === 5 && dbg().web === 1, `${dbg().run.strands} strands`);
  ev('message.complete', { status: 'complete' });
  run(1);
  check('work web: stays after the run (dew)', dbg().web > 0.9 && dbg().run.result === 'done');
  run(15);
  check('work web: fades away afterwards', dbg().web === 0);
  ev('message.start'); ev('tool.start', {}); ev('tool.start', {}); ev('message.complete', { status: 'error' });
  check('work web: a failed run leaves a torn web', dbg().run.result === 'error' && dbg().web > 0.9);
  run(25);
  check('work web: torn web fades too', dbg().web === 0);
  mod.CONFIG.web = 0;
  ev('message.start'); ev('tool.start', {});
  check('work web: off switch', dbg().web === 0);
  mod.CONFIG.web = 1;
  ev('message.complete', { status: 'complete' });
  run(20);

  // spider-sense
  ev('approval.request', { command: 'ls -la', description: 'list files' });
  run(3);
  check('spider-sense: a harmless command does not trigger it', dbg().danger.until === 0 || performance.now() >= dbg().danger.until);
  ev('approval.received');
  run(1);
  ev('approval.request', { command: 'rm -rf /tmp/x', description: 'delete' });
  run(1);
  let d = dbg();
  check('spider-sense: risky command freezes it, front legs up, standing tall', d.state.mode === 'dwell' && d.legs[0].tapOffset > 8 && d.legs[4].tapOffset > 8 && d.state.curl < 0, `curl ${d.state.curl.toFixed(2)} tap ${d.legs[0].tapOffset.toFixed(1)}`);
  const xs = d.body.x;
  run(1);
  check('spider-sense: it does not walk while frozen', Math.abs(dbg().body.x - xs) < 1);
  ev('approval.received');
  check('spider-sense: approval answered ends the alert', dbg().danger.until === 0);
  run(3);

  // attention: Run button + error banner
  const runBtn = addEl('button', 900, 620, 70, 32);
  runBtn.textContent = 'Run';
  ev('approval.request', { command: 'ls', description: 'x' });
  run(25);
  d = dbg();
  const sd = Math.hypot(d.body.x - 935, d.body.y - 636);
  check('attention: spider walks to the Run button and waits beside it', d.state.mode === 'attend' && d.attEl === runBtn && sd < 130, `${sd.toFixed(0)} px away`);
  check('attention: the highlight box stays on the button', d.state.currentEl === runBtn);
  ev('approval.received');
  run(3);
  check('attention: goes back to normal after the approval', dbg().state.mode !== 'attend');
  const banner = addEl('div', 300, 640, 400, 40);
  banner.setAttribute('role', 'alert');
  ev('error', { message: 'boom' });
  run(10);
  check('attention: walks to an error banner', dbg().state.mode === 'attend' && dbg().attEl === banner);
  run(20);
  check('attention: leaves the banner when the error mood ends', dbg().state.mode !== 'attend');

  // wind and shake
  window.dispatchEvent(new window.Event('scroll'));
  run(0.1);
  check('wind: scrolling stirs the silk', dbg().wind > 0.05, dbg().wind.toFixed(2));
  run(6);
  check('wind: dies down again', dbg().wind < 0.02);
  Object.defineProperty(window, 'screenX', { value: 300, configurable: true });
  run(0.3);
  check('shake: moving the window shakes the spider', dbg().shake > 0.2, dbg().shake.toFixed(2));
  check('shake: the spider hugs the ground', dbg().state.curl > 0.08, dbg().state.curl.toFixed(2));
  run(6);
  check('shake: calms down', dbg().shake < 0.05 && dbg().state.curl < 0.05);
  Object.defineProperty(window, 'screenX', { value: 0, configurable: true });
  run(10);
  mod.CONFIG.wind = 0;
  window.dispatchEvent(new window.Event('scroll'));
  check('wind: off switch', dbg().wind === 0);
  mod.CONFIG.wind = 1;
  run(2);

  // visiting spiders
  const peer = new FakeBC('web-crawler-spider/peers');
  const got = [];
  peer.onmessage = (e) => got.push(e.data);
  check('visit: no peer, no visit', a.visitNow() === false);
  peer.postMessage({ from: 'peerA', t: 'hello' });
  check('visit: another window is noticed', dbg().peers.has('peerA'));
  check('visit: and greeted', got.some((m) => m.t === 'hello' && m.reply));
  run(1);
  const startedVisit = a.visitNow();
  check('visit: my spider sets off for the other window', startedVisit && dbg().state.mode === 'visit-out');
  run(25);
  check('visit: it walks off the edge and is away', dbg().state.mode === 'away' && dbg().main.hidden === true);
  check('visit: the other window is told', got.some((m) => m.t === 'visit' && m.to === 'peerA'));
  peer.postMessage({ from: 'peerA', t: 'back', to: dbg().myId });
  check('visit: it comes back when the visit ends', dbg().main.hidden === false && dbg().state.mode === 'dwell');
  run(2);
  peer.postMessage({ from: 'peerA', t: 'visit', to: dbg().myId });
  run(1);
  check('visitor: a guest spider arrives from the edge', dbg().creatures.some((c) => c.role === 'guest'));
  let waved = false;
  let guestGone = false;
  for (let i = 0; i < 40 * 60 && !guestGone; i++) {
    frame();
    const dd = dbg();
    if (dd.state.wave > 0 && dd.creatures.some((c) => c.role === 'guest' && c.state.stage === 'wave')) waved = true;
    if (!dd.creatures.some((c) => c.role === 'guest')) guestGone = true;
  }
  check('visitor: the two spiders wave at each other', waved);
  check('visitor: the guest leaves again and tells its window', guestGone && got.some((m) => m.t === 'back' && m.to === 'peerA'));
  a.destroy();
  check('visit: destroy announces it is gone', got.some((m) => m.t === 'gone'));
  peer.close();
  for (const el of [runBtn, banner]) { el.remove(); rects.delete(el); }
  check('v19: destroy leaves no overlay behind', window.document.querySelectorAll('[data-wcs]').length === 0);
}

// ---- v21: cursor chase ----
{
  mod.CONFIG.helpers = 0; mod.CONFIG.bugs = 0; mod.CONFIG.babies = 0; mod.CONFIG.sleepAfterMs = 1e12; mod.CONFIG.visitEveryMs = 1e12;
  mod.CONFIG.chaseEveryMs = 1000;
  const ev = (type, payload) => mod.handleGatewayEvent({ type, payload: payload || {} });
  ev('approval.received');
  run(20);
  const c = mod.startSpider({ storage });
  const dbg = () => c._debug();
  const move = (x, y) => window.dispatchEvent(new window.MouseEvent('pointermove', { clientX: x, clientY: y }));
  run(2);
  move(1000, 600);
  check('chase: command starts a chase', c.chase() === true && dbg().state.mode === 'chase');
  let closest = 1e9;
  let sawChase = 0;
  for (let i = 0; i < 4 * 60; i++) {
    if (i % 20 === 0) move(1000 - (i % 40) * 3, 600 + (i % 60));
    frame();
    const d = dbg();
    if (d.state.mode === 'chase') sawChase++;
    closest = Math.min(closest, Math.hypot(d.body.x - d.pointer.x, d.body.y - d.pointer.y));
  }
  check('chase: it runs right up to the cursor', closest < 60, `${closest.toFixed(0)} px`);
  run(5);
  check('chase: it gives up after a few seconds and is back to normal', dbg().state.mode !== 'chase' && sawChase > 120 && sawChase < 8 * 60, `${sawChase} ticks`);
  check('chase: stays inside the safe area', dbg().body.x > 50 && dbg().body.x < W - 50 && dbg().body.y > 60 && dbg().body.y < H - 50);
  // natural trigger: pointer on the move, calm mood, cooldown over
  run(5);
  const realRandom = Math.random;
  Math.random = () => 0;
  let started = false;
  for (let i = 0; i < 4 * 60 && !started; i++) {
    if (i % 10 === 0) move(300 + (i % 50) * 10, 300);
    frame();
    if (dbg().state.mode === 'chase') started = true;
  }
  Math.random = realRandom;
  check('chase: sometimes starts by itself when the cursor moves', started);
  run(8);
  // never while the agent waits for the user
  ev('approval.request', { command: 'ls' });
  run(1);
  c.chase();
  run(1);
  check('chase: not while waiting for approval', dbg().state.mode !== 'chase');
  ev('approval.received');
  run(3);
  // clicking scares it out of a chase
  c.chase();
  move(700, 400);
  run(1);
  window.dispatchEvent(new window.MouseEvent('pointerdown', { clientX: dbg().body.x + 5, clientY: dbg().body.y + 5 }));
  run(0.2);
  check('chase: a click scares it off', dbg().state.mode !== 'chase');
  mod.CONFIG.chase = 0;
  run(5);
  Math.random = () => 0;
  for (let i = 0; i < 120; i++) { if (i % 10 === 0) move(200 + i, 300); frame(); }
  Math.random = realRandom;
  check('chase: off switch', dbg().state.mode !== 'chase');
  mod.CONFIG.chase = 1;
  c.destroy();
  check('v21: destroy leaves no overlay behind', window.document.querySelectorAll('[data-wcs]').length === 0);
}

// ---- v1.1: settings panel and first-run hint ----
{
  const pstore = new Map();
  mod.WebCrawlerSpiderPlugin.register({
    storage: { get: (k) => pstore.get(k), set: (k, v) => pstore.set(k, v) },
    register() {}, registerMany() {}, onEvent: () => () => {},
  });
  const chip = window.document.createElement('button');
  chip.setAttribute('data-wcs', 'chip');
  window.document.body.appendChild(chip);
  rects.set(chip, { left: 1100, top: 770, width: 24, height: 20, right: 1124, bottom: 790, x: 1100, y: 770 });
  const dbgNow = () => window.__webCrawlerSpider;

  check('hint: shows once, over the chip', mod.showHint(chip) === true && !!window.document.querySelector('[data-wcs="hint"]'));
  check('hint: remembered, never shown twice', mod.showHint(chip) === false && pstore.get('wcs:hint-seen') === true);
  window.document.querySelector('[data-wcs="hint"]').click();
  check('hint: a click dismisses it', !window.document.querySelector('[data-wcs="hint"]'));

  check('panel: opens from the chip', mod.togglePanel(chip) === true && !!window.document.querySelector('[data-wcs="panel"]'));
  const panel = window.document.querySelector('[data-wcs="panel"]');
  check('panel: 3 sliders and 10 toggles', panel.querySelectorAll('input[type=range]').length === 3 && panel.querySelectorAll('input[type=checkbox]').length === 10);
  check('panel: toggles show the current settings', [...panel.querySelectorAll('input[type=checkbox]')].every((b) => b.checked === !!mod.CONFIG[b.dataset.key]));

  const flies = panel.querySelector('input[data-key=bugs]');
  const before = mod.CONFIG.bugs;
  flies.checked = !before;
  flies.dispatchEvent(new window.Event('change'));
  check('panel: a toggle changes the setting and saves it', mod.CONFIG.bugs === (before ? 0 : 1) && JSON.stringify(pstore.get('wcs:settings')).includes('"bugs":' + mod.CONFIG.bugs));
  const size = panel.querySelector('input[data-key=size]');
  size.value = '1.7';
  size.dispatchEvent(new window.Event('change'));
  check('panel: a slider changes the size and the spider restarts with it', mod.CONFIG.size === 1.7 && dbgNow() && window.document.querySelectorAll('[data-wcs=canvas],[data-wcs]').length >= 3);
  panel.querySelector('button[data-act=pause]').click();
  check('panel: pause button pauses the spider', dbgNow().isPaused() === true);
  panel.querySelector('button[data-act=pause]').click();
  check('panel: and resumes it', dbgNow().isPaused() === false);
  window.document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  check('panel: a click outside closes it', !window.document.querySelector('[data-wcs="panel"]'));
  mod.togglePanel(chip);
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('panel: Escape closes it', !window.document.querySelector('[data-wcs="panel"]'));
  mod.togglePanel(chip);
  window.document.querySelector('[data-wcs="panel"] button[data-act=reset]').click();
  check('panel: reset restores the defaults and closes', mod.CONFIG.size === 1.2 && !window.document.querySelector('[data-wcs="panel"]'));
  check('panel: reset turns explore back off', mod.CONFIG.explore === 0);
  mod.CONFIG.explore = 1;
  dbgNow().destroy();
  mod.startSpider({ storage });
  run(1);
  check('panel: the spider never targets the panel', dbgNow()._debug().targets.length > 0 && dbgNow()._debug().targets.every((el) => !el.closest('[data-wcs]')));
  dbgNow().destroy();
  chip.remove();
  rects.delete(chip);
  check('panel: nothing left behind', window.document.querySelectorAll('[data-wcs]').length === 0);
}

// ---- turning: the body pivots at a limited rate instead of snapping round ----
{
  if (window.__webCrawlerSpider) window.__webCrawlerSpider.destroy();
  rafQueue.length = 0;
  mod.CONFIG.bugs = 0; mod.CONFIG.helpers = 0; mod.CONFIG.chase = 0; mod.CONFIG.sleepAfterMs = 1e12; mod.CONFIG.explore = 0;
  const tp = mod.startSpider({ storage: { get: () => undefined, set() {} } });
  const t = () => tp._debug();
  const norm = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  t().body.x = 900; t().body.y = 400; t().body.angle = Math.PI;
  t().state.mode = 'walk'; t().state.target.x = 100; t().state.target.y = 400;
  run(3);
  t().state.mode = 'walk'; t().state.target.x = 1200; t().state.target.y = 400; // turn all the way round
  let prev = t().body.angle;
  let maxStep = 0;
  let slowWhileBig = true;
  let aligned = -1;
  for (let i = 0; i < 60 * 4; i++) {
    frame();
    const a = t().body.angle;
    maxStep = Math.max(maxStep, Math.abs(norm(a - prev)));
    prev = a;
    const err = Math.abs(norm(Math.atan2(t().state.target.y - t().body.y, t().state.target.x - t().body.x) - a));
    if (err > 1.4 && t().state.speedNow > 0.5) slowWhileBig = false;
    if (aligned < 0 && err < 0.05) aligned = i;
  }
  check('turning: the body never spins faster than turnRate', maxStep <= mod.CONFIG.turnRate + 1e-6, `max ${maxStep.toFixed(3)} rad/step, limit ${mod.CONFIG.turnRate}`);
  check('turning: a full turn-around still completes in about a second or two', aligned > 30 && aligned < 60 * 2.5, `aligned after ${aligned} frames`);
  check('turning: it pivots rather than skids while facing the wrong way', slowWhileBig);
  tp.destroy();
  mod.CONFIG.explore = 1;
}

// ---- default mode: the spider reads nothing from the app and roams only its own overlay ----
{
  if (window.__webCrawlerSpider) window.__webCrawlerSpider.destroy();
  rafQueue.length = 0;
  mod.CONFIG.explore = 0;
  mod.CONFIG.bugs = 0;
  mod.CONFIG.helpers = 1;
  mod.CONFIG.sleepAfterMs = 1e12;
  mod.CONFIG.chase = 0;
  const doc = window.document;
  const calls = [];
  const own = (x) => typeof x === 'string' && x.includes('data-wcs');
  const spies = {
    querySelectorAll: doc.querySelectorAll.bind(doc),
    querySelector: doc.querySelector.bind(doc),
    elementFromPoint: doc.elementFromPoint,
    getComputedStyle: window.getComputedStyle,
  };
  const gcs = (el, ...r) => {
    if (el !== doc.documentElement && el !== doc.body && !(el.closest && el.closest('[data-wcs]'))) calls.push('getComputedStyle');
    return spies.getComputedStyle.call(window, el, ...r);
  };
  doc.querySelectorAll = (sel, ...r) => (own(sel) || calls.push('querySelectorAll:' + sel), spies.querySelectorAll(sel, ...r));
  doc.querySelector = (sel, ...r) => (own(sel) || calls.push('querySelector:' + sel), spies.querySelector(sel, ...r));
  doc.elementFromPoint = (...a) => (calls.push('elementFromPoint'), spies.elementFromPoint(...a));
  globalThis.getComputedStyle = gcs;
  window.getComputedStyle = gcs;

  const ev = (type, payload) => mod.handleGatewayEvent({ type, payload: payload || {} });
  const sp = mod.startSpider({ storage: { get: () => undefined, set() {} } });
  const d0 = sp._debug();
  let travelled = 0;
  let outside = false;
  let last = { x: d0.body.x, y: d0.body.y };
  const sample = () => {
    const d = sp._debug();
    travelled += Math.hypot(d.body.x - last.x, d.body.y - last.y);
    last = { x: d.body.x, y: d.body.y };
    const m = 46 * d.main.size;
    if (d.body.x < m - 1 || d.body.x > W - m + 1 || d.body.y < 56 * d.main.size - 1 || d.body.y > H - m + 1) outside = true;
  };
  ev('message.start');
  for (let i = 0; i < 60 * 40; i++) {
    frame();
    if (i % 30 === 0) sample();
    if (i === 600) ev('tool.start');
    if (i === 900) ev('subagent.start', { subagent_id: 'a1', goal: 'x' });
  }
  check('default mode: the spider roams on its own', travelled > 400, `travelled ${Math.round(travelled)} px`);
  check('default mode: it stays inside the window', !outside);
  check('default mode: no app elements are targeted', sp._debug().targets.length === 0 && sp._debug().state.currentEl === null);
  check('default mode: the work web still follows tool events', sp._debug().web > 0);
  check('default mode: a helper spider still follows subagent events', sp._debug().creatures.some((c) => c.role === 'helper'));

  // approval: the mood and the freeze come from the gateway event, not from the page
  ev('approval.request', { command: 'rm -rf /tmp/x', description: 'delete' });
  run(3);
  check('default mode: waiting for approval still changes its mood', mod.moodNow(performance.now()).name === 'waiting');
  check('default mode: risky command still freezes it with spider-sense', sp._debug().danger.until > performance.now());
  check('default mode: it does not go looking for the Run button', sp._debug().attEl === null && sp._debug().state.mode !== 'attend');
  ev('approval.received');
  run(5);
  check('default mode: nothing in the app was read', calls.length === 0, calls.slice(0, 4).join(' | '));

  // turning explore on walks the app again, and says so by reading it
  sp.destroy();
  mod.CONFIG.explore = 1;
  const sp2 = mod.startSpider({ storage: { get: () => undefined, set() {} } });
  run(5);
  check('explore on: it scans the app for targets again', sp2._debug().targets.length > 0 && calls.some((c) => c.startsWith('querySelectorAll')));
  sp2.destroy();

  doc.querySelectorAll = spies.querySelectorAll;
  doc.querySelector = spies.querySelector;
  doc.elementFromPoint = spies.elementFromPoint;
  globalThis.getComputedStyle = spies.getComputedStyle;
  window.getComputedStyle = spies.getComputedStyle;
  mod.CONFIG.chase = 1;
  mod.CONFIG.explore = 1;
}

// ---- background throttling: a hidden / unfocused window does no work ----
{
  mod.CONFIG.blurGraceMs = 30;
  if (window.__webCrawlerSpider) window.__webCrawlerSpider.destroy(); // earlier tests' spiders share the frame queue
  api.destroy();
  rafQueue.length = 0;
  let rescans = 0;
  const origQSA = window.document.querySelectorAll.bind(window.document);
  const bg = mod.startSpider({ storage: { get: () => undefined, set() {} } });
  run(1);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  check('background: running while the window is focused', bg.isSuspended() === false && rafQueue.length > 0);

  setWindowState({ hidden: true });
  check('background: a hidden window suspends at once', bg.isSuspended() === true);
  frame(); // the pending frame may still run once, then must not re-arm
  frame();
  check('background: no animation frame is re-queued while suspended', rafQueue.length === 0);
  const posBefore = { x: bg._debug().body.x, y: bg._debug().body.y };
  run(5);
  check('background: the spider does not move while suspended', bg._debug().body.x === posBefore.x && bg._debug().body.y === posBefore.y);
  window.document.querySelectorAll = (...a) => (rescans++, origQSA(...a));
  await wait(1200); // real time: the 450 ms rescan timer fires twice
  window.document.querySelectorAll = origQSA;
  check('background: the DOM rescan timer does no scanning while suspended', rescans === 0, `scans=${rescans}`);

  setWindowState({ hidden: false });
  check('background: showing the window wakes it', bg.isSuspended() === false);
  run(1);
  check('background: and the animation loop runs again', rafQueue.length > 0 && bg._debug().body.x !== undefined);

  setWindowState({ focused: false });
  check('background: losing focus does not freeze it straight away', bg.isSuspended() === false);
  await wait(120);
  check('background: it freezes once the focus grace period passes', bg.isSuspended() === true);
  setWindowState({ focused: true });
  check('background: regaining focus wakes it', bg.isSuspended() === false);
  run(1);

  setWindowState({ focused: false });
  setWindowState({ focused: true });
  await wait(120);
  check('background: a quick blur and refocus never freezes it', bg.isSuspended() === false);

  // a user pause stays a pause across a suspend / wake
  bg.pause();
  frame(); // flush the frame that was already queued (the test's cancelAnimationFrame is a stub)
  setWindowState({ hidden: true });
  setWindowState({ hidden: false });
  check('background: waking does not undo a manual pause', bg.isPaused() === true && rafQueue.length === 0);
  bg.resume();
  setWindowState({ hidden: true });
  frame();
  bg.resume();
  check('background: resume while suspended stays frozen', rafQueue.length === 0);
  setWindowState({ hidden: false });
  run(1);
  check('background: and runs when the window returns', bg.isSuspended() === false && rafQueue.length > 0);

  // the setting turns it off
  bg.destroy();
  mod.CONFIG.background = 0;
  const bg2 = mod.startSpider({ storage: { get: () => undefined, set() {} } });
  setWindowState({ hidden: true });
  check('background: with the setting off nothing is suspended', bg2.isSuspended() === false);
  await wait(120);
  setWindowState({ focused: false });
  await wait(120);
  check('background: not even when unfocused', bg2.isSuspended() === false);
  setWindowState({ hidden: false, focused: true });
  bg2.destroy();
  mod.CONFIG.background = 1;
  check('background: destroy leaves no listeners armed', (() => {
    const b = mod.startSpider({ storage: { get: () => undefined, set() {} } });
    b.destroy();
    setWindowState({ hidden: true });
    setWindowState({ hidden: false });
    return window.document.querySelectorAll('[data-wcs]').length === 0;
  })());
}

// ---- register(): contributions must go through registerMany, each a plain object with id + area ----
{
  const singles = [];
  const many = [];
  const fakeCtx = {
    storage: { get: () => undefined, set() {} },
    register: (c) => singles.push(c),
    registerMany: (cs) => many.push(...cs),
    onEvent: () => () => {},
  };
  mod.WebCrawlerSpiderPlugin.register(fakeCtx);
  check('register uses registerMany (not register with an array)', singles.every((c) => !Array.isArray(c)) && many.length >= 2);
  check('every contribution has an id and area', many.every((c) => c && typeof c.id === 'string' && typeof c.area === 'string'));
  check('status bar chip is registered', many.some((c) => c.area === 'statusBar.right'));
  const cmds = many.filter((c) => c.area === 'palette');
  check('palette commands registered with label + run', cmds.length >= 6 && cmds.every((c) => c.data && c.data.label && typeof c.data.run === 'function'));
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
