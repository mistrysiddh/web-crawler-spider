import { PALETTE_AREA } from '@hermes/plugin-sdk';
import { useRef, useEffect, useState } from 'react';
import { jsx } from 'react/jsx-runtime';

/**
 * Web Crawler Spider — takes "web crawler" literally. An 8-legged spider
 * walks the live screen, stepping between real interactive elements with
 * 2-bone IK, highlighting whatever it's standing on. Read-only: it never
 * mutates the page beyond the two overlay nodes it owns (data-wcs).
 *
 * IK/gait approach adapted from the MIT-licensed felixyu9722/WebCrawlerMY,
 * whose README credits @rybinfx for the original "Web Crawlers" concept.
 */

const VERSION = '1.3.1';

const CONFIG = {
  targetSelector:
    'a[href], button, [role="button"], [role="tab"], [role="link"], [role="menuitem"], input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"])',
  pixel: 1, // CSS pixels per art pixel: 1 = smooth/HiDPI, 3 = chunky pixel-art
  bodyScale: 0.6, // body size relative to the legs (smaller = tinier body)
  unit: 3, // movement scale (CSS px per speed unit); independent of the look
  turnRate: 0.05, // fastest the body may turn, in radians per 60 Hz step (0.05 = about 170 degrees per second)
  size: 1.2, // spider size multiplier
  speed: 0.7, // art pixels per 60 Hz step (walking speed)
  accent: null, // force a colour, e.g. '#ff9f1c'; null = read from theme
  babies: 0, // small followers trailing the big spider (0-4); off for now, code kept
  babyScale: 0.42, // baby size relative to the big one
  helpers: 1, // 1 = each running subagent gets a small helper spider that works beside the big one
  helperScale: 0.5, // helper size relative to the big spider
  maxHelpers: 4, // helpers on screen at once; more subagents wait for a free slot
  helperStaleMs: 120000, // a subagent silent this long is assumed gone
  explore: 0, // 1 = also walk to the app's buttons, links and approval prompts (reads the page); 0 = roam only its own overlay
  chase: 1, // 1 = now and then it dashes after the mouse cursor for a few seconds
  background: 1, // 1 = freeze (no timers, no frames) while the window is hidden, minimised or unfocused
  blurGraceMs: 4000, // an unfocused but visible window keeps going this long before freezing
  chaseEveryMs: 60000, // average gap between chases
  chaseMs: 5000, // how long a chase lasts
  web: 1, // 1 = a web grows in the corner while the agent works (a strand per tool call)
  attention: 1, // 1 = it senses risky commands; with explore on it also walks to the button that needs you
  wind: 1, // 1 = scrolling or moving the window makes the silk sway and the spider cling
  peers: 1, // 1 = spiders in other Hermes windows visit each other
  visitEveryMs: 100000, // average gap between visits when another window is open
  bugs: 1, // 1 = an occasional fly shows up; the spider hunts it, wraps it and eats it
  trail: 1, // 1 = draw a straight silk line from the spider to the element it is walking to
  sleep: 1, // 1 = nap in a corner web after a quiet spell
  sleepAfterMs: 60000, // no input and no agent activity for this long -> nap
  scareRadius: 75, // a click this close (px) makes the spider hop and scurry off
  curiousRadius: 170, // while idle, the spider turns toward a pointer this close (px)
  zIndex: 999999, // overlay stacking; the highlight sits one below
  maxTargets: 400,
  rescanMs: 450,
  scrollSettleMs: 150,
  themeReadMs: 2000,
  historyLen: 6,
  dwellMinMs: 1000,
  dwellMaxMs: 3000,
  arrivalUnits: 8,
  stepThreshold: 26,
  stepDurationMs: 170,
  swingLift: 18, // how high a stepping foot rises (x size)
  hipHeight: 15, // body height above the ground (x size); knees arch well above this
  leadFactor: 0.8, // swing foot lands ahead of its rest spot by this x the body travel during the swing
  maxStretch: 0.85, // fraction of full leg reach at which a planted foot must step, whatever its group
  forceStepFactor: 1.35, // x stepThreshold: leg steps even out of turn
};

const THEME_VAR_NAMES = [
  '--ui-accent',
  '--ui-text-secondary',
  '--accent',
  '--accent-color',
  '--primary',
  '--color-primary',
  '--primary-color',
  '--brand',
  '--brand-color',
  '--link-color',
  '--color-accent',
  '--theme-color',
];

// Body colours follow the page background so the spider reads on dark and light themes.
const PALETTES = {
  dark: { ink: '#070911', abdomen: '#1a1f36', thorax: '#232949', head: '#2c3560', eye: '#e8eaff', shadow: 'rgba(0,0,0,0.22)', dot: 'rgba(0,0,0,0.25)' },
  light: { ink: '#10131f', abdomen: '#2b3252', thorax: '#363f68', head: '#434e80', eye: '#ffffff', shadow: 'rgba(20,24,48,0.18)', dot: 'rgba(20,24,48,0.22)' },
};

function isLightBackground() {
  const read = (el) => getComputedStyle(el).backgroundColor;
  let c = read(document.body);
  if (!c || c === 'transparent' || /rgba\(.*,\s*0\)$/.test(c)) c = read(document.documentElement);
  const m = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(c || '');
  if (!m) return false;
  return (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255 > 0.55;
}


// --- agent mood: gateway events -> spider colour / pace. Module-level so it keeps
// listening across spider restarts; the spider only reads moodNow().
const MOOD_COLORS = { waiting: '#ffb020', error: '#ff4d4d', done: '#3ddc84' };
const mood = { workUntil: 0, errorUntil: 0, doneUntil: 0, waiting: false };

// --- subagents: one entry per running subagent; the spider turns them into helper spiders ---
const SUBAGENT_DONE = new Set(['completed', 'failed', 'interrupted', 'timeout', 'error', 'cancelled', 'canceled']);
const helperReg = new Map(); // id -> { id, done, ok, seen, pulse, born }

function handleSubagentEvent(t, payload, now) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const id = String(p.subagent_id || `${p.parent_id || 'root'}:${p.task_index == null ? 0 : p.task_index}:${p.goal || ''}`);
  const status = typeof p.status === 'string' ? p.status : '';
  const finished = t === 'subagent.complete' || SUBAGENT_DONE.has(status);
  let e = helperReg.get(id);
  if (finished) {
    if (e && !e.done) {
      e.done = true;
      e.ok = status === 'completed';
      e.seen = now;
    }
    return;
  }
  if (!e) {
    e = { id, done: false, ok: true, seen: now, pulse: now, born: now };
    helperReg.set(id, e);
  } else if (!e.done) {
    e.seen = now;
    e.pulse = now;
  }
}

// --- the work web grows with the agent's run; spider-sense reacts to risky commands ---
const run = { active: false, strands: 0, result: null, resultAt: 0, seen: 0 };
const danger = { until: 0, at: 0 };
const RISKY =
  /\brm\s+\S|\bsudo\b|\bmkfs\b|\bdd\s+if=|\bchmod\s+(-R|0?777)|\bchown\s+-R|git\s+(reset\s+--hard|push\s+(--force|-f\b)|clean\s+-\w*f|checkout\s+--)|drop\s+(table|database)|\btruncate\b|>\s*\/dev\/sd|\bkill\s+-9|\bshutdown\b|\breboot\b|curl[^|]*\|\s*(ba)?sh|\bdel\s+\/[sq]|\brmdir\b|:\(\)\s*\{|\bdangerous\b|\bdestructive\b/i;
const WEB_MAX_SEGS = 60;

function payloadText(payload) {
  try {
    return JSON.stringify(payload || {}).slice(0, 800);
  } catch (e) {
    return '';
  }
}

function markDanger(text, ms, now) {
  if (!CONFIG.attention || !RISKY.test(text)) return;
  if (now >= danger.until) danger.at = now;
  danger.until = Math.max(danger.until, now + ms);
}

function trackRun(t, payload, now) {
  if (run.active) run.seen = now;
  if (t === 'message.start') {
    run.active = true;
    run.strands = 0;
    run.result = null;
    run.seen = now;
  } else if (t === 'tool.start') {
    if (!run.active) {
      run.active = true;
      run.strands = 0;
      run.result = null;
    }
    run.seen = now;
    run.strands = Math.min(WEB_MAX_SEGS, run.strands + 1);
    markDanger(payloadText(payload), 6000, now);
  } else if (t === 'approval.request') {
    markDanger(payloadText(payload), 120000, now);
  } else if (t === 'approval.cancelled' || t === 'approval.received' || t === 'approval.respond') {
    danger.until = 0;
  } else if (t === 'message.complete') {
    const status = payload && payload.status;
    run.active = false;
    run.result = status === 'error' ? 'error' : status === 'interrupted' ? null : 'done';
    run.resultAt = now;
  } else if (t === 'error') {
    run.active = false;
    run.result = 'error';
    run.resultAt = now;
  }
}

/** 0..1 visibility of the work web: full while the agent works, fades some seconds after the run ends. */
function webAlpha(now) {
  if (!CONFIG.web) return 0;
  if (run.active) return now - run.seen > 120000 ? 0 : 1;
  const fade = (since, hold) => Math.max(0, Math.min(1, 1 - (now - since - hold) / 3000));
  if (run.result === 'done') return fade(run.resultAt, 9000);
  if (run.result === 'error') return fade(run.resultAt, 12000);
  return 0;
}

/** The button or banner that needs the user while the agent waits (approval) or has failed. */
function findAttentionEl(kind) {
  const found = [];
  const pool = document.querySelectorAll(kind === 'waiting' ? 'button, [role="button"]' : '[role="alert"], [role="alertdialog"]');
  for (const el of pool) {
    if (el.closest('[data-wcs]') || !isVisible(el)) continue;
    if (kind === 'waiting') {
      const label = (el.textContent || '').trim();
      if (!/^(run|approve|allow|allow once|accept|yes|continue)$/i.test(label) && !/approval needed/i.test(el.getAttribute('aria-label') || '')) continue;
    }
    found.push(el);
  }
  return found.length ? found[found.length - 1] : null; // the newest one is lowest in the chat
}

/** Where a creature's body may stand so that its legs, knees and fangs stay fully inside the window. */
function bounds(c) {
  const m = 46 * c.size;
  const top = 56 * c.size; // knees arch upward on screen
  return { x0: m, x1: Math.max(m, window.innerWidth - m), y0: top, y1: Math.max(top, window.innerHeight - m) };
}

function clampTo(c, x, y) {
  const b = bounds(c);
  return { x: Math.min(Math.max(x, b.x0), b.x1), y: Math.min(Math.max(y, b.y0), b.y1) };
}

function faceToward(c, x, y, k) {
  let d = Math.atan2(y - c.body.y, x - c.body.x) - c.body.angle;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  c.body.angle += d * k;
}

function handleGatewayEvent(event) {
  if (!event || typeof event.type !== 'string') return;
  const t = event.type;
  const now = performance.now();
  if (t.startsWith('subagent.')) handleSubagentEvent(t, event.payload, now);
  trackRun(t, event.payload, now);
  if (t === 'approval.request' || t === 'sudo.request' || t === 'clarify.request' || t === 'secret.request') {
    mood.waiting = true;
  } else if (t === 'approval.cancelled' || t === 'approval.received' || t === 'approval.respond') {
    mood.waiting = false;
  } else if (t === 'error') {
    mood.errorUntil = now + 15000;
    mood.workUntil = 0;
  } else if (t === 'message.complete') {
    mood.waiting = false;
    mood.workUntil = 0;
    const status = event.payload && event.payload.status;
    if (status === 'error') mood.errorUntil = now + 15000;
    else if (status !== 'interrupted') mood.doneUntil = now + 5000;
  } else if (
    t === 'message.start' || t === 'message.delta' || t === 'tool.start' || t === 'tool.generating' ||
    t === 'reasoning.delta' || t === 'thinking.delta' || t.startsWith('subagent.')
  ) {
    if (t === 'message.start') mood.waiting = false;
    mood.workUntil = now + 4000;
  }
}

/** { name, color|null, pace } for the current agent state; priority waiting > error > done > working. */
function moodNow(now) {
  if (mood.waiting) return { name: 'waiting', color: MOOD_COLORS.waiting, pace: 0 };
  if (now < mood.errorUntil) return { name: 'error', color: MOOD_COLORS.error, pace: 1.8 };
  if (now < mood.doneUntil) return { name: 'done', color: MOOD_COLORS.done, pace: 1 };
  if (now < mood.workUntil) return { name: 'working', color: null, pace: 1.4 };
  return { name: 'idle', color: null, pace: 1 };
}

function resolveThemeColor(forced) {
  if (forced) return forced;
  const cs = getComputedStyle(document.documentElement);
  for (const name of THEME_VAR_NAMES) {
    let v = cs.getPropertyValue(name).trim();
    if (!v) continue;
    if (/^\d+(\.\d+)?\s+\d+%\s+\d+%$/.test(v)) v = `hsl(${v})`;
    else if (/^\d+\s+\d+\s+\d+$/.test(v)) v = `rgb(${v})`;
    return v;
  }
  if (CONFIG.explore) {
    const el = document.querySelector('a, button');
    if (el) {
      const c = getComputedStyle(el).color;
      if (c) return c;
    }
  }
  return '#00f0ff';
}

function isVisible(el) {
  const r = el.getBoundingClientRect();
  if (r.width < 6 || r.height < 6) return false;
  if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) return false;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
  if (el.closest('[data-wcs]')) return false; // never target our own nodes (incl. the status-bar chip)
  return true;
}

