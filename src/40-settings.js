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
  skin: [0, SKINS.length - 1],
};
const DEFAULTS = { size: CONFIG.size, speed: CONFIG.speed, bodyScale: CONFIG.bodyScale, trail: CONFIG.trail, bugs: CONFIG.bugs, helpers: CONFIG.helpers, web: CONFIG.web, attention: CONFIG.attention, wind: CONFIG.wind, peers: CONFIG.peers, chase: CONFIG.chase, background: CONFIG.background, explore: CONFIG.explore, skin: CONFIG.skin };

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

/** Everything at once, for a first look: a fly, a work web, a helper, a risky command and a visitor. */
function demoAll() {
  if (activeApi) activeApi.spawnBug();
  demoWeb();
  demoHelper();
  setTimeout(demoSense, 3000);
  setTimeout(() => activeApi && activeApi.spawnGuest(), 6000);
}

function resetSettings() {
  Object.assign(CONFIG, DEFAULTS);
  saveSettings();
  restartSpider();
}

