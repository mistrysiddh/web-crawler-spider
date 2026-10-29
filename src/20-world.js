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

const SKINS = [
  { name: 'Theme', color: null },
  { name: 'Ember', color: '#ff9f1c' },
  { name: 'Moss', color: '#7bd88f' },
  { name: 'Ice', color: '#7fd4ff' },
  { name: 'Violet', color: '#c792ea' },
  { name: 'Rose', color: '#ff6b9d' },
];

function resolveThemeColor(forced) {
  if (forced) return forced;
  const skin = SKINS[Math.round(CONFIG.skin)];
  if (skin && skin.color) return skin.color;
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