// Hit-test: is the element actually on top at its centre (not under a modal/menu)?
// Only run for the few candidates the spider is choosing between, not on every rescan.
function isReachable(el) {
  if (!el.isConnected) return false;
  const r = el.getBoundingClientRect();
  const px = Math.min(Math.max(r.left + r.width / 2, 0), window.innerWidth - 1);
  const py = Math.min(Math.max(r.top + r.height / 2, 0), window.innerHeight - 1);
  const hit = document.elementFromPoint(px, py);
  return !!hit && (hit === el || el.contains(hit));
}

function collectTargets(selector, max) {
  const els = document.querySelectorAll(selector);
  const out = [];
  for (const el of els) {
    if (out.length >= max) break;
    if (isVisible(el)) out.push(el);
  }
  return out;
}

function solveIK(originX, originY, targetX, targetY, l1, l2, bendFlip) {
  const dx = targetX - originX;
  const dy = targetY - originY;
  let dist = Math.hypot(dx, dy);
  if (dist < 0.001) dist = 0.001;
  dist = Math.min(dist, l1 + l2 - 0.001);
  const baseAngle = Math.atan2(dy, dx);
  const cosAngle = (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist);
  const angle = Math.acos(Math.max(-1, Math.min(1, cosAngle)));
  const shoulderAngle = baseAngle + (bendFlip ? -angle : angle);
  return {
    kneeX: originX + Math.cos(shoulderAngle) * l1,
    kneeY: originY + Math.sin(shoulderAngle) * l1,
    footX: originX + Math.cos(baseAngle) * dist,
    footY: originY + Math.sin(baseAngle) * dist,
  };
}

// Two-bone IK in the vertical plane through hip and foot (the 2.5D view): the
// knee is always on the upper side of the hip-foot line, so legs arch upward.
// d = ground distance hip->foot, hipZ/footZ = heights. Returns the knee as
// { kd: ground distance along hip->foot, kz: absolute height }.
function solveKnee(d, hipZ, footZ, l1, l2) {
  const dz = footZ - hipZ;
  let dist = Math.hypot(d, dz);
  if (dist < 0.001) dist = 0.001;
  const reach = Math.min(dist, l1 + l2 - 0.001);
  const base = Math.atan2(dz, d);
  const cosA = (l1 * l1 + reach * reach - l2 * l2) / (2 * l1 * reach);
  const a = Math.acos(Math.max(-1, Math.min(1, cosA)));
  const ang = base + a; // + = rotate upward
  return { kd: Math.cos(ang) * l1, kz: hipZ + Math.sin(ang) * l1 };
}

function localToWorld(body, local) {
  const cos = Math.cos(body.angle);
  const sin = Math.sin(body.angle);
  return {
    x: body.x + local.fx * cos - local.ly * sin,
    y: body.y + local.fx * sin + local.ly * cos,
  };
}

function makeLegs(size) {
  // small body, long legs: hips hug the body, feet rest far out
  const bases = [
    { fx: 8 * size, ly: 5 * size, rx: 36 * size, ry: 24 * size },
    { fx: 3 * size, ly: 6 * size, rx: 14 * size, ry: 36 * size },
    { fx: -3 * size, ly: 6 * size, rx: -14 * size, ry: 36 * size },
    { fx: -8 * size, ly: 5 * size, rx: -36 * size, ry: 24 * size },
  ];
  const legs = [];
  for (let side = 0; side < 2; side++) {
    const sign = side === 0 ? 1 : -1;
    bases.forEach((b, i) => {
      legs.push({
        baseLocal: { fx: b.fx, ly: b.ly * sign },
        restLocal: { fx: b.rx, ly: b.ry * sign },
        l1: 30 * size,
        l2: 36 * size,
        foot: { x: 0, y: 0 },
        stepping: false,
        stepFrom: { x: 0, y: 0 },
        stepTo: { x: 0, y: 0 },
        stepT: 0,
        tapOffset: 0,
        z: 0, // foot height above the ground while swinging
        group: (side + i) % 2, // tetrapod gait: diagonal legs move together
      });
    });
  }
  return legs;
}

