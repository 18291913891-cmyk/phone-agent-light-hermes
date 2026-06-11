const fs = require('fs');
const os = require('os');
const path = require('path');

const fsp = fs.promises;

const DEFAULT_TOKEN_BY_STATUS = {
  IDLE: 100,
  THINKING: 74,
  WRITING: 82,
  RUNNING: 61,
  DONE: 96,
  ERROR: 18,
  NEED_CONFIRM: 45
};

const ACTIVE_STATUSES = {
  THINKING: true,
  WRITING: true,
  RUNNING: true,
  NEED_CONFIRM: true
};

const DEFAULT_ESTIMATE_BY_SOURCE = {
  default: {
    THINKING: 180,
    WRITING: 45,
    RUNNING: 120,
    NEED_CONFIRM: 90
  },
  manual: {
    THINKING: 150,
    WRITING: 35,
    RUNNING: 90,
    NEED_CONFIRM: 90
  },
  'hermes-local': {
    THINKING: 180,
    WRITING: 40,
    RUNNING: 120,
    NEED_CONFIRM: 90
  },
  'codex-latest': {
    THINKING: 240,
    WRITING: 60,
    RUNNING: 180,
    NEED_CONFIRM: 120
  }
};

const BINDINGS = [
  {
    id: 'manual',
    label: '手动 / 内置对话',
    source: 'Node server memory',
    interactive: true,
    kind: 'manual'
  },
  {
    id: 'hermes-local',
    label: 'Hermes 本机实例',
    source: '~/.hermes/logs + gateway_state.json',
    interactive: false,
    kind: 'adapter',
    envFlag: 'ENABLE_HERMES_BINDING'
  },
  {
    id: 'codex-latest',
    label: 'Codex Desktop 最近会话',
    source: '~/.codex/sessions/*.jsonl',
    interactive: false,
    kind: 'adapter',
    envFlag: 'ENABLE_CODEX_BINDING'
  }
];

