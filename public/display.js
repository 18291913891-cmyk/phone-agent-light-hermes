const screenNode = document.getElementById('screen');
const connectionNode = document.getElementById('displayConnection');
const modelNode = document.getElementById('displayModel');
const timeNode = document.getElementById('displayTime');
const dateNode = document.getElementById('displayDate');
const toneNode = document.getElementById('displayTone');
const statusNode = document.getElementById('displayStatus');
const detailNode = document.getElementById('displayDetail');
const flowFillNode = document.getElementById('flowFill');
const skinToggleNode = document.getElementById('skinToggle');
const steps = {
  IDLE: document.getElementById('stepIdle'),
  THINKING: document.getElementById('stepThinking'),
  RUNNING: document.getElementById('stepRunning'),
  DONE: document.getElementById('stepDone')
};

const POLL_INTERVAL_MS = 900;
const COMPLETE_HOLD_MS = 30 * 1000;
const COMPLETE_SETTLE_MS = 8 * 1000;
const ACTIVE_FRESH_MS = 4500;

const ORDER = { IDLE: 0, THINKING: 1, RUNNING: 2, DONE: 3, ERROR: 3, SETTLING: 3 };
const PROGRESS = { IDLE: '0%', THINKING: '33.333%', RUNNING: '66.666%', DONE: '100%', ERROR: '100%', SETTLING: '100%' };
const VIEW = {
  IDLE: { tone: '摸鱼中', status: '待机摸鱼', detail: '等你发话。' },
  THINKING: { tone: '想一想', status: '努力思考中', detail: '正在整理思路。' },
  RUNNING: { tone: '开工啦', status: '拼命干活中', detail: '工具正在执行。' },
  DONE: { tone: '搞定', status: '终于完成了', detail: '这一轮处理完了。' },
  ERROR: { tone: '翻车', status: '出错了', detail: '有东西没跑通。' },
  SETTLING: { tone: '收工', status: '准备摸鱼', detail: '收拾一下，马上回待机。' }
};
const SKINS = [
  { id: 'classic', label: '机器人' },
  { id: 'mint', label: '幽灵' },
  { id: 'pink', label: '小 i' },
  { id: 'space', label: '太空人' },
  { id: 'cat', label: '猫猫' }
];
const SKIN_STORAGE_KEY = 'phone-agent-light-skin';

let eventSource = null;
let polling = false;
let phase = 'IDLE';
let terminalAt = 0;
let terminalLockedUntil = 0;
let settlingAt = 0;
let lastActiveAt = 0;
let consumedTerminalKey = '';
let turnStartedAt = 0;

function applySkin(id) {
  const skin = SKINS.find((item) => item.id === id) || SKINS[0];
  screenNode.dataset.skin = skin.id;
  if (skinToggleNode) skinToggleNode.textContent = skin.label;
  try { window.localStorage.setItem(SKIN_STORAGE_KEY, skin.id); } catch (error) {}
}

function initSkinToggle() {
  let saved = SKINS[0].id;
  try { saved = window.localStorage.getItem(SKIN_STORAGE_KEY) || saved; } catch (error) {}
  applySkin(saved);
  if (!skinToggleNode) return;
  skinToggleNode.addEventListener('click', () => {
    const current = screenNode.dataset.skin || SKINS[0].id;
    const index = SKINS.findIndex((item) => item.id === current);
    const next = SKINS[(index + 1 + SKINS.length) % SKINS.length];
    applySkin(next.id);
  });
}

function renderClock() {
  const now = new Date();
  timeNode.textContent = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(now);
  timeNode.setAttribute('datetime', now.toISOString());
  dateNode.textContent = new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'short'
  }).format(now);
}

function stateAgeMs(state) {
  const ts = Date.parse(state.updatedAt || state.updated_at || state.timestamp || '');
  if (!Number.isFinite(ts)) return Infinity;
  return Date.now() - ts;
}

function isFreshState(state) {
  return stateAgeMs(state) <= ACTIVE_FRESH_MS;
}

function isFreshActive(state) {
  return state.task?.active === true && isFreshState(state);
}

function isFinalSource(source) {
  return source.includes('post_turn') || source.includes('settled') || source.includes('final');
}

function isFreshTurnStart(state) {
  const source = String(state.runtime?.source || '').toLowerCase();
  return isFreshState(state) && (source.includes('gateway/inbound') || source.includes('pre_turn'));
}

function terminalKey(state) {
  const status = String(state.status || '').toUpperCase();
  const source = String(state.runtime?.source || '').toLowerCase();
  return [status, source, state.updatedAt || state.updated_at || state.timestamp || ''].join('|');
}

function normalizePhase(state) {
  const status = String(state.status || '').toUpperCase();
  const source = String(state.runtime?.source || '').toLowerCase();
  const detail = String(state.detail || '').toLowerCase();
  const active = isFreshActive(state);
  const fresh = isFreshState(state);

  const finalSource = isFinalSource(source);

  // Final snapshots are allowed only while fresh, or while the current page is
  // already holding a terminal state. This prevents old DONE/ERROR snapshots from
  // replaying after browser refreshes.
  if (finalSource) {
    if (!fresh && phase === 'IDLE') return 'IDLE';
    if (status.includes('ERROR') || source.includes('error') || detail.includes('traceback')) return 'ERROR';
    if (status.includes('DONE') || status.includes('COMPLETE')) return 'DONE';
  }

  // Old active snapshots must not restart work after a browser refresh. During an
  // already-started turn we keep the locked phase, but from IDLE stale non-final
  // hook/log snapshots are ignored.
  if (!fresh && phase === 'IDLE') return 'IDLE';

  if (source.includes('pre_tool') || source.includes('post_tool') || source.includes('tool_call') || detail.includes('tool') || status.includes('ERROR')) return 'RUNNING';
  if (source.includes('llm') || source.includes('api_request') || source.includes('pre_turn') || source.includes('gateway/inbound') || status.includes('THINK') || status.includes('WRITING')) return 'THINKING';
  if (status.includes('RUNNING')) return 'RUNNING';
  if (active) return phase === 'IDLE' ? 'THINKING' : phase;
  return phase === 'THINKING' || phase === 'RUNNING' ? phase : 'IDLE';
}