function startSpider(ctx) {
  // hot-reload safety: a previous instance left mounted destroys itself first
  if (window.__webCrawlerSpider) {
    try {
      window.__webCrawlerSpider.destroy();
    } catch (e) {
      /* ignore */
    }
  }

  let themeColor = resolveThemeColor(CONFIG.accent);
  let accentNow = themeColor;
  let pal = isLightBackground() ? PALETTES.light : PALETTES.dark;

  const canvas = document.createElement('canvas');
  canvas.setAttribute('data-wcs', 'canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.position = 'fixed';
  canvas.style.top = '0';
  canvas.style.left = '0';
  canvas.style.pointerEvents = 'none';
  canvas.style.zIndex = String(CONFIG.zIndex);
  document.body.appendChild(canvas);
  const ctx2d = canvas.getContext('2d');

  const highlight = document.createElement('div');
  highlight.setAttribute('data-wcs', 'highlight');
  highlight.setAttribute('aria-hidden', 'true');
  highlight.style.position = 'fixed';
  highlight.style.pointerEvents = 'none';
  highlight.style.zIndex = String(CONFIG.zIndex - 1);
  highlight.style.transition = 'opacity .2s ease, left .18s ease, top .18s ease, width .18s ease, height .18s ease';
  highlight.style.opacity = '0';
  highlight.style.boxSizing = 'border-box';
  document.body.appendChild(highlight);

  function paintHighlight() {
    const col = accentNow;
    highlight.style.border = `1px solid ${col}`;
    highlight.style.background = `color-mix(in srgb, ${col} 10%, transparent)`;
    highlight.innerHTML = '';
    const corner = (top, left) => {
      const c = document.createElement('div');
      c.style.position = 'absolute';
      c.style.width = '6px';
      c.style.height = '6px';
      c.style.borderTop = top ? `2px solid ${col}` : 'none';
      c.style.borderBottom = !top ? `2px solid ${col}` : 'none';
      c.style.borderLeft = left ? `2px solid ${col}` : 'none';
      c.style.borderRight = !left ? `2px solid ${col}` : 'none';
      c.style.top = top ? '-2px' : 'auto';
      c.style.bottom = !top ? '-2px' : 'auto';
      c.style.left = left ? '-2px' : 'auto';
      c.style.right = !left ? '-2px' : 'auto';
      return c;
    };
    highlight.appendChild(corner(true, true));
    highlight.appendChild(corner(true, false));
    highlight.appendChild(corner(false, true));
    highlight.appendChild(corner(false, false));
  }
  paintHighlight();

  let res = 1;
  function resize() {
    // smooth mode renders at device resolution; pixel > 1 renders small and scales up
    res = CONFIG.pixel > 1 ? 1 / CONFIG.pixel : window.devicePixelRatio || 1;
    canvas.style.imageRendering = CONFIG.pixel > 1 ? 'pixelated' : 'auto';
    canvas.width = Math.max(1, Math.floor(window.innerWidth * res));
    canvas.height = Math.max(1, Math.floor(window.innerHeight * res));
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    collectNow();
  }

  let targets = [];
  let history = [];
  function collectNow() {
    // roaming mode reads nothing from the page: no targets, no scans
    targets = CONFIG.explore ? collectTargets(CONFIG.targetSelector, CONFIG.maxTargets) : [];
  }

  const rescanInterval = setInterval(() => {
    if (!paused && !suspended) collectNow();
  }, CONFIG.rescanMs);
  let scrollTimer = null;
  function onScroll() {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(collectNow, CONFIG.scrollSettleMs);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', resize);

  const themeInterval = setInterval(() => {
    if (suspended) return;
    themeColor = resolveThemeColor(CONFIG.accent);
    pal = isLightBackground() ? PALETTES.light : PALETTES.dark;
  }, CONFIG.themeReadMs);

  const prefersReducedMotion =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const stored = ctx && ctx.storage ? ctx.storage.get('wcs:paused') : undefined;
  let paused = stored !== undefined ? !!stored : !!prefersReducedMotion;
  // suspended = the window is in the background; unlike `paused` it is automatic and never saved
  let suspended = false;

  // ---- creatures: the big spider (index 0) and its babies ----
  const size = CONFIG.size;
  function makeCreature(sz, role, x, y) {
    const body = { x, y, angle: Math.random() * Math.PI * 2 };
    const legs = makeLegs(sz);
    for (const leg of legs) {
      const w = localToWorld(body, leg.restLocal);
      leg.foot.x = w.x;
      leg.foot.y = w.y;
    }
    return {
      role,
      size: sz,
      body,
      legs,
      stepMs: CONFIG.stepDurationMs * Math.sqrt(sz / size), // small legs swing faster
      speedMul: role === 'baby' ? 0.8 : role === 'helper' ? 0.9 : 1,
      last: { x, y },
      state: {
        mode: 'dwell', // 'walk' | 'dwell' | 'hunt' | 'eat' | 'nest' | 'sleep'
        currentEl: null,
        target: { x, y },
        dwellUntil: 0,
        bob: 0,
        hop: 0,
        curl: 0, // 0 = standing, 1 = folded up asleep, <0 = stretched tall
        groom: 0, // ticks left of grooming (front legs sweeping)
        stretch: 0, // ticks left of a stretch
        eatUntil: 0,
        scare: 0, // ticks left of scurrying away
        fleeTarget: null,
        headTwitch: 0,
        speedNow: 0, // body travel per 60 Hz step this frame
        globalStepCount: 0,
        activeGroup: 0,
        leaving: false, // helper: finished its job and walking off screen
        celebrate: 0, // helper: ticks left of the little finish dance
        pulseSeen: 0,
        wave: 0, // ticks left of waving at a visiting spider
        tapTick: 0,
        awayUntil: 0, // main: visiting another window until then
        chaseUntil: 0, // main: chasing the cursor until then
        stage: '', // guest: 'in' | 'wave' | 'out'
      },
      tint: null, // helper accent colour (null = theme accent)
      entry: null, // helper: its subagent registry entry
      hidden: false, // main is visiting another window
      origin: null, // guest: id of the window it came from
      born: 0,
    };
  }
  const main = makeCreature(size, 'main', window.innerWidth / 2, window.innerHeight / 2);
  const creatures = [main];
  const babyCount = Math.max(0, Math.min(4, Math.round(CONFIG.babies)));
  for (let i = 0; i < babyCount; i++) {
    const a = (i / Math.max(1, babyCount)) * Math.PI * 2;
    creatures.push(makeCreature(size * CONFIG.babyScale, 'baby', main.body.x + Math.cos(a) * 70, main.body.y + Math.sin(a) * 70));
  }
  const body = main.body;
  const state = main.state;
  const legs = main.legs;
  const leaderHist = []; // recent leader positions, babies follow these breadcrumbs

  // ---- a fly now and then: hunted, wrapped in silk and eaten ----
  let bug = null;
  let lastBug = null;
  let nextBugAt = performance.now() + 15000 + Math.random() * 20000;
  function spawnBug() {
    if (bug) return;
    const a = Math.random() * Math.PI * 2;
    const d = 180 + Math.random() * 120;
    bug = {
      x: Math.min(Math.max(body.x + Math.cos(a) * d, 50), window.innerWidth - 50),
      y: Math.min(Math.max(body.y + Math.sin(a) * d, 50), window.innerHeight - 50),
      z: 16,
      heading: Math.random() * Math.PI * 2,
      state: 'fly', // 'fly' | 'caught'
      born: performance.now(),
      phase: Math.random() * 10,
    };
  }
  function updateBug(now) {
    if (!bug) return;
    if (bug.state === 'caught') {
      if (state.mode !== 'eat') bug = null; // the spider was interrupted
      return;
    }
    bug.heading += (Math.random() - 0.5) * 0.6;
    bug.x += Math.cos(bug.heading) * 1.1;
    bug.y += Math.sin(bug.heading) * 1.1;
    if (bug.x < 30 || bug.x > window.innerWidth - 30 || bug.y < 30 || bug.y > window.innerHeight - 30) {
      bug.heading = Math.atan2(window.innerHeight / 2 - bug.y, window.innerWidth / 2 - bug.x);
      bug.x = Math.min(Math.max(bug.x, 30), window.innerWidth - 30);
      bug.y = Math.min(Math.max(bug.y, 30), window.innerHeight - 30);
    }
    bug.z = 16 + Math.sin(now / 180 + bug.phase) * 5;
    if (now - bug.born > 15000) bug = null; // it got away
  }

  // ---- input: wakes the spider, makes it curious, or scares it ----
  let lastActivity = performance.now();
  let napForced = false;
  let napStartedAt = 0;
  const pointer = { x: -9999, y: -9999, t: -1e9 };

  function noteActivity() {
    const now = performance.now();
    if (napForced && now - napStartedAt < 1500) return; // the nap command's own keystroke
    napForced = false;
    lastActivity = now;
  }
  function scare(c, fromX, fromY) {
    const dx = c.body.x - fromX;
    const dy = c.body.y - fromY;
    const d = Math.hypot(dx, dy) || 1;
    const dist = c.role === 'main' ? 300 : 200;
    c.state.fleeTarget = {
      ...clampTo(c, c.body.x + (dx / d) * dist, c.body.y + (dy / d) * dist),
    };
    c.state.scare = 90;
    c.state.hop = 16 * c.size;
    c.state.mode = 'walk';
    c.state.curl = Math.min(c.state.curl, 0.5);
  }
  function onPointerMove(e) {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.t = performance.now();
    noteActivity();
  }
  function onPointerDown(e) {
    noteActivity();
    for (const c of creatures) {
      if (c.hidden || c.role === 'guest') continue;
      if (Math.hypot(e.clientX - c.body.x, e.clientY - c.body.y) < CONFIG.scareRadius * (c.role === 'main' ? 1 : 0.6)) {
        scare(c, e.clientX, e.clientY);
      }
    }
  }
  // ---- wind: scrolling or moving the window sways the silk and makes the spider cling ----
  let wind = 0;
  let shake = 0;
  const lastWin = { x: window.screenX || 0, y: window.screenY || 0, w: window.innerWidth, h: window.innerHeight };
  function gust(a) {
    if (CONFIG.wind) wind = Math.min(1, wind + a);
  }
  function pollWindow() {
    const x = window.screenX || 0;
    const y = window.screenY || 0;
    const moved = Math.hypot(x - lastWin.x, y - lastWin.y);
    const resized = Math.abs(window.innerWidth - lastWin.w) + Math.abs(window.innerHeight - lastWin.h);
    if ((moved > 2 || resized > 2) && CONFIG.wind) {
      shake = Math.min(1, shake + (moved + resized) / 150);
      wind = Math.min(1, wind + (moved + resized) / 250);
    }
    lastWin.x = x;
    lastWin.y = y;
    lastWin.w = window.innerWidth;
    lastWin.h = window.innerHeight;
  }
  const listen = [
    ['scroll', () => gust(0.12)],
    ['wheel', (e) => gust(Math.min(0.25, Math.abs(e.deltaY || 0) / 800))],
    ['pointermove', onPointerMove],
    ['pointerdown', onPointerDown],
    ['keydown', noteActivity],
    ['wheel', noteActivity],
  ];
  for (const [type, fn] of listen) window.addEventListener(type, fn, { capture: true, passive: true });

  // ---- main spider: choosing where to go ----
  function pickNext() {
    if (!CONFIG.explore) {
      // roam only its own overlay: a random spot inside the window, never an app element
      const b = bounds(main);
      const near = Math.random() < 0.7 ? 260 * size : Infinity;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * (near === Infinity ? 0 : near);
      const p = near === Infinity
        ? { x: b.x0 + Math.random() * (b.x1 - b.x0), y: b.y0 + Math.random() * (b.y1 - b.y0) }
        : clampTo(main, body.x + Math.cos(a) * r, body.y + Math.sin(a) * r);
      state.currentEl = null;
      state.target.x = p.x;
      state.target.y = p.y;
      state.mode = 'walk';
      return;
    }
    const pool = targets.filter((el) => el.isConnected && !history.includes(el) && el !== state.currentEl);
    const source = pool.length ? pool : targets;
    if (!source.length) return;
    const withDist = source.map((el) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      return { el, cx, cy, d: Math.hypot(cx - body.x, cy - body.y) };
    });
    withDist.sort((a, b) => a.d - b.d);
    const nearest = [];
    for (const c of withDist) {
      if (nearest.length >= 4) break;
      if (isReachable(c.el)) nearest.push(c);
    }
    const choice = nearest[Math.floor(Math.random() * nearest.length)];
    if (!choice) return;
    state.currentEl = choice.el;
    state.target.x = choice.cx;
    state.target.y = choice.cy;
    state.mode = 'walk';
    history.push(state.currentEl);
    if (history.length > CONFIG.historyLen) history.shift();
  }

  // The element under the spider's body gets the box, whether it is dwelling
  // or just walking across it. Probing is throttled; the box tracks the
  // element's rect every step so it follows scrolling.
  let underEl = null;
  let probeTick = 0;
  function probeUnderBody() {
    if (!CONFIG.explore) {
      underEl = null;
      return;
    }
    const x = Math.min(Math.max(body.x, 0), window.innerWidth - 1);
    const y = Math.min(Math.max(body.y, 0), window.innerHeight - 1);
    const hit = document.elementFromPoint(x, y);
    const el = hit && hit.closest ? hit.closest(CONFIG.targetSelector) : null;
    underEl = el && !el.closest('[data-wcs]') ? el : null;
  }

  function updateHighlight() {
    if (probeTick++ % 3 === 0) probeUnderBody();
    const el = (state.mode === 'dwell' || state.mode === 'attend') && state.currentEl && state.currentEl.isConnected ? state.currentEl : underEl;
    if (!el || !el.isConnected || state.mode === 'away' || state.mode === 'chase' || state.curl > 0.3 || state.mode === 'hunt' || state.mode === 'eat') {
      highlight.style.opacity = '0';
      return;
    }
    const r = el.getBoundingClientRect();
    highlight.style.opacity = '1';
    highlight.style.left = r.left + 'px';
    highlight.style.top = r.top + 'px';
    highlight.style.width = r.width + 'px';
    highlight.style.height = r.height + 'px';
  }

  const STEP = 1 / 60;
  let acc = 0;
  let lastTime = 0;
  let lastRender = 0;
  let rafId = 0;

  /** Turn toward (tx, ty) and take one constant-speed step; true once within `arrival` px. */
  function walkToward(c, tx0, ty0, paceMul, arrival) {
    const { x: tx, y: ty } = clampTo(c, tx0, ty0); // never aim past the safe area, or it would walk on the spot
    const dx = tx - c.body.x;
    const dy = ty - c.body.y;
    const dist = Math.hypot(dx, dy);
    if (dist < arrival) {
      c.state.speedNow = 0;
      return true;
    }
    const desired = Math.atan2(dy, dx);
    let diff = desired - c.body.angle;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    // pivot, don't skid: a big heading error slows the body to a crawl, and the turn itself is rate-limited
    // so the legs can keep up (an instant spin leaves every leg in the air and crossed over the body)
    const turnFactor = Math.max(0.1, Math.cos(diff));
    const maxTurn = CONFIG.turnRate * Math.min(2.5, paceMul);
    c.body.angle += Math.max(-maxTurn, Math.min(maxTurn, diff * 0.14));
    // constant-speed walk along the heading (slower on sharp turns); speed is art
    // pixels per 60 Hz step, so it scales with CONFIG.unit
    const stepLen = Math.min(CONFIG.speed * CONFIG.unit * turnFactor * paceMul * c.speedMul, dist);
    c.state.speedNow = stepLen;
    const next = clampTo(c, c.body.x + Math.cos(c.body.angle) * stepLen, c.body.y + Math.sin(c.body.angle) * stepLen);
    c.body.x = next.x;
    c.body.y = next.y;
    return false;
  }

  const nestSpot = () => ({ x: window.innerWidth - 120, y: 130 });

  function updateMain(now) {
    const st = state;
    const m = moodNow(now);
    st.hop *= 0.9;

    if (st.scare > 0) {
      st.scare--;
      const f = st.fleeTarget;
      if (!f || walkToward(main, f.x, f.y, 2.6, 14) || st.scare === 0) {
        st.scare = 0;
        st.mode = 'dwell';
        st.dwellUntil = now + 600;
      }
      st.bob = Math.sin(now / 60) * 1.2;
      return;
    }

    // visiting another window: walk to the edge, vanish, come back when the visit ends
    if (st.mode === 'visit-out') {
      st.bob = Math.sin(now / (CONFIG.stepDurationMs * 0.5)) * 0.9;
      if (walkToward(main, st.target.x, st.target.y, 1.6, 14)) {
        st.mode = 'away';
        st.awayUntil = now + 30000;
        main.hidden = true;
        st.speedNow = 0;
        post({ t: 'visit', to: visitPeer });
      }
      return;
    }
    if (st.mode === 'away') {
      st.speedNow = 0;
      if (now > st.awayUntil) returnMain(now);
      return;
    }

    // spider-sense: a risky command is on its way -> freeze, stand tall, front legs up, red flashing
    const dng = CONFIG.attention && now < danger.until;
    if (dng) {
      raiseFront(main, 14);
      if (now - danger.at < 2500) {
        st.mode = 'dwell';
        st.dwellUntil = now + 400;
        st.speedNow = 0;
        st.bob = Math.sin(now / 40) * 0.5;
        st.curl += (-0.3 - st.curl) * 0.2;
        return;
      }
    }

    // a visiting spider: wave front legs at each other
    if (st.wave > 0) {
      st.wave--;
      st.mode = 'dwell';
      st.dwellUntil = now + 300;
      st.speedNow = 0;
      st.bob = Math.sin(now / 200);
      const w = 0.5 + 0.5 * Math.sin(now / 110);
      legs[0].tapOffset = Math.max(legs[0].tapOffset, 12 * size * w);
      legs[4].tapOffset = Math.max(legs[4].tapOffset, 12 * size * (1 - w));
      const g = creatures.find((c) => c.role === 'guest');
      if (g) faceToward(main, g.body.x, g.body.y, 0.1);
      return;
    }

    const quietFor = now - lastActivity;
    const wantSleep = CONFIG.sleep && m.name === 'idle' && (napForced || quietFor > CONFIG.sleepAfterMs);
    if (!wantSleep && (st.mode === 'sleep' || st.mode === 'nest')) {
      st.mode = 'dwell';
      st.dwellUntil = now + 800;
    }
    if (wantSleep && st.mode !== 'sleep' && st.mode !== 'nest') st.mode = 'nest';
    if (st.mode === 'sleep') st.curl = Math.min(1, st.curl + 0.02);
    else {
      if (st.mode !== 'dwell') st.stretch = 0;
      const cling = Math.min(0.3, shake * 0.4); // shaken: hug the ground
      const target = st.stretch > 0 ? -0.35 : cling; // stretching: stand tall, legs reach out
      st.curl += (target - st.curl) * (st.curl > 0 ? 0.25 : 0.12);
      if (st.stretch > 0) st.stretch--;
    }

    // a fly: spawn now and then while things are calm, hunt it, wrap it, eat it
    if (!bug && CONFIG.bugs && now >= nextBugAt && m.name === 'idle' && !wantSleep && (st.mode === 'dwell' || st.mode === 'walk')) {
      spawnBug();
      nextBugAt = now + 30000 + Math.random() * 30000;
    }
    if (bug && bug.state === 'fly' && !wantSleep && m.name === 'idle' && (st.mode === 'dwell' || st.mode === 'walk')) st.mode = 'hunt';

    // cursor chase: now and then, with the pointer on the move, dash after it for a few seconds
    const calmMood = m.name === 'idle' || m.name === 'working' || m.name === 'done';
    if (st.mode === 'chase') {
      if (!calmMood || dng || now > st.chaseUntil || pointer.t < 0) {
        st.mode = 'dwell';
        st.dwellUntil = now + 900;
        st.hop = Math.max(st.hop, 5 * size); // done: a little shake-off hop, then back to normal
      }
    } else if (
      CONFIG.chase && calmMood && !dng && !wantSleep && (st.mode === 'dwell' || st.mode === 'walk') &&
      now >= nextChaseAt && now - pointer.t < 800 && Math.hypot(pointer.x - body.x, pointer.y - body.y) > 60 && Math.random() < 0.004
    ) {
      startChase(now);
    }

    // attention: stand beside the button or banner that needs you
    const needy = m.name === 'waiting' || m.name === 'error';
    if (attTick++ % 20 === 0 || (attEl && !attEl.isConnected)) attEl = CONFIG.explore && CONFIG.attention && needy ? findAttentionEl(m.name) : null;
    const attending = !!(attEl && attEl.isConnected && needy);
    if (attending && (st.mode === 'dwell' || st.mode === 'walk' || st.mode === 'attend')) {
      st.mode = 'attend';
      st.currentEl = attEl;
    } else if (st.mode === 'attend') {
      st.mode = 'dwell';
      st.dwellUntil = now + 600;
    }

    if (st.mode === 'chase') {
      const dist = Math.hypot(pointer.x - body.x, pointer.y - body.y);
      st.bob = Math.sin(now / (CONFIG.stepDurationMs * 0.4)) * 1.6;
      if (walkToward(main, pointer.x, pointer.y, dist > 160 ? 2.6 : 1.8, 26 * size / 1.2)) {
        // caught up: pounce at it again and again
        faceToward(main, pointer.x, pointer.y, 0.3);
        if (st.tapTick++ % 18 === 0) st.hop = 9 * size;
        raiseFront(main, 10);
        st.headTwitch = Math.sin(now / 60) * 0.15;
      } else if (dist < 130) {
        raiseFront(main, 8);
      }
    } else if (st.mode === 'attend') {
      const r = attEl.getBoundingClientRect();
      const bx = r.left + r.width / 2;
      const by = r.top + r.height / 2;
      st.target.x = bx;
      st.target.y = by;
      const sx = Math.max(30, r.left - 36 * size); // stand beside it, not on it
      const sy = Math.max(30, by);
      if (walkToward(main, sx, sy, 1.5, 14)) {
        faceToward(main, bx, by, 0.15);
        st.bob = Math.sin(now / 150) * 1.1; // restless
        if (st.tapTick++ % 24 === 0) {
          const leg = legs[(st.tapTick / 24) & 1 ? 0 : 4];
          if (!leg.stepping) leg.tapOffset = 10 * size;
        }
      } else {
        st.bob = Math.sin(now / (CONFIG.stepDurationMs * 0.5)) * 1.1;
      }
    } else if (st.mode === 'nest') {
      const n = nestSpot();
      st.bob = Math.sin(now / (CONFIG.stepDurationMs * 0.5)) * 0.9;
      if (walkToward(main, n.x, n.y, 1, 16)) st.mode = 'sleep';
    } else if (st.mode === 'hunt') {
      if (!bug || bug.state !== 'fly') {
        st.mode = 'dwell';
        st.dwellUntil = now + 500;
      } else {
        st.bob = Math.sin(now / (CONFIG.stepDurationMs * 0.5)) * 1.2;
        if (walkToward(main, bug.x, bug.y, 2.2, 24 * size / 1.2)) {
          bug.state = 'caught'; // pounce
          st.mode = 'eat';
          st.eatUntil = now + 2400;
          st.hop = 12 * size;
        }
      }
    } else if (st.mode === 'eat') {
      st.speedNow = 0;
      st.bob = Math.sin(now / 70) * 1; // chewing
      st.headTwitch = Math.sin(now / 110) * 0.12;
      if (now > st.eatUntil) {
        bug = null;
        st.mode = 'dwell';
        st.dwellUntil = now + 800;
      }
    } else if (st.mode === 'sleep') {
      st.speedNow = 0;
      st.bob = Math.sin(now / 900) * 1; // slow breathing
    } else if (st.mode === 'dwell') {
      const calm = m.name !== 'waiting';
      if (calm && now > st.dwellUntil) pickNext();
      // curious: turn toward a nearby pointer that has moved recently
      const pd = Math.hypot(pointer.x - body.x, pointer.y - body.y);
      if (now - pointer.t < 1500 && pd < CONFIG.curiousRadius && pd > 20) {
        let diff = Math.atan2(pointer.y - body.y, pointer.x - body.x) - body.angle;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        body.angle += diff * 0.06;
        st.dwellUntil = Math.max(st.dwellUntil, now + 400);
      }
      // idle life: now and then groom (front legs sweep) or stretch tall
      if (st.groom > 0) {
        st.groom--;
        const w = 0.5 + 0.5 * Math.sin(st.groom / 4);
        legs[0].tapOffset = Math.max(legs[0].tapOffset, 9 * size * w);
        legs[4].tapOffset = Math.max(legs[4].tapOffset, 9 * size * (1 - w));
      } else if (st.stretch === 0 && calm && Math.random() < 0.0015) {
        if (Math.random() < 0.6) st.groom = 90;
        else st.stretch = 80;
      }
      const jumpy = m.name === 'waiting' ? 4 : 1; // waiting: restless twitching and tapping
      if (Math.random() < 0.012 * jumpy) st.headTwitch = (Math.random() - 0.5) * 0.3;
      if (Math.random() < 0.005 * jumpy) {
        const leg = legs[Math.floor(Math.random() * legs.length)];
        if (!leg.stepping) leg.tapOffset = 8 * size;
      }
      st.bob = Math.sin(now / 260) * 1.5;
      st.speedNow = 0;
    } else {
      const arrival = CONFIG.arrivalUnits * CONFIG.unit;
      if (walkToward(main, st.target.x, st.target.y, m.pace || 1, arrival)) {
        st.mode = 'dwell';
        const dwell = CONFIG.dwellMinMs + Math.random() * (CONFIG.dwellMaxMs - CONFIG.dwellMinMs);
        st.dwellUntil = now + (m.name === 'working' ? dwell * 0.6 : dwell);
      } else {
        // small rhythmic body sway synced to the stepping, like a real gait
        st.bob = Math.sin(now / (CONFIG.stepDurationMs * 0.5)) * (m.name === 'error' ? 2 : 0.9);
      }
    }

    // breadcrumbs for the babies and silk for the trail
    leaderHist.push({ x: body.x, y: body.y });
    if (leaderHist.length > 160) leaderHist.shift();
  }

  function updateBaby(c, idx, now) {
    const st = c.state;
    st.hop *= 0.9;
    if (st.scare > 0) {
      st.scare--;
      const f = st.fleeTarget;
      if (!f || walkToward(c, f.x, f.y, 2.2, 12) || st.scare === 0) st.scare = 0;
      st.bob = Math.sin(now / 60) * 0.8;
      return;
    }
    const lead = main.state;
    const gap = Math.hypot(main.body.x - c.body.x, main.body.y - c.body.y);
    // curl up beside a sleeping parent
    if (lead.mode === 'sleep' && gap < 160) {
      st.mode = 'sleep';
      st.curl = Math.min(1, st.curl + 0.02);
      st.speedNow = 0;
      st.bob = Math.sin(now / 900 + idx) * 0.6;
      return;
    }
    st.mode = 'walk';
    st.curl = Math.max(0, st.curl - 0.04);
    // follow breadcrumbs when the parent is travelling, huddle round it when it stands still
    let tx;
    let ty;
    if (lead.speedNow > 0.2 && leaderHist.length > 20) {
      const p = leaderHist[Math.max(0, leaderHist.length - 1 - (idx + 1) * 16)];
      tx = p.x;
      ty = p.y;
    } else {
      const a = (idx / Math.max(1, creatures.length - 1)) * Math.PI * 2 + now / 4000;
      tx = main.body.x + Math.cos(a) * (60 + idx * 14);
      ty = main.body.y + Math.sin(a) * (60 + idx * 14);
    }
    const dist = Math.hypot(tx - c.body.x, ty - c.body.y);
    const pace = Math.min(1.8, Math.max(0.2, dist / 80));
    if (walkToward(c, tx, ty, pace, 10)) {
      st.bob = Math.sin(now / 300 + idx) * 0.8;
      if (Math.random() < 0.01) st.headTwitch = (Math.random() - 0.5) * 0.4;
    } else {
      st.bob = Math.sin(now / (c.stepMs * 0.5)) * 0.6;
    }
  }

  // ---- helper spiders: one small spider per running subagent ----
  const HELPER_TINTS = ['#4cc9f0', '#f72585', '#b5e48c', '#ffd166'];
  const removedAt = [];
  let helperSerial = 0;
  let helperSyncTick = 0;
  let fixedTick = 0;

  function exitPoint(c) {
    const { x, y } = c.body;
    const b = bounds(c);
    const edges = [
      { d: x - b.x0, x: b.x0, y },
      { d: b.x1 - x, x: b.x1, y },
      { d: y - b.y0, x, y: b.y0 },
      { d: b.y1 - y, x, y: b.y1 },
    ];
    edges.sort((a, b) => a.d - b.d);
    return { x: edges[0].x, y: edges[0].y };
  }

  function sendHelperAway(c) {
    c.state.leaving = true;
    c.state.fleeTarget = null;
    c.state.scare = 0;
    c.state.target = exitPoint(c);
  }

  /** Spawn helpers for new subagents and release the ones whose subagent is done. */
  function syncHelpers(now) {
    const live = creatures.filter((c) => c.role === 'helper');
    for (const c of live) {
      const e = c.entry;
      if (!CONFIG.helpers || (e && !e.done && now - e.seen > CONFIG.helperStaleMs)) {
        if (e) e.done = true;
        if (!c.state.leaving) sendHelperAway(c);
      } else if (e && e.done && !c.state.leaving) {
        c.tint = e.ok ? '#3ddc84' : '#ff4d4d';
        c.state.celebrate = e.ok ? 70 : 0;
        c.state.hop = (e.ok ? 12 : 4) * c.size;
        sendHelperAway(c);
      }
    }
    let slots = Math.max(0, Math.round(CONFIG.maxHelpers) - live.length);
    for (const e of helperReg.values()) {
      if (e.done || now - e.seen > CONFIG.helperStaleMs) {
        // finished entries with no spider are simply forgotten once nobody shows them
        if (!live.some((c) => c.entry === e)) helperReg.delete(e.id);
        continue;
      }
      if (!CONFIG.helpers || slots <= 0 || live.some((c) => c.entry === e) || creatures.some((c) => c.entry === e)) continue;
      const a = Math.random() * Math.PI * 2;
      const h = makeCreature(size * CONFIG.helperScale, 'helper', main.body.x + Math.cos(a) * 30, main.body.y + Math.sin(a) * 30);
      h.entry = e;
      h.tint = HELPER_TINTS[helperSerial++ % HELPER_TINTS.length];
      h.state.mode = 'walk';
      h.state.hop = 10 * h.size; // drops out of the big spider
      h.state.pulseSeen = e.pulse;
      creatures.push(h);
      slots--;
    }
  }

  function updateHelper(c, now) {
    const st = c.state;
    st.hop *= 0.9;
    if (c.entry && c.entry.pulse !== st.pulseSeen) {
      st.pulseSeen = c.entry.pulse; // the subagent reported progress: a quick tap
      st.hop = Math.max(st.hop, 5 * c.size);
    }
    if (st.celebrate > 0) {
      st.celebrate--;
      st.mode = 'dwell';
      st.speedNow = 0;
      st.bob = Math.sin(now / 55) * 1.4;
      if (st.celebrate % 18 === 0) st.hop = 8 * c.size;
      return;
    }
    if (st.scare > 0 && !st.leaving) {
      st.scare--;
      const f = st.fleeTarget;
      if (!f || walkToward(c, f.x, f.y, 2.2, 12) || st.scare === 0) st.scare = 0;
      st.bob = Math.sin(now / 60) * 0.8;
      return;
    }
    if (st.leaving) {
      st.mode = 'walk';
      st.bob = Math.sin(now / 300) * 0.8;
      if (walkToward(c, st.target.x, st.target.y, 1.8, 14)) c.remove = true;
      return;
    }
    if (st.mode === 'dwell' && now < st.dwellUntil) {
      st.bob = Math.sin(now / 130) * 0.7; // busy at the element
      st.speedNow = 0;
      return;
    }
    if (st.mode !== 'walk' || !st.target || st.needTarget) {
      st.needTarget = false;
      const pool = targets.filter((el) => el.isConnected);
      let best = null;
      for (let k = 0; k < 6 && pool.length; k++) {
        const el = pool[Math.floor(Math.random() * pool.length)];
        if (!isReachable(el)) continue;
        const r = el.getBoundingClientRect();
        const cand = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        cand.d = Math.hypot(cand.x - main.body.x, cand.y - main.body.y);
        if (!best || cand.d < best.d) best = cand; // work near the big spider
      }
      st.target = best
        ? { x: best.x, y: best.y }
        : { x: 60 + Math.random() * (window.innerWidth - 120), y: 60 + Math.random() * (window.innerHeight - 120) };
      st.mode = 'walk';
    }
    if (walkToward(c, st.target.x, st.target.y, 1.1, 12)) {
      st.mode = 'dwell';
      st.dwellUntil = now + 800 + Math.random() * 1800;
      st.needTarget = true;
    } else {
      st.bob = Math.sin(now / 300) * 0.8;
      if (Math.random() < 0.01) st.headTwitch = (Math.random() - 0.5) * 0.4;
    }
  }

  function spawnHelperDemo() {
    demoHelper();
  }

  // ---- spider-sense pose, visiting spiders (other windows) ----
  let attEl = null;
  let nextChaseAt = performance.now() + CONFIG.chaseEveryMs * (0.3 + Math.random() * 0.4);
  function startChase(now) {
    state.mode = 'chase';
    state.chaseUntil = now + CONFIG.chaseMs * (0.8 + Math.random() * 0.4);
    state.groom = 0;
    state.stretch = 0;
    state.hop = Math.max(state.hop, 6 * size); // notices the cursor with a jump
    nextChaseAt = now + CONFIG.chaseEveryMs * (0.7 + Math.random() * 0.6);
  }
  let attTick = 0;
  function raiseFront(c, h) {
    c.legs[0].tapOffset = Math.max(c.legs[0].tapOffset, h * c.size);
    c.legs[4].tapOffset = Math.max(c.legs[4].tapOffset, h * c.size);
  }
  function replant(c) {
    for (const leg of c.legs) {
      const w = localToWorld(c.body, leg.restLocal);
      leg.foot.x = w.x;
      leg.foot.y = w.y;
      leg.stepping = false;
      leg.z = 0;
    }
  }

  const myId = Math.random().toString(36).slice(2, 9);
  const peers = new Map(); // window id -> last hello (performance.now)
  let visitPeer = null;
  let nextVisitAt = performance.now() + CONFIG.visitEveryMs * (0.5 + Math.random() * 0.5);
  let chan = null;
  const BC = window.BroadcastChannel || (typeof BroadcastChannel !== 'undefined' ? BroadcastChannel : null);
  function post(msg) {
    try {
      if (chan) chan.postMessage({ from: myId, ...msg });
    } catch (e) {
      /* a closed channel is fine */
    }
  }
  function spawnGuest(origin) {
    if (creatures.some((c) => c.role === 'guest')) return;
    const side = Math.floor(Math.random() * 4);
    const b = bounds({ size });
    const ex = side === 0 ? b.x0 : side === 1 ? b.x1 : b.x0 + Math.random() * (b.x1 - b.x0);
    const ey = side === 2 ? b.y0 : side === 3 ? b.y1 : b.y0 + Math.random() * (b.y1 - b.y0);
    const g = makeCreature(size, 'guest', ex, ey);
    g.tint = '#ff8fd0';
    g.origin = origin;
    g.born = performance.now();
    g.state.mode = 'walk';
    g.state.stage = 'in';
    creatures.push(g);
  }
  function returnMain(now) {
    main.hidden = false;
    replant(main);
    state.mode = 'dwell';
    state.dwellUntil = now + 800;
    state.curl = 0;
  }
  function pickPeer(now) {
    for (const [id, t] of peers) if (now - t < 16000) return id;
    return null;
  }
  function startVisit(now) {
    const id = pickPeer(now);
    if (!id || !chan || main.hidden || (state.mode !== 'dwell' && state.mode !== 'walk')) return false;
    visitPeer = id;
    state.mode = 'visit-out';
    state.scare = 0;
    state.target = exitPoint(main);
    return true;
  }
  function maybeVisit(now) {
    if (!CONFIG.peers || !chan || now < nextVisitAt) return;
    nextVisitAt = now + CONFIG.visitEveryMs * (0.7 + Math.random() * 0.6);
    if (moodNow(now).name !== 'idle' || bug || creatures.some((c) => c.role === 'guest')) return;
    startVisit(now);
  }
  function onPeerMsg(ev) {
    const d = ev && ev.data;
    if (!d || d.from === myId) return;
    const now = performance.now();
    if (suspended && (d.t === 'hello' || d.t === 'visit')) return; // a frozen window takes no visitors
    if (d.t === 'hello') {
      peers.set(d.from, now);
      if (!d.reply) post({ t: 'hello', reply: true });
    } else if (d.t === 'gone') {
      peers.delete(d.from);
    } else if (d.t === 'visit' && d.to === myId && CONFIG.peers) {
      spawnGuest(d.from);
    } else if (d.t === 'back' && d.to === myId && state.mode === 'away') {
      returnMain(now);
    }
  }
  if (BC && CONFIG.peers) {
    try {
      chan = new BC('web-crawler-spider/peers');
      chan.onmessage = onPeerMsg;
    } catch (e) {
      chan = null;
    }
  }
  const helloTimer = setInterval(() => {
    if (!suspended) post({ t: 'hello' });
  }, 5000);
  post({ t: 'hello' });

  function updateGuest(c, now) {
    const st = c.state;
    st.hop *= 0.9;
    if (now - c.born > 45000 && st.stage !== 'out') {
      st.stage = 'out';
      st.target = exitPoint(c);
    }
    if (st.stage === 'in') {
      st.mode = 'walk';
      st.bob = Math.sin(now / 280) * 0.8;
      if (walkToward(c, main.body.x, main.body.y, 1.3, 90 * size / 1.2)) {
        st.stage = 'wave';
        st.wave = 200;
        main.state.wave = 200;
      }
    } else if (st.stage === 'wave') {
      st.mode = 'dwell';
      st.speedNow = 0;
      st.bob = Math.sin(now / 200);
      faceToward(c, main.body.x, main.body.y, 0.1);
      const w = 0.5 + 0.5 * Math.sin(now / 110 + 1.5);
      c.legs[0].tapOffset = Math.max(c.legs[0].tapOffset, 12 * c.size * w);
      c.legs[4].tapOffset = Math.max(c.legs[4].tapOffset, 12 * c.size * (1 - w));
      if (--st.wave <= 0) {
        st.stage = 'out';
        st.target = exitPoint(c);
      }
    } else {
      st.mode = 'walk';
      st.bob = Math.sin(now / 300) * 0.8;
      if (walkToward(c, st.target.x, st.target.y, 1.5, 14)) {
        c.remove = true;
        if (c.origin) post({ t: 'back', to: c.origin });
      }
    }
  }

  /** Demand-driven tetrapod gait + leg physics for one creature. */
  function updateGait(c) {
    const { body, legs, state, size } = c;
    const restOf = (leg) => {
      const k = 1 - 0.55 * state.curl; // asleep: feet tuck in toward the body
      return localToWorld(body, { fx: leg.restLocal.fx * k, ly: leg.restLocal.ly * k });
    };
    state.headTwitch *= 0.9;
    for (const leg of legs) leg.tapOffset *= 0.85;
    const lead = state.speedNow * (c.stepMs / (1000 / 60)) * CONFIG.leadFactor;

    // Demand-driven gait: hand the turn to the other group as soon as the active
    // one is planted and only the other one has drifted past the threshold, so
    // legs never wait on a fixed step count while the body outruns them.
    const need = [false, false];
    const busy = [false, false];
    for (const leg of legs) {
      if (leg.stepping) {
        busy[leg.group] = true;
        continue;
      }
      const rest = restOf(leg);
      if (Math.hypot(rest.x - leg.foot.x, rest.y - leg.foot.y) > CONFIG.stepThreshold * size) {
        need[leg.group] = true;
      }
    }
    if (!need[state.activeGroup] && !busy[state.activeGroup] && need[1 - state.activeGroup]) {
      state.activeGroup = 1 - state.activeGroup;
    }

    for (const leg of legs) {
      const ideal = restOf(leg);
      if (leg.stepping) {
        leg.stepT += (STEP * 1000) / c.stepMs;
        if (leg.stepT >= 1) {
          leg.stepT = 1;
          leg.stepping = false;
          leg.foot.x = leg.stepTo.x;
          leg.foot.y = leg.stepTo.y;
          leg.z = 0;
          state.globalStepCount++;
        } else {
          const t = leg.stepT;
          const e = t * t * (3 - 2 * t); // ease: lift off, swing, plant
          const lift = Math.sin(t * Math.PI) * CONFIG.swingLift * size;
          // the landing spot follows the moving body, led ahead along the heading
          const tx = ideal.x + Math.cos(body.angle) * lead;
          const ty = ideal.y + Math.sin(body.angle) * lead;
          leg.stepTo = { x: tx, y: ty };
          leg.foot.x = leg.stepFrom.x + (tx - leg.stepFrom.x) * e;
          leg.foot.y = leg.stepFrom.y + (ty - leg.stepFrom.y) * e;
          leg.z = lift;
        }
      } else {
        const err = Math.hypot(ideal.x - leg.foot.x, ideal.y - leg.foot.y);
        // the hard limit forces a step regardless of group so a leg can never be dragged past its reach
        const hipW = localToWorld(body, leg.baseLocal);
        const stretch = Math.hypot(leg.foot.x - hipW.x, leg.foot.y - hipW.y) / (leg.l1 + leg.l2);
        const overdue = err > CONFIG.stepThreshold * size * CONFIG.forceStepFactor || stretch > CONFIG.maxStretch;
        if (err > CONFIG.stepThreshold * size && (leg.group === state.activeGroup || overdue)) {
          leg.stepping = true;
          leg.stepT = 0;
          leg.stepFrom = { x: leg.foot.x, y: leg.foot.y };
          leg.stepTo = { x: ideal.x + Math.cos(body.angle) * lead, y: ideal.y + Math.sin(body.angle) * lead };
        }
      }
    }

  }

  function fixedUpdate() {
    const now = performance.now();
    const m = moodNow(now);
    const dangerOn = CONFIG.attention && now < danger.until;
    const col = dangerOn ? (Math.floor(now / 350) % 2 ? '#ff3b3b' : '#ff8c42') : m.color || themeColor;
    if (col !== accentNow) {
      accentNow = col;
      paintHighlight();
    }
    updateBug(now);
    if (fixedTick++ % 6 === 0) pollWindow();
    wind = wind < 0.002 ? 0 : wind * 0.975;
    shake = shake < 0.01 ? 0 : shake * 0.96;
    maybeVisit(now);
    updateMain(now);
    if (shake > 0.05 && !main.hidden) {
      state.bob += (Math.random() - 0.5) * 3 * shake;
      if (Math.random() < 0.06 * shake) state.hop = Math.max(state.hop, 5 * size * shake);
    }
    if (helperSyncTick++ % 10 === 0 || helperReg.size) syncHelpers(now);
    for (let i = 1; i < creatures.length; i++) {
      if (creatures[i].role === 'helper') updateHelper(creatures[i], now);
      else if (creatures[i].role === 'guest') updateGuest(creatures[i], now);
      else updateBaby(creatures[i], i - 1, now);
    }
    for (let i = creatures.length - 1; i > 0; i--) {
      const c = creatures[i];
      if (!c.remove) continue;
      creatures.splice(i, 1);
      removedAt.push({ x: c.body.x, y: c.body.y, m: 150 * c.size, lx: c.last.x, ly: c.last.y }); // render still has to wipe it
      if (c.entry) helperReg.delete(c.entry.id);
    }
    for (const c of creatures) {
      if (c.hidden) continue;
      const inside = clampTo(c, c.body.x, c.body.y); // e.g. the window was made smaller
      c.body.x = inside.x;
      c.body.y = inside.y;
      updateGait(c);
    }
    updateHighlight();
  }

  // ---- drawing ----
  function drawCreature(c, themeColor) {
    const { body, legs, state, size } = c;
    const bob = state.bob - state.hop;
    const hipH = CONFIG.hipHeight * size * (1 - 0.5 * state.curl); // asleep: belly low to the ground
    const drawAngle = body.angle + state.headTwitch;
    const bobBody = { x: body.x, y: body.y + bob - hipH, angle: drawAngle };

    // soft ground shadow
    ctx2d.fillStyle = pal.shadow;
    ctx2d.beginPath();
    ctx2d.ellipse(body.x + 2 * size, body.y + 4 * size, 14 * size, 8 * size, body.angle, 0, Math.PI * 2);
    ctx2d.fill();

    // 2.5D: world (x, y, z) projects to screen (x, y - z). The whole body rides
    // hipHeight above the ground; legs arch up to knees then plant on the ground.
    // the body bob moves the hips too, so legs ride the body instead of staying put
    const H = hipH - bob;
    function drawLeg(leg) {
      const hip = localToWorld({ x: body.x, y: body.y, angle: drawAngle }, leg.baseLocal);
      const footZ = leg.z + (leg.tapOffset > 0.3 ? leg.tapOffset : 0);
      const dx = leg.foot.x - hip.x;
      const dy = leg.foot.y - hip.y;
      const d = Math.hypot(dx, dy) || 0.001;
      const k = solveKnee(d, H, footZ, leg.l1, leg.l2);
      const hx = hip.x;
      const hy = hip.y - H;
      const kx = hip.x + (dx / d) * k.kd;
      const ky = hip.y + (dy / d) * k.kd - k.kz;
      const fx = leg.foot.x;
      const fy = leg.foot.y - footZ;
      // ground contact dot
      if (footZ < 0.5) {
        ctx2d.fillStyle = pal.dot;
        ctx2d.beginPath();
        ctx2d.arc(leg.foot.x, leg.foot.y, 1.8 * size, 0, Math.PI * 2);
        ctx2d.fill();
      }
      ctx2d.strokeStyle = pal.ink;
      // three visible segments: femur (hip->knee, thick), tibia (knee->ankle),
      // tarsus (ankle->foot, thin). The ankle sits 72% of the way down and is
      // pushed outward from the body so each leg has a second, smaller bend.
      const ox = fx - body.x;
      const oy = fy - (body.y - H);
      const on = Math.hypot(ox, oy) || 1;
      const ax = kx + (fx - kx) * 0.72 + (ox / on) * 5 * size;
      const ay = ky + (fy - ky) * 0.72 + (oy / on) * 5 * size - 2 * size;
      const seg = (x1, y1, x2, y2, w, color) => {
        ctx2d.strokeStyle = color;
        ctx2d.lineWidth = w;
        ctx2d.beginPath();
        ctx2d.moveTo(x1, y1);
        ctx2d.lineTo(x2, y2);
        ctx2d.stroke();
      };
      const DARK = pal.ink;
      seg(hx, hy, kx, ky, 4.6 * size, DARK); // femur sleeve
      seg(kx, ky, ax, ay, 3 * size, DARK); // tibia sleeve
      seg(ax, ay, fx, fy, 1.8 * size, DARK); // tarsus sleeve
      seg(hx, hy, kx, ky, 1.6 * size, themeColor); // accent cores taper with the limb
      seg(kx, ky, ax, ay, 1.1 * size, themeColor);
      seg(ax, ay, fx, fy, 0.7 * size, themeColor);
      // joints: square knee block, small ankle block, pointed foot tip
      ctx2d.fillStyle = DARK;
      ctx2d.strokeStyle = themeColor;
      ctx2d.lineWidth = 1;
      ctx2d.fillRect(kx - 2.6 * size, ky - 2.6 * size, 5.2 * size, 5.2 * size);
      ctx2d.strokeRect(kx - 2.6 * size, ky - 2.6 * size, 5.2 * size, 5.2 * size);
      ctx2d.fillRect(ax - 1.5 * size, ay - 1.5 * size, 3 * size, 3 * size);
      ctx2d.strokeRect(ax - 1.5 * size, ay - 1.5 * size, 3 * size, 3 * size);
      ctx2d.fillStyle = themeColor;
      ctx2d.beginPath();
      ctx2d.arc(fx, fy, 1.1 * size, 0, Math.PI * 2);
      ctx2d.fill();
    }
    // painter's order: legs behind the body first, legs in front after it
    const farLegs = legs.filter((l) => localToWorld(body, l.baseLocal).y <= body.y);
    const nearLegs = legs.filter((l) => localToWorld(body, l.baseLocal).y > body.y);
    for (const leg of farLegs) drawLeg(leg);

    // box body: every part is a rotated rectangle (abdomen, thorax, head)
    const bs = size * CONFIG.bodyScale;
    const pt = (fx, ly) => localToWorld(bobBody, { fx: fx * bs, ly: ly * bs });
    // extruded box: dark side walls (thickness t, screen-down) under a lighter top face
    const box = (x0, x1, y0, y1, fill, stroke, t) => {
      const th = t * size;
      const top = [pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)];
      ctx2d.lineJoin = 'miter';
      ctx2d.lineWidth = 1.2;
      ctx2d.strokeStyle = stroke;
      ctx2d.fillStyle = pal.ink;
      for (let k = 0; k < 4; k++) {
        const a = top[k];
        const b = top[(k + 1) % 4];
        ctx2d.beginPath();
        ctx2d.moveTo(a.x, a.y);
        ctx2d.lineTo(b.x, b.y);
        ctx2d.lineTo(b.x, b.y + th);
        ctx2d.lineTo(a.x, a.y + th);
        ctx2d.closePath();
        ctx2d.fill();
        ctx2d.stroke();
      }
      ctx2d.fillStyle = fill;
      ctx2d.beginPath();
      top.forEach((c, k) => (k ? ctx2d.lineTo(c.x, c.y) : ctx2d.moveTo(c.x, c.y)));
      ctx2d.closePath();
      ctx2d.fill();
      ctx2d.stroke();
      ctx2d.lineJoin = 'round';
    };

    // abdomen (rear) with two accent bars
    box(-24, -5, -10, 10, pal.abdomen, themeColor, 6);
    ctx2d.fillStyle = themeColor;
    for (const [x0, x1] of [[-20, -17], [-13, -10]]) {
      const a = pt(x0, -7);
      const b = pt(x1, -7);
      const c = pt(x1, 7);
      const d = pt(x0, 7);
      ctx2d.beginPath();
      ctx2d.moveTo(a.x, a.y);
      ctx2d.lineTo(b.x, b.y);
      ctx2d.lineTo(c.x, c.y);
      ctx2d.lineTo(d.x, d.y);
      ctx2d.closePath();
      ctx2d.fill();
    }

    // thorax and head
    box(-5, 7, -8, 8, pal.thorax, themeColor, 5);
    box(7, 18, -7, 7, pal.head, themeColor, 4);

    // square fangs
    ctx2d.fillStyle = themeColor;
    for (const sgn of [-1, 1]) {
      const a = pt(18, 2 * sgn);
      const b = pt(22, 2 * sgn);
      const c = pt(22, 4 * sgn);
      const d = pt(18, 4 * sgn);
      ctx2d.beginPath();
      ctx2d.moveTo(a.x, a.y);
      ctx2d.lineTo(b.x, b.y);
      ctx2d.lineTo(c.x, c.y);
      ctx2d.lineTo(d.x, d.y);
      ctx2d.closePath();
      ctx2d.fill();
    }

    // square eyes: two big at the front, small ones behind
    const eyes = [
      [15, -4, 2.6], [15, 4, 2.6],
      [11, -5, 1.2], [11, 5, 1.2],
      [10, -1.8, 1], [10, 1.8, 1],
    ];
    for (const [fx, ly, r] of eyes) {
      const a = pt(fx - r, ly - r);
      const b = pt(fx + r, ly - r);
      const c = pt(fx + r, ly + r);
      const d = pt(fx - r, ly + r);
      ctx2d.fillStyle = r > 2 ? themeColor : pal.eye;
      ctx2d.beginPath();
      ctx2d.moveTo(a.x, a.y);
      ctx2d.lineTo(b.x, b.y);
      ctx2d.lineTo(c.x, c.y);
      ctx2d.lineTo(d.x, d.y);
      ctx2d.closePath();
      ctx2d.fill();
    }

    // pedipalps: two short jointed front arms that sway and tap while walking
    const tnow = performance.now();
    const sway = state.mode === 'walk' ? Math.sin(tnow / (CONFIG.stepDurationMs * 0.9)) : Math.sin(tnow / 420) * 0.35;
    for (const sgn of [-1, 1]) {
      const ph = sgn * sway;
      const base = pt(17, 3 * sgn);
      const elbow = pt(24, (7 + ph * 2) * sgn);
      const tip = pt(30 + ph * 3, (3 + ph * 1.5) * sgn);
      ctx2d.strokeStyle = pal.ink;
      ctx2d.lineWidth = 3.2 * size;
      ctx2d.beginPath();
      ctx2d.moveTo(base.x, base.y);
      ctx2d.lineTo(elbow.x, elbow.y - 3 * size);
      ctx2d.lineTo(tip.x, tip.y);
      ctx2d.stroke();
      ctx2d.strokeStyle = themeColor;
      ctx2d.lineWidth = 1.1 * size;
      ctx2d.beginPath();
      ctx2d.moveTo(base.x, base.y);
      ctx2d.lineTo(elbow.x, elbow.y - 3 * size);
      ctx2d.lineTo(tip.x, tip.y);
      ctx2d.stroke();
      ctx2d.fillStyle = themeColor;
      ctx2d.fillRect(tip.x - 1.8 * size, tip.y - 1.8 * size, 3.6 * size, 3.6 * size);
    }

    for (const leg of nearLegs) drawLeg(leg);
  }

  /** Straight silk line from the spider to the element it is walking toward. */
  function currentGuide() {
    const el = state.currentEl;
    if (!CONFIG.trail || (state.mode !== 'walk' && state.mode !== 'attend') || state.scare > 0) return null;
    if (!el && state.mode === 'walk' && !CONFIG.explore) {
      return { x0: body.x, y0: body.y - CONFIG.hipHeight * size * (1 - 0.5 * state.curl) + state.bob - state.hop, x1: state.target.x, y1: state.target.y };
    }
    if (!el || !el.isConnected) return null;
    const r = el.getBoundingClientRect();
    return {
      x0: body.x,
      y0: body.y - CONFIG.hipHeight * size * (1 - 0.5 * state.curl) + state.bob - state.hop,
      x1: r.left + r.width / 2,
      y1: r.top + r.height / 2,
    };
  }

  function drawGuide(g, now) {
    ctx2d.save();
    ctx2d.strokeStyle = accentNow;
    ctx2d.fillStyle = accentNow;
    ctx2d.lineWidth = 1;
    ctx2d.globalAlpha = 0.55;
    ctx2d.beginPath();
    ctx2d.moveTo(g.x0, g.y0);
    if (wind > 0.01) {
      // a breeze bows the thread; at rest it is straight again
      const dx = g.x1 - g.x0;
      const dy = g.y1 - g.y0;
      const len = Math.hypot(dx, dy) || 1;
      const sway = wind * 9 * Math.sin(now / 130);
      ctx2d.quadraticCurveTo((g.x0 + g.x1) / 2 - (dy / len) * sway, (g.y0 + g.y1) / 2 + (dx / len) * sway, g.x1, g.y1);
    } else {
      ctx2d.lineTo(g.x1, g.y1);
    }
    ctx2d.stroke();
    ctx2d.globalAlpha = 0.9;
    ctx2d.fillRect(g.x1 - 2, g.y1 - 2, 4, 4); // anchor on the target
    ctx2d.restore();
  }

  function drawBug(now) {
    if (!bug) return;
    ctx2d.save();
    if (bug.state === 'fly') {
      ctx2d.fillStyle = pal.shadow;
      ctx2d.beginPath();
      ctx2d.ellipse(bug.x, bug.y, 3.5, 2, 0, 0, Math.PI * 2);
      ctx2d.fill();
      const bx = bug.x;
      const by = bug.y - bug.z;
      const flick = Math.floor(now / 45) % 2 ? 1 : 0.55; // wings buzz
      ctx2d.fillStyle = accentNow;
      ctx2d.globalAlpha = 0.45;
      ctx2d.beginPath();
      ctx2d.ellipse(bx - 3, by - 2, 4 * flick, 2, -0.5, 0, Math.PI * 2);
      ctx2d.ellipse(bx + 3, by - 2, 4 * flick, 2, 0.5, 0, Math.PI * 2);
      ctx2d.fill();
      ctx2d.globalAlpha = 1;
      ctx2d.fillStyle = pal.ink;
      ctx2d.beginPath();
      ctx2d.ellipse(bx, by, 2.2, 3, 0, 0, Math.PI * 2);
      ctx2d.fill();
    } else {
      // wrapped in silk: a little cocoon criss-crossed with threads
      const bx = bug.x;
      const by = bug.y - 4;
      ctx2d.fillStyle = pal.eye;
      ctx2d.globalAlpha = 0.85;
      ctx2d.beginPath();
      ctx2d.ellipse(bx, by, 5, 7, 0.4, 0, Math.PI * 2);
      ctx2d.fill();
      ctx2d.globalAlpha = 0.7;
      ctx2d.strokeStyle = accentNow;
      ctx2d.lineWidth = 0.8;
      for (let i = -2; i <= 2; i++) {
        ctx2d.beginPath();
        ctx2d.moveTo(bx - 5, by + i * 2.6);
        ctx2d.lineTo(bx + 5, by + i * 2.6 + 2);
        ctx2d.stroke();
      }
    }
    ctx2d.restore();
  }

  function drawNestWeb(now) {
    const k = state.curl;
    if (k < 0.05) return;
    const cx = nestSpot().x;
    const cy = nestSpot().y;
    const R = 105 * k;
    ctx2d.strokeStyle = accentNow;
    ctx2d.lineWidth = 1;
    ctx2d.globalAlpha = 0.4 * k;
    const spokes = 9;
    for (let i = 0; i < spokes; i++) {
      const a = Math.PI * 0.5 + (i / (spokes - 1)) * Math.PI * 1.5 + 0.15;
      ctx2d.beginPath();
      ctx2d.moveTo(cx, cy);
      ctx2d.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      ctx2d.stroke();
    }
    for (let r = 1; r <= 3; r++) {
      ctx2d.beginPath();
      for (let i = 0; i < spokes; i++) {
        const a = Math.PI * 0.5 + (i / (spokes - 1)) * Math.PI * 1.5 + 0.15;
        const x = cx + Math.cos(a) * R * (r / 3);
        const y = cy + Math.sin(a) * R * (r / 3);
        if (i === 0) ctx2d.moveTo(x, y);
        else ctx2d.lineTo(x, y);
      }
      ctx2d.stroke();
    }
    ctx2d.globalAlpha = 1;
    // Zzz drifting up from the sleeper
    if (state.mode === 'sleep') {
      ctx2d.fillStyle = accentNow;
      ctx2d.font = `bold ${13 * size}px sans-serif`;
      for (let i = 0; i < 3; i++) {
        const ph = ((now / 1400 + i / 3) % 1);
        ctx2d.globalAlpha = Math.sin(ph * Math.PI) * 0.8;
        ctx2d.font = `bold ${(9 + i * 3 + ph * 4) * size}px sans-serif`;
        ctx2d.fillText('z', body.x + 22 * size + i * 8 * size, body.y - 30 * size - ph * 34 * size);
      }
      ctx2d.globalAlpha = 1;
    }
  }

  /** The work web: spokes appear with the run, a zigzag strand is added per tool call. */
  function drawWorkWeb(now, alpha) {
    const { x: cx, y: cy } = nestSpot();
    const R = 105;
    const spokes = 9;
    const ang = (i) => Math.PI * 0.5 + (i / (spokes - 1)) * Math.PI * 1.5 + 0.15;
    const sw = (frac, j) => wind * 7 * frac * Math.sin(now / 170 + j * 0.8);
    const pt = (j) => {
      const pos = j % (2 * (spokes - 1));
      const idx = pos < spokes ? pos : 2 * (spokes - 1) - pos;
      const rad = R * (0.1 + (0.9 * j) / WEB_MAX_SEGS);
      return { x: cx + Math.cos(ang(idx)) * rad + sw(rad / R, j), y: cy + Math.sin(ang(idx)) * rad + sw(rad / R, j + 3) };
    };
    ctx2d.save();
    ctx2d.strokeStyle = accentNow;
    ctx2d.lineWidth = 1;
    ctx2d.globalAlpha = 0.3 * alpha;
    for (let i = 0; i < spokes; i++) {
      ctx2d.beginPath();
      ctx2d.moveTo(cx, cy);
      ctx2d.lineTo(cx + Math.cos(ang(i)) * R + sw(1, i), cy + Math.sin(ang(i)) * R + sw(1, i + 3));
      ctx2d.stroke();
    }
    const segs = Math.min(WEB_MAX_SEGS, run.strands * 2);
    const torn = run.result === 'error';
    let prev = { x: cx, y: cy };
    ctx2d.globalAlpha = 0.65 * alpha;
    for (let j = 1; j <= segs; j++) {
      const cur = pt(j);
      if (!(torn && j % 5 === 0)) {
        ctx2d.beginPath();
        ctx2d.moveTo(prev.x, prev.y);
        ctx2d.lineTo(cur.x, cur.y);
        ctx2d.stroke();
      }
      if (run.result === 'done' && j % 3 === 0) {
        ctx2d.globalAlpha = (0.55 + 0.4 * Math.sin(now / 400 + j)) * alpha; // dew twinkles
        ctx2d.fillStyle = 'rgba(200,240,255,1)';
        ctx2d.beginPath();
        ctx2d.arc(cur.x, cur.y, 2, 0, Math.PI * 2);
        ctx2d.fill();
        ctx2d.globalAlpha = 0.65 * alpha;
      }
      prev = cur;
    }
    if (torn) {
      ctx2d.strokeStyle = '#ff4d4d'; // loose, hanging strands
      for (let i = 1; i < spokes; i += 2) {
        const x = cx + Math.cos(ang(i)) * R;
        const y = cy + Math.sin(ang(i)) * R;
        ctx2d.beginPath();
        ctx2d.moveTo(x, y);
        ctx2d.lineTo(x + Math.sin(now / 500 + i) * 4, y + 16 + (i % 3) * 6);
        ctx2d.stroke();
      }
    } else if (run.active && segs > 0) {
      ctx2d.fillStyle = accentNow; // the strand being spun
      ctx2d.globalAlpha = alpha;
      ctx2d.fillRect(prev.x - 1.5, prev.y - 1.5, 3, 3);
    }
    ctx2d.restore();
  }

  function drawAlert(now) {
    const y = main.body.y - 52 * size - 4 * Math.abs(Math.sin(now / 120));
    ctx2d.save();
    ctx2d.fillStyle = Math.floor(now / 350) % 2 ? '#ff3b3b' : '#ff8c42';
    ctx2d.font = `bold ${22 * size}px sans-serif`;
    ctx2d.textAlign = 'center';
    ctx2d.fillText('!', main.body.x, y);
    ctx2d.restore();
  }

  function render() {
    const now = performance.now();
    // clear only where the creatures were and are now (legs reach ~70 units, knees ~40 up),
    // plus the silk trail and the nest web
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const grow = (x, y, m) => {
      x0 = Math.min(x0, x - m);
      y0 = Math.min(y0, y - m);
      x1 = Math.max(x1, x + m);
      y1 = Math.max(y1, y + m);
    };
    for (const c of creatures) {
      const m = 150 * c.size;
      grow(c.body.x, c.body.y, m);
      grow(c.last.x, c.last.y, m);
    }
    for (const r of removedAt.splice(0)) {
      grow(r.x, r.y, r.m);
      grow(r.lx, r.ly, r.m);
    }
    for (const b of [bug, lastBug]) if (b) grow(b.x, b.y, 30);
    lastBug = bug ? { x: bug.x, y: bug.y } : null;
    guide = currentGuide();
    for (const g of [guide, lastGuide]) {
      if (!g) continue;
      grow(g.x0, g.y0, 16);
      grow(g.x1, g.y1, 16);
    }
    lastGuide = guide;
    const wa = webAlpha(now);
    if (state.curl > 0.01 || nestVisible || wa > 0.01 || webWasVisible) grow(nestSpot().x, nestSpot().y, 150);
    nestVisible = state.curl > 0.01;
    webWasVisible = wa > 0.01;
    ctx2d.setTransform(1, 0, 0, 1, 0, 0);
    ctx2d.clearRect(x0 * res, y0 * res, (x1 - x0) * res, (y1 - y0) * res);
    ctx2d.setTransform(res, 0, 0, res, 0, 0);
    for (const c of creatures) c.last = { x: c.body.x, y: c.body.y };
    ctx2d.lineJoin = 'round';
    ctx2d.lineCap = 'round';

    drawNestWeb(now);
    if (wa > 0.01) drawWorkWeb(now, wa);
    if (guide) drawGuide(guide, now);
    drawBug(now);
    // far-to-near so a creature lower on screen overlaps one above it
    const order = creatures.slice().sort((a, b) => a.body.y - b.body.y);
    for (const c of order) if (!c.hidden) drawCreature(c, c.tint || accentNow);
    if (CONFIG.attention && now < danger.until && !main.hidden) drawAlert(now);
  }
  let guide = null;
  let lastGuide = null;
  let nestVisible = false;
  let webWasVisible = false;

  function loop(now) {
    if (paused || suspended) return; // loop fully stops; resume() / wakeUp() restarts it
    const frameDt = lastTime ? Math.min((now - lastTime) / 1000, 0.1) : STEP;
    lastTime = now;
    acc += frameDt;
    while (acc >= STEP) {
      fixedUpdate();
      acc -= STEP;
    }
    const idle =
      !bug &&
      !creatures.some((c) => c.role === 'helper') &&
      webAlpha(now) < 0.01 &&
      wind < 0.01 &&
      creatures.every(
        (c) => (c.state.mode === 'dwell' || c.state.mode === 'sleep' || c.state.mode === 'away') && !c.state.groom && !c.state.stretch && !c.legs.some((l) => l.stepping)
      );
    if (!idle || now - lastRender > 50) {
      render();
      lastRender = now;
    }
    rafId = requestAnimationFrame(loop);
  }

  function applyPausedVisual() {
    canvas.style.opacity = paused ? '0.45' : '1';
    if (api.pausedChanged) api.pausedChanged(paused);
  }

  function pause() {
    paused = true;
    cancelAnimationFrame(rafId);
    applyPausedVisual();
    if (ctx && ctx.storage) ctx.storage.set('wcs:paused', true);
  }
  function resume() {
    paused = false;
    lastTime = 0;
    applyPausedVisual();
    if (ctx && ctx.storage) ctx.storage.set('wcs:paused', false);
    if (!suspended) rafId = requestAnimationFrame(loop);
  }
  // ---- background throttling: a window nobody is looking at does no work ----
  function wantsSuspend() {
    return !!CONFIG.background && (document.hidden || !document.hasFocus());
  }
  function suspend() {
    if (suspended) return;
    suspended = true;
    cancelAnimationFrame(rafId);
    post({ t: 'gone' });
  }
  function wakeUp() {
    if (!suspended) return;
    suspended = false;
    lastTime = 0;
    lastActivity = performance.now();
    collectNow();
    post({ t: 'hello' });
    if (!paused) rafId = requestAnimationFrame(loop);
  }
  let blurTimer = null;
  function checkVisibility() {
    clearTimeout(blurTimer);
    if (!wantsSuspend()) wakeUp();
    else if (document.hidden) suspend();
    else blurTimer = setTimeout(() => wantsSuspend() && suspend(), CONFIG.blurGraceMs);
  }
  document.addEventListener('visibilitychange', checkVisibility);
  window.addEventListener('blur', checkVisibility);
  window.addEventListener('focus', checkVisibility);

  function toggle() {
    if (paused) resume();
    else pause();
  }
  function nap() {
    napForced = true;
    napStartedAt = performance.now();
  }
  function wake() {
    napForced = false;
    lastActivity = performance.now();
  }
  function destroy() {
    cancelAnimationFrame(rafId);
    clearTimeout(blurTimer);
    document.removeEventListener('visibilitychange', checkVisibility);
    window.removeEventListener('blur', checkVisibility);
    window.removeEventListener('focus', checkVisibility);
    clearInterval(rescanInterval);
    clearInterval(helloTimer);
    post({ t: 'gone' });
    if (chan) chan.close();
    clearInterval(themeInterval);
    clearTimeout(scrollTimer);
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', resize);
    for (const [type, fn] of listen) window.removeEventListener(type, fn, { capture: true });
    canvas.remove();
    highlight.remove();
    if (window.__webCrawlerSpider === api) window.__webCrawlerSpider = undefined;
  }
  function isPaused() {
    return paused;
  }

  // _debug is for the test harness only
  const api = {
    pause,
    resume,
    toggle,
    nap,
    wake,
    spawnBug,
    spawnHelperDemo,
    spawnGuest: () => spawnGuest(null),
    chase: () => {
      if (state.mode !== 'dwell' && state.mode !== 'walk') return false;
      startChase(performance.now());
      return true;
    },
    visitNow: () => startVisit(performance.now()),
    gust,
    groom: () => {
      state.groom = 90;
    },
    stretch: () => {
      state.stretch = 80;
    },
    destroy,
    isPaused,
    isSuspended: () => suspended,
    checkVisibility,
    pausedChanged: null,
    _debug: () => ({ body, legs, state, targets, history, creatures, main, pointer, guide, bug, wind, shake, peers, attEl, run, danger, myId, web: webAlpha(performance.now()) }),
  };
  window.__webCrawlerSpider = api;

  resize();
  applyPausedVisual();
  if (wantsSuspend() && document.hidden) suspended = true;
  if (!paused && !suspended) rafId = requestAnimationFrame(loop);
  if (!document.hidden) checkVisibility();

  return api;
}