function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function getEnabledBindings(env) {
  const source = env || process.env;

  return BINDINGS.filter((binding) => !binding.envFlag || isTruthyEnv(source[binding.envFlag]));
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeStatus(status) {
  const value = String(status || 'IDLE').toUpperCase();
  return DEFAULT_TOKEN_BY_STATUS[value] ? value : 'IDLE';
}

function isActiveStatus(status) {
  return !!ACTIVE_STATUSES[normalizeStatus(status)];
}

function normalizeEstimateSec(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.round(numeric);
}

function getDefaultEstimateSec(sourceId, status) {
  const normalized = normalizeStatus(status);
  const sourceTable = DEFAULT_ESTIMATE_BY_SOURCE[sourceId] || DEFAULT_ESTIMATE_BY_SOURCE.default;
  return sourceTable[normalized] || DEFAULT_ESTIMATE_BY_SOURCE.default[normalized] || null;
}

function safeDateMs(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function buildTask(task, status, updatedAt, sourceId) {
  const normalizedStatus = normalizeStatus(status);
  const active = task && typeof task.active === 'boolean'
    ? task.active
    : isActiveStatus(normalizedStatus);
  const startedAt = task && task.startedAt
    ? task.startedAt
    : active
    ? updatedAt
    : null;
  const endedAt = task && task.endedAt
    ? task.endedAt
    : !active && startedAt
    ? updatedAt
    : null;
  const estimatedDurationSec = normalizeEstimateSec(task && task.estimatedDurationSec)
    || getDefaultEstimateSec(sourceId, normalizedStatus);
  const startMs = safeDateMs(startedAt);
  const endMs = active ? Date.now() : safeDateMs(endedAt || updatedAt);
  const elapsedSec = startMs && endMs && endMs >= startMs
    ? Math.max(0, Math.round((endMs - startMs) / 1000))
    : 0;

  if (!startedAt && !estimatedDurationSec && !elapsedSec) {
    return null;
  }

  return {
    active,
    startedAt: startedAt || null,
    endedAt: endedAt || null,
    estimatedDurationSec: estimatedDurationSec || null,
    elapsedSec,
    label: task && task.label ? String(task.label) : normalizedStatus
  };
}

function buildBurstTask(events, latestIndex, status, sourceId, options) {
  if (!Array.isArray(events) || latestIndex < 0 || !events[latestIndex]) {
    return null;
  }

  const maxGapMs = options && options.maxGapMs ? options.maxGapMs : 60 * 1000;
  const maxSpanMs = options && options.maxSpanMs ? options.maxSpanMs : 15 * 60 * 1000;
  const latestEntry = events[latestIndex];
  const latestMs = safeDateMs(latestEntry.updatedAt);
  let startAt = latestEntry.updatedAt;

  if (!latestMs) {
    return {
      startedAt: latestEntry.updatedAt,
      endedAt: isActiveStatus(status) ? null : latestEntry.updatedAt,
      estimatedDurationSec: getDefaultEstimateSec(sourceId, status),
      label: status
    };
  }

  for (let index = latestIndex - 1; index >= 0; index -= 1) {
    const currentEntry = events[index];
    const currentMs = safeDateMs(currentEntry.updatedAt);
    const nextMs = safeDateMs(events[index + 1].updatedAt);

    if (!currentMs || !nextMs) {
      break;
    }

    if (events[index].status === 'IDLE' || events[index].status === 'DONE' || events[index].status === 'ERROR') {
      break;
    }

    if (nextMs - currentMs > maxGapMs) {
      break;
    }

    if (latestMs - currentMs > maxSpanMs) {
      break;
    }

    startAt = currentEntry.updatedAt;
  }

  return {
    startedAt: startAt,
    endedAt: isActiveStatus(status) ? null : latestEntry.updatedAt,
    estimatedDurationSec: getDefaultEstimateSec(sourceId, status),
    label: status
  };
}

function withDefaults(snapshot, fallbackStatus, sourceId) {
  const status = normalizeStatus(snapshot && snapshot.status ? snapshot.status : fallbackStatus);
  const tokenPercent = Number.isFinite(Number(snapshot && snapshot.tokenPercent))
    ? Math.max(0, Math.min(100, Math.round(Number(snapshot.tokenPercent))))
    : DEFAULT_TOKEN_BY_STATUS[status];
  const updatedAt = snapshot && snapshot.updatedAt ? snapshot.updatedAt : nowIso();

  return {
    status,
    tokenPercent,
    detail: snapshot && snapshot.detail ? String(snapshot.detail) : '',
    updatedAt,
    task: buildTask(snapshot && snapshot.task, status, updatedAt, sourceId || 'default'),
    runtime: snapshot && snapshot.runtime ? {
      model: snapshot.runtime.model ? String(snapshot.runtime.model) : '',
      provider: snapshot.runtime.provider ? String(snapshot.runtime.provider) : '',
      source: snapshot.runtime.source ? String(snapshot.runtime.source) : String(sourceId || 'default')
    } : null
  };
}

function extractRuntimeFromHermesLine(line) {
  const modelMatch = String(line || '').match(/\bmodel=([^\s]+)/i);
  const providerMatch = String(line || '').match(/\bprovider=([^\s]+)/i);

  if (!modelMatch && !providerMatch) {
    return null;
  }

  return {
    model: modelMatch ? modelMatch[1] : '',
    provider: providerMatch ? providerMatch[1] : '',
    source: 'hermes-local'
  };
}

async function fileExists(targetPath) {
  try {
    await fsp.access(targetPath, fs.constants.F_OK);
    return true;
  } catch (error) {
    return false;
  }
}

async function readJsonFile(targetPath) {
  try {
    const raw = await fsp.readFile(targetPath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

async function readTail(targetPath, maxBytes) {
  let handle;

  try {
    const stat = await fsp.stat(targetPath);
    const length = Math.min(maxBytes, stat.size);
    const buffer = Buffer.alloc(length);
    handle = await fsp.open(targetPath, 'r');
    await handle.read(buffer, 0, length, stat.size - length);
    return buffer.toString('utf8');
  } catch (error) {
    return '';
  } finally {
    if (handle) {
      await handle.close();
    }
  }
}

async function readHead(targetPath, maxBytes) {
  let handle;

  try {
    const stat = await fsp.stat(targetPath);
    const length = Math.min(maxBytes, stat.size);
    const buffer = Buffer.alloc(length);
    handle = await fsp.open(targetPath, 'r');
    await handle.read(buffer, 0, length, 0);
    return buffer.toString('utf8');
  } catch (error) {
    return '';
  } finally {
    if (handle) {
      await handle.close();
    }
  }
}

function parseLocalLogTime(raw) {
  const match = String(raw || '').match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}),(\d{3})/);
  if (!match) {
    return null;
  }

  const date = new Date(match[1] + 'T' + match[2] + '.' + match[3]);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

function ageMsFromIso(iso) {
  if (!iso) {
    return Number.POSITIVE_INFINITY;
  }

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return Number.POSITIVE_INFINITY;
  }

  return Date.now() - date.getTime();
}

function getLiveStateFilePath() {
  return process.env.PHONE_AGENT_LIVE_STATE_PATH
    || path.join(os.homedir(), '.hermes', 'agent_live_state.json');
}

async function readLiveStateSnapshot() {
  const raw = await readJsonFile(getLiveStateFilePath());
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const updatedAt = raw.updatedAt || raw.updated_at || raw.timestamp || nowIso();
  const ageMs = ageMsFromIso(updatedAt);
  const maxAgeMs = Number(process.env.PHONE_AGENT_LIVE_STATE_MAX_AGE_MS || 5 * 60 * 1000);
  if (Number.isFinite(maxAgeMs) && maxAgeMs > 0 && ageMs > maxAgeMs) {
    return null;
  }

  return withDefaults({
    status: raw.status,
    tokenPercent: raw.tokenPercent,
    detail: raw.detail,
    updatedAt,
    task: raw.task,
    runtime: raw.runtime || { source: 'agent-live-state' }
  }, raw.status || 'IDLE', 'hermes-local');
}

async function writeLiveStateSnapshot(payload) {
  const updatedAt = payload && (payload.updatedAt || payload.updated_at || payload.timestamp) || nowIso();
  const normalized = withDefaults({
    status: payload && payload.status,
    tokenPercent: payload && payload.tokenPercent,
    detail: payload && payload.detail,
    updatedAt,
    task: payload && payload.task,
    runtime: payload && payload.runtime
  }, payload && payload.status || 'IDLE', 'hermes-local');

  const filePath = getLiveStateFilePath();
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

function trimPreview(text, limit) {
  const normalized = String(text || '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return '';
  }

  if (normalized.length <= limit) {
    return normalized;
  }

  return normalized.slice(0, Math.max(0, limit - 1)).trimEnd() + '…';
}

function buildHermesSnapshot(agentTail, gatewayTail, gatewayState) {
  const lines = (agentTail + '\n' + gatewayTail).split(/\r?\n/);
  let latestActivityAt = gatewayState && gatewayState.updated_at ? gatewayState.updated_at : null;
  const signalEvents = [];
  let latestRuntime = null;

  function noteSignal(signal) {
    if (!signal || !signal.updatedAt) {
      return;
    }
    signalEvents.push({
      status: signal.status,
      updatedAt: signal.updatedAt,
      signal,
      updatedAtMs: safeDateMs(signal.updatedAt) || 0
    });
  }

  for (const line of lines) {
    const when = parseLocalLogTime(line);
    if (!when) {
      continue;
    }

    const updatedAt = when.toISOString();

    if (/weixin|wechat/i.test(line) && /error|expired|failed|session expired|send failed/i.test(line)) {
      continue;
    }

    const runtime = extractRuntimeFromHermesLine(line);
    if (runtime) {
      latestRuntime = runtime;
    }

    if (/agent\.tool_executor: tool .*returned error/i.test(line)) {
      const toolMatch = line.match(/agent\.tool_executor: tool ([^ ]+) returned error/i);
      noteSignal({
        status: 'ERROR',
        detail: toolMatch
          ? 'Hermes 工具报错：' + toolMatch[1]
          : 'Hermes 执行工具时发生错误。',
        updatedAt,
        runtime: runtime || latestRuntime
      });
      continue;
    }

    if (/\bTraceback\b|\bERROR\b/i.test(line) && /hermes|gateway|run_agent|agent\./i.test(line)) {
      noteSignal({
        status: 'ERROR',
        detail: trimPreview(line.replace(/^.*?:\s*/, ''), 90) || 'Hermes 日志中出现错误。',
        updatedAt,
        runtime: runtime || latestRuntime
      });
      continue;
    }

    const toolMatch = line.match(/agent\.tool_executor: tool ([^ ]+) completed/i);
    if (toolMatch) {
      noteSignal({
        status: 'RUNNING',
        detail: 'Hermes 正在运行工具：' + toolMatch[1],
        updatedAt,
        runtime: runtime || latestRuntime
      });
      continue;
    }

    const apiMatch = line.match(/agent\.conversation_loop: API call #(\d+)/i);
    if (apiMatch) {
      noteSignal({
        status: 'THINKING',
        detail: 'Hermes 正在推理，最近完成了 API 调用 #' + apiMatch[1],
        updatedAt,
        runtime: runtime || latestRuntime
      });
      continue;
    }

    const inboundMatch = line.match(/gateway\.run: inbound message: .* msg='([^']*)'/i);
    if (inboundMatch) {
      noteSignal({
        status: 'THINKING',
        detail: 'Hermes 收到新消息：' + trimPreview(inboundMatch[1], 32),
        updatedAt,
        runtime: runtime || latestRuntime
      });
      continue;
    }
  }

  signalEvents.sort((left, right) => left.updatedAtMs - right.updatedAtMs);

  const relevantEvents = signalEvents.map((event) => ({
    status: event.status,
    updatedAt: event.updatedAt
  }));
  const latestSignal = signalEvents.length ? signalEvents[signalEvents.length - 1].signal : null;

  if (latestSignal && latestSignal.updatedAt) {
    latestActivityAt = latestSignal.updatedAt;
  }

  const gatewayRunning = gatewayState && gatewayState.gateway_state === 'running';
  const activeAgents = gatewayState && Number.isFinite(Number(gatewayState.active_agents))
    ? Number(gatewayState.active_agents)
    : 0;

  if (latestSignal) {
    const ageMs = ageMsFromIso(latestSignal.updatedAt);

    if (latestSignal.status === 'ERROR' && ageMs <= 15 * 60 * 1000) {
      latestSignal.task = buildBurstTask(relevantEvents, relevantEvents.length - 1, latestSignal.status, 'hermes-local');
      return withDefaults(latestSignal, 'ERROR', 'hermes-local');
    }

    if (latestSignal.status === 'RUNNING' && ageMs <= 15 * 1000) {
      latestSignal.task = buildBurstTask(relevantEvents, relevantEvents.length - 1, latestSignal.status, 'hermes-local', {
        maxGapMs: 45 * 1000,
        maxSpanMs: 10 * 60 * 1000
      });
      return withDefaults(latestSignal, 'RUNNING', 'hermes-local');
    }

    if (latestSignal.status === 'THINKING' && ageMs <= 25 * 1000) {
      latestSignal.task = buildBurstTask(relevantEvents, relevantEvents.length - 1, latestSignal.status, 'hermes-local', {
        maxGapMs: 45 * 1000,
        maxSpanMs: 10 * 60 * 1000
      });
      return withDefaults(latestSignal, 'THINKING', 'hermes-local');
    }

    if (activeAgents > 0) {
      return withDefaults({
        status: 'THINKING',
        detail: 'Hermes 当前有 ' + activeAgents + ' 个活动 agent。',
        updatedAt: latestActivityAt || nowIso(),
        runtime: latestRuntime,
        task: {
          startedAt: latestActivityAt || nowIso(),
          estimatedDurationSec: getDefaultEstimateSec('hermes-local', 'THINKING'),
          label: 'THINKING'
        }
      }, 'THINKING', 'hermes-local');
    }

    if (ageMs <= 3 * 60 * 1000) {
      return withDefaults({
        status: 'DONE',
        detail: 'Hermes 刚完成一轮处理。',
        updatedAt: latestSignal.updatedAt,
        runtime: latestSignal.runtime || latestRuntime,
        task: buildBurstTask(relevantEvents, relevantEvents.length - 1, 'DONE', 'hermes-local', {
          maxGapMs: 45 * 1000,
          maxSpanMs: 10 * 60 * 1000
        })
      }, 'DONE', 'hermes-local');
    }
  }

  if (!gatewayRunning) {
    return withDefaults({
      status: 'ERROR',
      detail: 'Hermes 网关当前不在运行。',
      updatedAt: latestActivityAt || nowIso(),
      runtime: latestRuntime
    }, 'ERROR', 'hermes-local');
  }

  if (activeAgents > 0) {
    return withDefaults({
      status: 'THINKING',
      detail: 'Hermes 当前有 ' + activeAgents + ' 个活动 agent。',
      updatedAt: latestActivityAt || nowIso(),
      runtime: latestRuntime,
      task: {
        startedAt: latestActivityAt || nowIso(),
        estimatedDurationSec: getDefaultEstimateSec('hermes-local', 'THINKING'),
        label: 'THINKING'
      }
    }, 'THINKING', 'hermes-local');
  }

  return withDefaults({
    status: 'IDLE',
    detail: 'Hermes 网关在线，正在等待新消息。',
    updatedAt: latestActivityAt || nowIso(),
    runtime: latestRuntime
  }, 'IDLE', 'hermes-local');
}

async function pollHermesLocal() {
  const homeDir = path.join(os.homedir(), '.hermes');
  const liveState = await readLiveStateSnapshot();
  if (liveState) {
    return {
      available: true,
      state: liveState
    };
  }

  const gatewayStatePath = path.join(homeDir, 'gateway_state.json');
  const agentLogPath = path.join(homeDir, 'logs', 'agent.log');
  const gatewayLogPath = path.join(homeDir, 'logs', 'gateway.log');
  const available = await fileExists(gatewayStatePath) || await fileExists(agentLogPath);

  if (!available) {
    return {
      available: false,
      state: withDefaults({
        status: 'ERROR',
        detail: '没有找到 Hermes 本机日志或状态文件。',
        updatedAt: nowIso()
      }, 'ERROR', 'hermes-local')
    };
  }

  const gatewayState = await readJsonFile(gatewayStatePath);
  const agentTail = await readTail(agentLogPath, 96 * 1024);
  const gatewayTail = await readTail(gatewayLogPath, 64 * 1024);

  return {
    available: true,
    state: buildHermesSnapshot(agentTail, gatewayTail, gatewayState)
  };
}

async function findLatestJsonl(rootDir) {
  async function walk(dirPath) {
    let entries;

    try {
      entries = await fsp.readdir(dirPath, { withFileTypes: true });
    } catch (error) {
      return null;
    }

    let latest = null;

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        const nested = await walk(fullPath);
        if (nested && (!latest || nested.mtimeMs > latest.mtimeMs)) {
          latest = nested;
        }
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
        continue;
      }

      try {
        const stat = await fsp.stat(fullPath);
        if (!latest || stat.mtimeMs > latest.mtimeMs) {
          latest = {
            path: fullPath,
            mtimeMs: stat.mtimeMs
          };
        }
      } catch (error) {
        continue;
      }
    }

    return latest;
  }

  return walk(rootDir);
}

function buildCodexSnapshot(sessionTail, fallbackUpdatedAt) {
  const lines = sessionTail.split(/\r?\n/);
  let latestSignal = null;
  let latestActiveSignal = null;
  let latestDoneSignal = null;
  const relevantEvents = [];
  let latestRuntime = null;

  function noteSignal(signal) {
    const eventIndex = relevantEvents.push({
      status: signal.status,
      updatedAt: signal.updatedAt
    }) - 1;
    signal.eventIndex = eventIndex;
    latestSignal = signal;

    if (isActiveStatus(signal.status)) {
      latestActiveSignal = signal;
    }

    if (signal.status === 'DONE') {
      latestDoneSignal = signal;
    }
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) {
      continue;
    }

    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch (error) {
      continue;
    }

    const updatedAt = entry && entry.timestamp ? entry.timestamp : fallbackUpdatedAt;
    if (!updatedAt) {
      continue;
    }

    if (entry.type === 'turn_context' && entry.payload) {
      latestRuntime = {
        model: entry.payload.model ? String(entry.payload.model) : '',
        provider: 'openai',
        source: 'codex-latest'
      };
    }

    if (entry.type === 'session_meta' && entry.payload) {
      latestRuntime = {
        model: latestRuntime && latestRuntime.model ? latestRuntime.model : '',
        provider: entry.payload.model_provider ? String(entry.payload.model_provider).toLowerCase() : (latestRuntime && latestRuntime.provider ? latestRuntime.provider : ''),
        source: 'codex-latest'
      };
    }

    if (entry.type === 'response_item' && entry.payload && entry.payload.type === 'reasoning') {
      const summary = Array.isArray(entry.payload.summary) ? entry.payload.summary : [];
      const firstText = summary.length && summary[0] && summary[0].text ? summary[0].text : '';
      noteSignal({
        status: 'THINKING',
        detail: trimPreview(firstText, 72) || 'Codex 正在思考。',
        updatedAt,
        runtime: latestRuntime
      });
      continue;
    }

    if (entry.type === 'response_item' && entry.payload && entry.payload.type === 'function_call') {
      noteSignal({
        status: 'RUNNING',
        detail: 'Codex 正在调用工具：' + entry.payload.name,
        updatedAt,
        runtime: latestRuntime
      });
      continue;
    }

    if (entry.type === 'response_item' && entry.payload && entry.payload.type === 'function_call_output') {
      noteSignal({
        status: 'THINKING',
        detail: 'Codex 已拿到工具结果，继续思考中。',
        updatedAt,
        runtime: latestRuntime
      });
      continue;
    }

    if (entry.type === 'response_item' && entry.payload && entry.payload.type === 'message') {
      const content = Array.isArray(entry.payload.content) ? entry.payload.content : [];
      const firstText = content.length && content[0] && content[0].text ? content[0].text : '';
      noteSignal({
        status: 'WRITING',
        detail: trimPreview(firstText, 72) || 'Codex 正在输出回复。',
        updatedAt,
        runtime: latestRuntime
      });
      continue;
    }

    if (entry.type === 'event_msg' && entry.payload && entry.payload.type === 'agent_reasoning') {
      noteSignal({
        status: 'THINKING',
        detail: trimPreview(entry.payload.text, 72) || 'Codex 正在思考。',
        updatedAt,
        runtime: latestRuntime
      });
      continue;
    }

    if (entry.type === 'event_msg' && entry.payload && entry.payload.type === 'agent_message') {
      noteSignal({
        status: 'WRITING',
        detail: trimPreview(entry.payload.message, 72) || 'Codex 正在输出回复。',
        updatedAt,
        runtime: latestRuntime
      });
      continue;
    }

    if (entry.type === 'event_msg' && entry.payload && entry.payload.type === 'task_started') {
      noteSignal({
        status: 'THINKING',
        detail: 'Codex 开始处理新任务。',
        updatedAt,
        runtime: latestRuntime
      });
      continue;
    }

    if (entry.type === 'event_msg' && entry.payload && entry.payload.type === 'task_complete') {
      noteSignal({
        status: 'DONE',
        detail: 'Codex 已完成当前回合。',
        updatedAt,
        runtime: latestRuntime
      });
    }
  }

  if (!latestSignal) {
    return withDefaults({
      status: 'IDLE',
      detail: '最近没有读到 Codex 会话事件。',
      updatedAt: fallbackUpdatedAt || nowIso(),
      runtime: latestRuntime
    }, 'IDLE', 'codex-latest');
  }

  const ageMs = ageMsFromIso(latestSignal.updatedAt);
  const latestActiveMs = latestActiveSignal ? safeDateMs(latestActiveSignal.updatedAt) : null;
  const latestDoneMs = latestDoneSignal ? safeDateMs(latestDoneSignal.updatedAt) : null;
  const hasOpenTurn = !!(
    latestActiveSignal
    && (!latestDoneSignal || (latestActiveMs && latestDoneMs && latestActiveMs > latestDoneMs))
  );

  if (latestSignal.status === 'RUNNING' && ageMs <= 20 * 1000) {
    latestSignal.task = buildBurstTask(relevantEvents, relevantEvents.length - 1, latestSignal.status, 'codex-latest', {
      maxGapMs: 90 * 1000,
      maxSpanMs: 20 * 60 * 1000
    });
    return withDefaults(latestSignal, 'RUNNING', 'codex-latest');
  }

  if (latestSignal.status === 'THINKING' && ageMs <= 45 * 1000) {
    latestSignal.task = buildBurstTask(relevantEvents, relevantEvents.length - 1, latestSignal.status, 'codex-latest', {
      maxGapMs: 90 * 1000,
      maxSpanMs: 20 * 60 * 1000
    });
    return withDefaults(latestSignal, 'THINKING', 'codex-latest');
  }

  if (latestSignal.status === 'WRITING' && ageMs <= 25 * 1000) {
    latestSignal.task = buildBurstTask(relevantEvents, relevantEvents.length - 1, latestSignal.status, 'codex-latest', {
      maxGapMs: 90 * 1000,
      maxSpanMs: 20 * 60 * 1000
    });
    return withDefaults(latestSignal, 'WRITING', 'codex-latest');
  }

  if (hasOpenTurn) {
    const openTurnAgeMs = ageMsFromIso(latestActiveSignal.updatedAt);

    if (openTurnAgeMs <= 30 * 60 * 1000) {
      latestActiveSignal.task = buildBurstTask(relevantEvents, latestActiveSignal.eventIndex, latestActiveSignal.status, 'codex-latest', {
        maxGapMs: 90 * 1000,
        maxSpanMs: 30 * 60 * 1000
      });
      return withDefaults(latestActiveSignal, latestActiveSignal.status, 'codex-latest');
    }
  }

  if (latestDoneSignal && ageMsFromIso(latestDoneSignal.updatedAt) <= 10 * 60 * 1000) {
    return withDefaults({
      status: 'DONE',
      detail: 'Codex 最近刚完成一轮工作。',
      updatedAt: latestDoneSignal.updatedAt,
      runtime: latestDoneSignal.runtime || latestRuntime,
      task: buildBurstTask(relevantEvents, latestDoneSignal.eventIndex, 'DONE', 'codex-latest', {
        maxGapMs: 90 * 1000,
        maxSpanMs: 20 * 60 * 1000
      })
    }, 'DONE', 'codex-latest');
  }

  return withDefaults({
    status: 'IDLE',
    detail: 'Codex 当前空闲，等待新的工作。',
    updatedAt: latestSignal.updatedAt,
    runtime: latestSignal.runtime || latestRuntime
  }, 'IDLE', 'codex-latest');
}

