import { PALETTE_AREA } from '@hermes/plugin-sdk';
import { useRef, useEffect, useState } from 'react';
import { jsx } from 'react/jsx-runtime';

/**
 * Web Crawler Spider — an 8-legged spider that lives on the Hermes window and
 * reacts to what the agent is doing (work web, helper spiders, approval mood,
 * spider-sense). By default it roams only its own overlay; the opt-in Explore
 * mode also walks between real interactive elements with 2-bone IK. It never
 * mutates the page beyond the two overlay nodes it owns (data-wcs).
 *
 * THIS FILE IS BUILT from src/*.js by scripts/build.mjs. Edit the files in src/.
 *
 * IK/gait approach adapted from the MIT-licensed felixyu9722/WebCrawlerMY,
 * whose README credits @rybinfx for the original "Web Crawlers" concept.
 */

const VERSION = '1.4.0';

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
  background: 1, // 1 = freeze (no timers, no frames) while the window is hidden, minimised or unfocused; also rests when the machine is overloaded
  maxFrameDt: 0.25, // longest stretch of time one frame may simulate (s); slower frames than this run in slow motion
  overloadGapMs: 600, // frames this far apart on average count as an overloaded machine...
  overloadForMs: 8000, // ...once that has lasted this long the spider rests
  overloadRetryMs: 45000, // and tries again after this long
  cheer: 1, // 1 = a little victory dance when a long run finishes well
  cheerAfterMs: 45000, // a run must last this long to deserve a dance
  skin: 0, // colour: 0 = follow the theme, 1-5 = a fixed colour (see SKINS)
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