// ctx.storage only exists on the register() context, not on `host`
let pluginStorage;

// --- user settings (persisted in ctx.storage) + live instance management ---
const SETTINGS_KEY = 'wcs:settings';
const SETTING_LIMITS = {
  size: [0.6, 2.4],
  speed: [0.2, 2.5],
  bodyScale: [0.4, 1.2],
  trail: [0, 1],
  bugs: [0, 1],
  helpers: [0, 1],
  web: [0, 1],
  attention: [0, 1],
  wind: [0, 1],
  peers: [0, 1],
  chase: [0, 1],
  background: [0, 1],
  explore: [0, 1],
};
const DEFAULTS = { size: CONFIG.size, speed: CONFIG.speed, bodyScale: CONFIG.bodyScale, trail: CONFIG.trail, bugs: CONFIG.bugs, helpers: CONFIG.helpers, web: CONFIG.web, attention: CONFIG.attention, wind: CONFIG.wind, peers: CONFIG.peers, chase: CONFIG.chase, background: CONFIG.background, explore: CONFIG.explore };

let chipSetPaused = null;
let activeApi = null;

function loadSettings() {
  let saved;
  try {
    saved = pluginStorage ? pluginStorage.get(SETTINGS_KEY) : undefined;
  } catch (e) {
    saved = undefined;
  }
  if (!saved || typeof saved !== 'object') return;
  for (const key of Object.keys(SETTING_LIMITS)) {
    const v = Number(saved[key]);
    const [lo, hi] = SETTING_LIMITS[key];
    if (Number.isFinite(v)) CONFIG[key] = Math.min(hi, Math.max(lo, v));
  }
}

