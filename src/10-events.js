// --- agent mood: gateway events -> spider colour / pace. Module-level so it keeps
// listening across spider restarts; the spider only reads moodNow().
const MOOD_COLORS = { waiting: '#ffb020', error: '#ff4d4d', done: '#3ddc84' };
const mood = { workUntil: 0, errorUntil: 0, doneUntil: 0, waiting: false };

// --- subagents: one entry per running subagent; the spider turns them into helper spiders ---
const SUBAGENT_DONE = new Set(['completed', 'failed', 'interrupted', 'timeout', 'error', 'cancelled', 'canceled']);
const helperReg = new Map(); // id -> { id, done, ok, seen, pulse, born }

function handleSubagentEvent(t, payload, now) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const id = String(p.subagent_id || p.child_session_id || `${p.parent_id || 'root'}:${p.task_index == null ? 0 : p.task_index}:${p.goal || ''}`);
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
const run = { active: false, strands: 0, result: null, resultAt: 0, seen: 0, startedAt: 0, cheer: false };
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
    run.startedAt = now;
  } else if (t === 'tool.start') {
    if (!run.active) {
      run.active = true;
      run.strands = 0;
      run.result = null;
      run.startedAt = now;
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
    if (run.result === 'done' && CONFIG.cheer && run.startedAt && now - run.startedAt > CONFIG.cheerAfterMs) run.cheer = true;
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
      const label = (el.textContent || '').replace(/[^\p{L}\s]/gu, '').trim(); // the real button reads "Run \u21b5"
      if (!/^(run|approve|allow|allow once|accept|yes|continue)$/i.test(label) && !/approval needed/i.test(el.getAttribute('aria-label') || '')) continue;
    }
    found.push(el);
  }
  return found.length ? found[found.length - 1] : null; // the newest one is lowest in the chat
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