function extractCodexRuntime(sessionText) {
  const lines = String(sessionText || '').split(/\r?\n/);
  let runtime = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) {
      continue;
    }

    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch (error) {
      continue;
    }

    if (entry.type === 'turn_context' && entry.payload && entry.payload.model) {
      runtime = {
        model: String(entry.payload.model),
        provider: runtime && runtime.provider ? runtime.provider : 'openai',
        source: 'codex-latest'
      };
    }

    if (entry.type === 'session_meta' && entry.payload && entry.payload.model_provider) {
      runtime = {
        model: runtime && runtime.model ? runtime.model : '',
        provider: String(entry.payload.model_provider).toLowerCase(),
        source: 'codex-latest'
      };
    }
  }

  return runtime;
}

async function pollCodexLatest(cache) {
  const rootDir = path.join(os.homedir(), '.codex', 'sessions');
  const now = Date.now();

  if (!cache.latestSession || now - cache.latestSession.checkedAt > 10 * 1000) {
    const latest = await findLatestJsonl(rootDir);
    cache.latestSession = latest
      ? { path: latest.path, mtimeMs: latest.mtimeMs, checkedAt: now }
      : { path: null, mtimeMs: 0, checkedAt: now };
  }

  if (!cache.latestSession.path) {
    return {
      available: false,
      state: withDefaults({
        status: 'ERROR',
        detail: '没有找到 Codex 会话 JSONL。',
        updatedAt: nowIso()
      }, 'ERROR', 'codex-latest')
    };
  }

  let stat;
  try {
    stat = await fsp.stat(cache.latestSession.path);
  } catch (error) {
    return {
      available: false,
      state: withDefaults({
        status: 'ERROR',
        detail: 'Codex 会话文件暂时不可读。',
        updatedAt: nowIso()
      }, 'ERROR', 'codex-latest')
    };
  }

  const sessionTail = await readTail(cache.latestSession.path, 128 * 1024);
  let state = buildCodexSnapshot(sessionTail, new Date(stat.mtimeMs).toISOString());

  if (!state.runtime || !state.runtime.model) {
    const sessionHead = await readHead(cache.latestSession.path, 48 * 1024);
    const runtime = extractCodexRuntime(sessionHead);
    if (runtime) {
      state = withDefaults({
        ...state,
        runtime: {
          model: runtime.model || (state.runtime && state.runtime.model) || '',
          provider: runtime.provider || (state.runtime && state.runtime.provider) || '',
          source: 'codex-latest'
        }
      }, state.status, 'codex-latest');
    }
  }

  return {
    available: true,
    state
  };
}