function saveSettings() {
  if (!pluginStorage) return;
  const out = {};
  for (const key of Object.keys(SETTING_LIMITS)) out[key] = CONFIG[key];
  pluginStorage.set(SETTINGS_KEY, out);
}

function restartSpider() {
  if (activeApi) activeApi.destroy();
  activeApi = startSpider({ storage: pluginStorage });
  activeApi.pausedChanged = chipSetPaused;
  if (chipSetPaused) chipSetPaused(activeApi.isPaused());
  return activeApi;
}

function setSetting(key, value) {
  const [lo, hi] = SETTING_LIMITS[key];
  CONFIG[key] = Math.min(hi, Math.max(lo, Math.round(value * 100) / 100));
  saveSettings();
  restartSpider();
}

function adjust(key, factor, add) {
  setSetting(key, add !== undefined ? CONFIG[key] + add : CONFIG[key] * factor);
}

/** Pretend a subagent runs for 10 s, so the helper spider can be seen without delegating real work. */
function demoHelper() {
  const id = `demo-${Date.now()}`;
  const send = (type, status) => handleGatewayEvent({ type, payload: { subagent_id: id, goal: 'demo', status } });
  send('subagent.start', 'running');
  const tick = setInterval(() => send('subagent.progress', 'running'), 2000);
  setTimeout(() => {
    clearInterval(tick);
    send('subagent.complete', 'completed');
  }, 10000);
}

