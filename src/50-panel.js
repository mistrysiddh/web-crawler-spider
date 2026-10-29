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
    `max-height:${Math.max(160, Math.round(r.top - 24))}px`, // a short window scrolls the panel instead of cutting it off
    'overflow-y:auto',
    'box-sizing:border-box',
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
    el('b', {}, 'Web Crawler Spider is here'),
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
  const header = el('div', { style: row('justify-content:space-between;margin-bottom:8px') }, el('b', {}, 'Web Crawler Spider'), el('span', { style: 'opacity:.55' }, VERSION));
  panelEl.append(header);

  const pauseBtn = el('button', { 'data-act': 'pause', style: btnStyle(), onclick: () => { if (activeApi) activeApi.toggle(); pauseBtn.textContent = activeApi && activeApi.isPaused() ? 'Resume' : 'Pause'; } }, paused ? 'Resume' : 'Pause');
  const actions = el(
    'div',
    { style: row('flex-wrap:wrap;margin-bottom:10px') },
    pauseBtn,
    el('button', { 'data-act': 'fly', style: btnStyle(), onclick: () => activeApi && activeApi.spawnBug() }, 'Release a fly'),
    el('button', { 'data-act': 'demo', style: btnStyle(), onclick: () => { closePanel(); demoAll(); } }, 'Demo all'),
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
  const swatches = el('div', { style: row('margin:6px 0 2px') }, el('span', { style: 'width:44px' }, 'Colour'));
  SKINS.forEach((skin, i) => {
    const on = Math.round(CONFIG.skin) === i;
    const dot = el('button', {
      'data-skin': String(i),
      title: skin.name,
      'aria-label': `Colour: ${skin.name}`,
      style: `width:20px;height:20px;border-radius:50%;cursor:pointer;padding:0;background:${skin.color || 'conic-gradient(#7fd4ff,#c792ea,#ff6b9d,#ff9f1c,#7bd88f,#7fd4ff)'};border:2px solid ${on ? 'var(--foreground,#fff)' : 'transparent'}`,
      onclick: () => setSetting('skin', i),
    });
    swatches.append(dot);
  });
  panelEl.append(swatches);
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