function reducePhase(raw, active, state) {
  const now = Date.now();

  if (active) lastActiveAt = now;

  // Terminal and settling phases are local-only. Once a real final state is
  // displayed, backend noise cannot pull the screen back into THINKING/RUNNING.
  if (phase === 'DONE' || phase === 'ERROR') {
    if (isFreshTurnStart(state)) return 'THINKING';
    if (now >= terminalLockedUntil) return 'SETTLING';
    return phase;
  }

  if (phase === 'SETTLING') {
    if (isFreshTurnStart(state)) return 'THINKING';
    if (now - settlingAt >= COMPLETE_SETTLE_MS) return 'IDLE';
    return 'SETTLING';
  }

  // Start a locked turn on the first thinking/running signal.
  if (phase === 'IDLE' && (raw === 'THINKING' || raw === 'RUNNING')) {
    turnStartedAt = now;
    return raw;
  }

  const inTurn = phase === 'THINKING' || phase === 'RUNNING';

  if (inTurn) {
    if (raw === 'ERROR' || raw === 'DONE') return raw;
    if (phase === 'THINKING' && raw === 'RUNNING') return 'RUNNING';
    // Hard rule: once work starts, never return to idle before a final post_turn.
    return phase;
  }

  return raw;
}

function setPhase(next) {
  const now = Date.now();
  if (next !== phase && (next === 'DONE' || next === 'ERROR')) {
    terminalAt = now;
    terminalLockedUntil = now + COMPLETE_HOLD_MS;
    settlingAt = 0;
    turnStartedAt = 0;
  }
  if (next !== phase && next === 'SETTLING') {
    settlingAt = now;
    turnStartedAt = 0;
  }
  if (next === 'IDLE') {
    turnStartedAt = 0;
    terminalAt = 0;
    terminalLockedUntil = 0;
    settlingAt = 0;
  }
  phase = next;
}

function renderFlow(current) {
  const visual = current === 'ERROR' || current === 'SETTLING' ? 'DONE' : current;
  flowFillNode.style.width = PROGRESS[current] || '0%';
  Object.entries(steps).forEach(([key, node]) => {
    if (!node) return;
    node.classList.toggle('active', key === visual);
    node.classList.toggle('done', ORDER[key] < ORDER[visual]);
  });
  if (steps.DONE) steps.DONE.textContent = current === 'ERROR' ? '出错' : '完成';
}

function render(state) {
  const active = isFreshActive(state);
  if (active) consumedTerminalKey = '';

  let raw = normalizePhase(state);
  const key = terminalKey(state);
  if (!active && phase === 'IDLE' && (raw === 'DONE' || raw === 'ERROR') && key === consumedTerminalKey) {
    raw = 'IDLE';
  }

  const next = reducePhase(raw, active, state);
  if ((phase === 'DONE' || phase === 'ERROR' || phase === 'SETTLING') && next === 'IDLE') {
    consumedTerminalKey = terminalKey(state);
  }
  setPhase(next);
  const view = VIEW[phase] || VIEW.IDLE;

  screenNode.dataset.phase = phase;
  connectionNode.textContent = 'LIVE';
  modelNode.textContent = state.runtime?.model || state.runtime?.provider || 'HERMES';
  toneNode.textContent = view.tone;
  statusNode.textContent = view.status;
  detailNode.textContent = view.detail;
  renderClock();
  renderFlow(phase);
}

function showOffline() {
  screenNode.dataset.phase = 'OFFLINE';
  connectionNode.textContent = 'RETRY';
  modelNode.textContent = 'OFFLINE';
  toneNode.textContent = '断线';
  statusNode.textContent = '连接断了';
  detailNode.textContent = '等状态桥恢复。';
  renderClock();
}

function requestState() {
  if (polling) return;
  polling = true;
  fetch('/api/state?_ts=' + Date.now(), { cache: 'no-store' })
    .then((response) => {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    })
    .then(render)
    .catch(showOffline)
    .finally(() => { polling = false; });
}

function connectEvents() {
  if (typeof EventSource !== 'function') return;
  if (eventSource) {
    try { eventSource.close(); } catch (error) {}
  }
  eventSource = new EventSource('/api/events');
  eventSource.onmessage = (event) => {
    try {
      render(JSON.parse(event.data));
    } catch (error) {
      requestState();
    }
  };
  eventSource.onerror = () => {
    connectionNode.textContent = 'SYNC';
    requestState();
  };
}

initSkinToggle();
renderClock();
requestState();
connectEvents();
window.setInterval(renderClock, 1000);
window.setInterval(requestState, POLL_INTERVAL_MS);
window.addEventListener('focus', requestState);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    renderClock();
    requestState();
    connectEvents();
  }
});