/** Fake a 9 s agent run so the work web can be watched growing. */
function demoWeb() {
  handleGatewayEvent({ type: 'message.start', payload: {} });
  let n = 0;
  const timer = setInterval(() => {
    handleGatewayEvent({ type: 'tool.start', payload: { name: 'demo' } });
    if (++n >= 12) {
      clearInterval(timer);
      handleGatewayEvent({ type: 'message.complete', payload: { status: 'complete' } });
    }
  }, 700);
}

/** Fake an approval request for a destructive command: spider-sense, then the walk to the Run button. */
function demoSense() {
  handleGatewayEvent({ type: 'approval.request', payload: { command: 'rm -rf ./demo', description: 'demo' } });
  setTimeout(() => handleGatewayEvent({ type: 'approval.received', payload: {} }), 9000);
}

function resetSettings() {
  Object.assign(CONFIG, DEFAULTS);
  saveSettings();
  restartSpider();
}

// --- settings panel: opens from the status-bar chip; plain DOM, tagged data-wcs so the spider ignores it ---
const PANEL_SLIDERS = [
  ['size', 'Size', 0.05],
  ['speed', 'Speed', 0.05],
  ['bodyScale', 'Body', 0.05],
];
const PANEL_TOGGLES = [
  ['trail', 'Silk guide line to its next stop'],
  ['bugs', 'Flies to hunt'],
  ['helpers', 'Helper spiders for subagents'],
  ['web', 'Work web (grows with tool calls)'],
  ['explore', 'Explore the app: walk to its buttons and links (reads the page)'],
  ['attention', 'Spider-sense for risky commands (walks to Run if Explore is on)'],
  ['wind', 'Wind and shaking'],
  ['peers', 'Visit other Hermes windows'],
  ['chase', 'Chase the mouse cursor now and then'],
  ['background', 'Freeze while the window is in the background'],
];
const HINT_KEY = 'wcs:hint-seen';
let panelEl = null;
let hintEl = null;
let hintTimer = null;