function compareSnapshots(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function createBindingManager(options) {
  const getManualState = options.getManualState;
  const onStateChange = options.onStateChange;
  const pollIntervalMs = Number(options.pollIntervalMs || 1500);
  const enabledBindings = getEnabledBindings(options.env || process.env);
  const byId = new Map(enabledBindings.map((binding) => [binding.id, binding]));
  const cache = {
    latestSession: null
  };

  let currentBindingId = byId.has(options.initialBindingId) ? options.initialBindingId : 'manual';
  let currentSnapshot = withDefaults(getManualState(), 'IDLE', 'manual');
  let timer = null;
  let polling = false;

  function getCurrentBinding() {
    return byId.get(currentBindingId) || byId.get('manual');
  }

  function getBindings() {
    return enabledBindings.map((binding) => ({
      id: binding.id,
      label: binding.label,
      source: binding.source,
      interactive: binding.interactive,
      kind: binding.kind,
      active: binding.id === currentBindingId
    }));
  }

  async function pollActiveBinding() {
    const binding = getCurrentBinding();

    if (binding.id === 'manual') {
      return withDefaults(getManualState(), 'IDLE', 'manual');
    }

    if (binding.id === 'hermes-local') {
      const result = await pollHermesLocal();
      return result.state;
    }

    if (binding.id === 'codex-latest') {
      const result = await pollCodexLatest(cache);
      return result.state;
    }

    return withDefaults({
      status: 'ERROR',
      detail: '未知绑定目标：' + binding.id,
      updatedAt: nowIso()
    }, 'ERROR', binding.id);
  }

  async function refresh(forceNotify) {
    if (polling) {
      return currentSnapshot;
    }

    polling = true;
    try {
      const nextSnapshot = await pollActiveBinding();
      const changed = !compareSnapshots(currentSnapshot, nextSnapshot);
      currentSnapshot = nextSnapshot;
      if ((changed || forceNotify) && typeof onStateChange === 'function') {
        onStateChange();
      }
      return currentSnapshot;
    } finally {
      polling = false;
    }
  }

  function notifyManualMutation() {
    if (currentBindingId === 'manual') {
      currentSnapshot = withDefaults(getManualState(), 'IDLE', 'manual');
      if (typeof onStateChange === 'function') {
        onStateChange();
      }
    }
  }

  async function selectBinding(nextId) {
    if (!byId.has(nextId)) {
      const error = new Error('Unknown binding id: ' + nextId);
      error.statusCode = 404;
      throw error;
    }

    currentBindingId = nextId;
    await refresh(true);
    return getCurrentBinding();
  }

  function start() {
    if (timer) {
      return;
    }

    timer = setInterval(() => {
      refresh(false).catch(() => {
        return;
      });
    }, pollIntervalMs);
  }

  function stop() {
    if (!timer) {
      return;
    }
    clearInterval(timer);
    timer = null;
  }

  return {
    getBindings,
    getCurrentBinding,
    getCurrentState: () => currentSnapshot,
    getCurrentBindingId: () => currentBindingId,
    notifyManualMutation,
    refresh,
    selectBinding,
    start,
    stop
  };
}

module.exports = {
  BINDINGS,
  getEnabledBindings,
  writeLiveStateSnapshot,
  createBindingManager
};