function popStyle(el, anchor, width) {
  const r = anchor.getBoundingClientRect();
  el.style.cssText = [
    'position:fixed',
    `right:${Math.max(8, Math.round(window.innerWidth - r.right))}px`,
    `bottom:${Math.max(8, Math.round(window.innerHeight - r.top + 8))}px`,
    `width:${width}px`,
    `z-index:${CONFIG.zIndex + 1}`,
    'padding:12px 14px',
    'border-radius:10px',
    'font:12.5px/1.4 system-ui,sans-serif',
    'color:var(--foreground,#e6e8f5)',
    'background:var(--background,#14172b)',
    'border:1px solid color-mix(in srgb,var(--foreground,#888) 22%,transparent)',
    'box-shadow:0 8px 28px rgba(0,0,0,.35)',
    'pointer-events:auto',
  ].join(';');
}

function el(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const kid of kids) node.append(kid);
  return node;
}

function closePanel() {
  if (panelEl) panelEl.remove();
  panelEl = null;
  document.removeEventListener('pointerdown', onPanelOutside, true);
  document.removeEventListener('keydown', onPanelKey, true);
}
function onPanelOutside(e) {
  if (panelEl && !panelEl.contains(e.target) && !(e.target.closest && e.target.closest('[data-wcs="chip"]'))) closePanel();
}
function onPanelKey(e) {
  if (e.key === 'Escape') closePanel();
}

function closeHint() {
  clearTimeout(hintTimer);
  if (hintEl) hintEl.remove();
  hintEl = null;
}

/** One-time bubble over the chip: where the settings are and how to find the commands. */
function showHint(anchor) {
  try {
    if (!anchor || (pluginStorage && pluginStorage.get(HINT_KEY))) return false;
    if (pluginStorage) pluginStorage.set(HINT_KEY, true);
  } catch (e) {
    return false;
  }
  closeHint();
  hintEl = el('div', { 'data-wcs': 'hint', role: 'status', onclick: closeHint });
  popStyle(hintEl, anchor, 250);
  hintEl.style.cursor = 'pointer';
  hintEl.append(
    el('b', {}, 'Web Crawler Spider is here 🕷️'),
    el('div', { style: 'margin-top:4px;opacity:.8' }, 'Click the spider icon for its settings, or press Ctrl+K and type "Spider" for commands and demos.')
  );
  document.body.append(hintEl);
  hintTimer = setTimeout(closeHint, 12000);
  return true;
}

function togglePanel(anchor) {
  if (panelEl) {
    closePanel();
    return false;
  }
  closeHint();
  const row = (style) => `display:flex;align-items:center;gap:8px;${style || ''}`;
  panelEl = el('div', { 'data-wcs': 'panel', role: 'dialog', 'aria-label': 'Web Crawler Spider settings' });
  popStyle(panelEl, anchor, 288);

  const paused = !!(activeApi && activeApi.isPaused());
  const header = el('div', { style: row('justify-content:space-between;margin-bottom:8px') }, el('b', {}, '🕷️ Web Crawler Spider'), el('span', { style: 'opacity:.55' }, VERSION));
  panelEl.append(header);

  const pauseBtn = el('button', { 'data-act': 'pause', style: btnStyle(), onclick: () => { if (activeApi) activeApi.toggle(); pauseBtn.textContent = activeApi && activeApi.isPaused() ? 'Resume' : 'Pause'; } }, paused ? 'Resume' : 'Pause');
  const actions = el(
    'div',
    { style: row('flex-wrap:wrap;margin-bottom:10px') },
    pauseBtn,
    el('button', { 'data-act': 'fly', style: btnStyle(), onclick: () => activeApi && activeApi.spawnBug() }, 'Release a fly'),
    el('button', { 'data-act': 'nap', style: btnStyle(), onclick: () => { closePanel(); if (activeApi) activeApi.nap(); } }, 'Nap'),
    el('button', { 'data-act': 'reset', style: btnStyle(), onclick: () => { resetSettings(); closePanel(); } }, 'Reset')
  );
  panelEl.append(actions);

  for (const [key, label, step] of PANEL_SLIDERS) {
    const [lo, hi] = SETTING_LIMITS[key];
    const out = el('span', { style: 'width:34px;text-align:right;opacity:.7' }, String(CONFIG[key]));
    const input = el('input', { type: 'range', 'data-key': key, min: String(lo), max: String(hi), step: String(step), style: 'flex:1', value: String(CONFIG[key]) });
    input.addEventListener('input', () => { out.textContent = String(Math.round(Number(input.value) * 100) / 100); });
    input.addEventListener('change', () => setSetting(key, Number(input.value))); // on release: a change restarts the spider
    panelEl.append(el('label', { style: row('margin:4px 0') }, el('span', { style: 'width:44px' }, label), input, out));
  }
  const list = el('div', { style: 'margin-top:8px;display:flex;flex-direction:column;gap:5px' });
  for (const [key, label] of PANEL_TOGGLES) {
    const box = el('input', { type: 'checkbox', 'data-key': key });
    box.checked = !!CONFIG[key];
    box.addEventListener('change', () => setSetting(key, box.checked ? 1 : 0));
    list.append(el('label', { style: row('cursor:pointer') }, box, el('span', {}, label)));
  }
  panelEl.append(list, el('div', { style: 'margin-top:10px;opacity:.5;font-size:11.5px' }, 'Ctrl+K → "Spider" for demos (fly, work web, spider-sense, visitor).'));

  document.body.append(panelEl);
  document.addEventListener('pointerdown', onPanelOutside, true);
  document.addEventListener('keydown', onPanelKey, true);
  return true;
}

function btnStyle() {
  return 'padding:3px 9px;border-radius:6px;cursor:pointer;font:inherit;color:inherit;background:color-mix(in srgb,var(--foreground,#888) 10%,transparent);border:1px solid color-mix(in srgb,var(--foreground,#888) 22%,transparent)';
}

function SpiderChip() {
  const [paused, setPaused] = useState(true);

  useEffect(() => {
    chipSetPaused = setPaused;
    restartSpider();
    const hintTimerId = setTimeout(() => showHint(document.querySelector('[data-wcs="chip"]')), 2500);
    return () => {
      clearTimeout(hintTimerId);
      closePanel();
      closeHint();
      if (activeApi) activeApi.destroy();
      activeApi = null;
      chipSetPaused = null;
    };
  }, []);

  return jsx('button', {
    'data-wcs': 'chip',
    onClick: (e) => togglePanel(e.currentTarget),
    title: `Web Crawler Spider settings — ${VERSION}`,
    style: {
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      fontSize: '13px',
      opacity: paused ? 0.45 : 1,
      padding: '0 4px',
    },
    children: '\uD83D\uDD77\uFE0F',
  });
}

function paletteCommand(id, label, keywords, run) {
  return {
    id: `web-crawler-spider-${id}`,
    area: PALETTE_AREA,
    data: { id: `web-crawler-spider.${id}`, label: `Spider: ${label}`, keywords: ['spider', 'crawler', ...keywords], run },
  };
}

const WebCrawlerSpiderPlugin = {
  id: 'web-crawler-spider',
  name: 'Web Crawler Spider',
  defaultEnabled: true,
  register(ctx) {
    pluginStorage = ctx.storage;
    loadSettings();
    // agent mood: listen for gateway events for as long as the plugin is registered
    ctx.onEvent('*', handleGatewayEvent);
    // registerMany, not register: register() takes ONE contribution and silently mis-registers an array
    ctx.registerMany([
      {
        id: 'web-crawler-spider-chip',
        area: 'statusBar.right',
        render: () => jsx(SpiderChip, {}),
      },
      paletteCommand('toggle', 'Pause / resume', ['toggle', 'pause'], () => activeApi && activeApi.toggle()),
      paletteCommand('bigger', 'Bigger', ['size', 'larger'], () => adjust('size', 1.15)),
      paletteCommand('smaller', 'Smaller', ['size'], () => adjust('size', 1 / 1.15)),
      paletteCommand('faster', 'Faster', ['speed'], () => adjust('speed', 1.25)),
      paletteCommand('slower', 'Slower', ['speed'], () => adjust('speed', 0.8)),
      paletteCommand('body-bigger', 'Bigger body', ['body'], () => adjust('bodyScale', 1, 0.1)),
      paletteCommand('body-smaller', 'Smaller body', ['body'], () => adjust('bodyScale', 1, -0.1)),
      paletteCommand('trail', 'Silk guide line on / off', ['thread', 'web', 'trail', 'line'], () => adjust('trail', 1, CONFIG.trail ? -1 : 1)),
      paletteCommand('bugs', 'Flies on / off', ['bug', 'hunt', 'fly'], () => adjust('bugs', 1, CONFIG.bugs ? -1 : 1)),
      paletteCommand('bug-now', 'Release a fly', ['bug', 'hunt', 'fly'], () => activeApi && activeApi.spawnBug()),
      paletteCommand('helpers', 'Helper spiders on / off', ['subagent', 'helper', 'agent'], () => adjust('helpers', 1, CONFIG.helpers ? -1 : 1)),
      paletteCommand('helper-demo', 'Show a helper spider (10 s demo)', ['subagent', 'helper', 'demo'], demoHelper),
      paletteCommand('web', 'Work web on / off', ['progress', 'tool', 'web'], () => adjust('web', 1, CONFIG.web ? -1 : 1)),
      paletteCommand('web-demo', 'Show the work web (9 s demo)', ['progress', 'web', 'demo'], demoWeb),
      paletteCommand('attention', 'Attention + spider-sense on / off', ['approval', 'danger', 'attention'], () => adjust('attention', 1, CONFIG.attention ? -1 : 1)),
      paletteCommand('sense-demo', 'Test spider-sense (fake risky command)', ['danger', 'approval', 'demo'], demoSense),
      paletteCommand('wind', 'Wind on / off', ['sway', 'scroll', 'wind'], () => adjust('wind', 1, CONFIG.wind ? -1 : 1)),
      paletteCommand('peers', 'Visiting between windows on / off', ['window', 'visit', 'friend'], () => adjust('peers', 1, CONFIG.peers ? -1 : 1)),
      paletteCommand('guest-demo', 'Show a visiting spider (demo)', ['window', 'visit', 'friend', 'demo'], () => activeApi && activeApi.spawnGuest()),
      paletteCommand('visit', 'Send my spider to visit another window', ['window', 'visit', 'friend'], () => activeApi && activeApi.visitNow()),
      paletteCommand('chase', 'Cursor chase on / off', ['mouse', 'pointer', 'chase'], () => adjust('chase', 1, CONFIG.chase ? -1 : 1)),
      paletteCommand('explore', 'Explore the app (walk to buttons) on / off', ['explore', 'walk', 'buttons', 'dom', 'page'], () => adjust('explore', 1, CONFIG.explore ? -1 : 1)),
      paletteCommand('background', 'Freeze in the background on / off', ['background', 'idle', 'cpu', 'battery', 'focus'], () => adjust('background', 1, CONFIG.background ? -1 : 1)),
      paletteCommand('chase-now', 'Chase my cursor now', ['mouse', 'pointer', 'chase'], () => activeApi && activeApi.chase()),
      paletteCommand('nap', 'Take a nap', ['sleep', 'rest'], () => activeApi && activeApi.nap()),
      paletteCommand('wake', 'Wake up', ['sleep'], () => activeApi && activeApi.wake()),
      paletteCommand('reset', 'Reset size, speed and extras', ['default', 'settings'], resetSettings),
    ]);
  },
};

export default WebCrawlerSpiderPlugin;
