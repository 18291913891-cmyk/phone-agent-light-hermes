require('../lib/load-env').loadEnvFile();

const fs = require('fs');
const os = require('os');
const path = require('path');

const agentLogPath = process.env.HERMES_AGENT_LOG
  || path.join(os.homedir(), '.hermes', 'logs', 'agent.log');
const gatewayLogPath = process.env.HERMES_GATEWAY_LOG
  || path.join(os.homedir(), '.hermes', 'logs', 'gateway.log');
const liveStatePath = process.env.PHONE_AGENT_LIVE_STATE_PATH
  || path.join(os.homedir(), '.hermes', 'agent_live_state.json');
const target = process.env.AGENT_LIGHT_URL || 'http://127.0.0.1:8790';
const pollMs = Number(process.env.HERMES_STATE_BRIDGE_POLL_MS || 200);
const hookPriorityMs = Number(process.env.PHONE_AGENT_HOOK_PRIORITY_MS || 15000);
const replay = /^(1|true|yes|on)$/i.test(String(process.env.HERMES_STATE_BRIDGE_REPLAY || ''));

const DEFAULT_TOKEN_BY_STATUS = {
  IDLE: 100,
  THINKING: 74,
  WRITING: 82,
  RUNNING: 61,
  DONE: 96,
  ERROR: 18,
  NEED_CONFIRM: 45
};

let lastPayloadKey = '';
let lastRuntime = {
  model: process.env.PHONE_AGENT_MODEL || process.env.HERMES_MODEL || 'agnes-2.0-flash',
  provider: process.env.PHONE_AGENT_PROVIDER || process.env.HERMES_PROVIDER || 'agnes',
  source: 'hermes-log-bridge'
};

function nowIso() {
  return new Date().toISOString();
}

function normalizeStatus(status) {
  const value = String(status || 'IDLE').toUpperCase();
  return Object.prototype.hasOwnProperty.call(DEFAULT_TOKEN_BY_STATUS, value) ? value : 'IDLE';
}

function parseLocalLogTime(line) {
  const match = String(line || '').match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}),(\d{3})/);
  if (!match) return null;
  const date = new Date(`${match[1]}T${match[2]}.${match[3]}`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function trimPreview(text, limit) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= limit) return normalized;
  return normalized.slice(0, Math.max(0, limit - 1)).trimEnd() + '…';
}

function extractRuntime(line) {
  const modelMatch = String(line || '').match(/\bmodel=([^\s]+)/i);
  const providerMatch = String(line || '').match(/\bprovider=([^\s]+)/i);
  if (!modelMatch && !providerMatch) return null;
  lastRuntime = {
    model: modelMatch ? modelMatch[1] : lastRuntime.model,
    provider: providerMatch ? providerMatch[1] : lastRuntime.provider,
    source: 'hermes-log-bridge'
  };
  return lastRuntime;
}

function buildTask(status, updatedAt) {
  const active = ['THINKING', 'WRITING', 'RUNNING', 'NEED_CONFIRM'].includes(status);
  if (active) {
    return {
      active: true,
      startedAt: updatedAt,
      endedAt: null,
      estimatedDurationSec: status === 'RUNNING' ? 120 : 180,
      label: status
    };
  }
  if (status === 'DONE' || status === 'ERROR') {
    return {
      active: false,
      startedAt: null,
      endedAt: updatedAt,
      estimatedDurationSec: null,
      label: status
    };
  }
  return null;
}

function classifyLine(line) {
  const updatedAt = parseLocalLogTime(line) || nowIso();
  const runtime = extractRuntime(line) || lastRuntime;

  if (/weixin|wechat/i.test(line) && /error|expired|failed|session expired|send failed/i.test(line)) {
    return null;
  }

  const turnMatch = line.match(/agent\.conversation_loop: conversation turn:.*msg='([^']*)'/i);
  if (turnMatch) {
    return {
      status: 'THINKING',
      detail: 'Hermes 收到新消息：' + trimPreview(turnMatch[1], 36),
      updatedAt,
      runtime
    };
  }

  if (/OpenAI client created .*chat_completion_stream_request/i.test(line)) {
    return {
      status: 'THINKING',
      detail: 'Hermes 正在请求模型回复',
      updatedAt,
      runtime
    };
  }

  const apiMatch = line.match(/agent\.conversation_loop: API call #(\d+):.*latency=([^\s]+)/i)
    || line.match(/agent\.conversation_loop: API call #(\d+)/i);
  if (apiMatch) {
    return {
      status: 'THINKING',
      detail: 'Hermes 完成模型调用 #' + apiMatch[1] + (apiMatch[2] ? '，耗时 ' + apiMatch[2] : ''),
      updatedAt,
      runtime
    };
  }

  const toolFailedMatch = line.match(/agent\.tool_executor: tool ([^ ]+) failed/i)
    || line.match(/agent\.tool_executor: tool ([^ ]+) returned error/i);
  if (toolFailedMatch) {
    return {
      status: 'RUNNING',
      detail: 'Hermes 正在调整工具：' + toolFailedMatch[1],
      updatedAt,
      runtime
    };
  }

  const toolCompletedMatch = line.match(/agent\.tool_executor: tool ([^ ]+) completed/i);
  if (toolCompletedMatch) {
    return {
      status: 'RUNNING',
      detail: 'Hermes 刚运行工具：' + toolCompletedMatch[1],
      updatedAt,
      runtime
    };
  }

  if (/agent\.conversation_loop: Turn ended:/i.test(line)) {
    return {
      status: 'DONE',
      detail: 'Hermes 已完成这一轮回复',
      updatedAt,
      runtime
    };
  }

  if (/\bTraceback\b|\bERROR\b/i.test(line) && /hermes|gateway|run_agent|agent\./i.test(line)) {
    return {
      status: 'ERROR',
      detail: trimPreview(line.replace(/^.*?:\s*/, ''), 90) || 'Hermes 日志中出现错误',
      updatedAt,
      runtime
    };
  }

  const inboundMatch = line.match(/gateway\.run: inbound message:.*msg='([^']*)'/i);
  if (inboundMatch) {
    return {
      status: 'THINKING',
      detail: 'Hermes 收到平台消息：' + trimPreview(inboundMatch[1], 36),
      updatedAt,
      runtime
    };
  }

  return null;
}

async function shouldYieldToHookState() {
  if (!hookPriorityMs || hookPriorityMs <= 0) return false;
  try {
    const raw = await fs.promises.readFile(liveStatePath, 'utf8');
    const current = JSON.parse(raw);
    const source = String(current?.runtime?.source || '');
    if (!source.startsWith('hook/') && source !== 'phone-agent-status/register' && source !== 'gateway/inbound') return false;
    const updatedAt = Date.parse(current.updatedAt || current.updated_at || current.timestamp || '');
    if (!Number.isFinite(updatedAt)) return false;
    return Date.now() - updatedAt < hookPriorityMs;
  } catch (error) {
    return false;
  }
}

async function writeLocalState(payload) {
  const status = normalizeStatus(payload.status);
  const normalized = {
    status,
    tokenPercent: DEFAULT_TOKEN_BY_STATUS[status],
    detail: payload.detail || '',
    updatedAt: payload.updatedAt || nowIso(),
    task: payload.task || buildTask(status, payload.updatedAt || nowIso()),
    runtime: payload.runtime || lastRuntime
  };
  await fs.promises.mkdir(path.dirname(liveStatePath), { recursive: true });
  await fs.promises.writeFile(liveStatePath, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

async function postState(payload) {
  const response = await fetch(`${target}/api/hermes-state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
}

async function publish(rawPayload) {
  if (await shouldYieldToHookState()) return;

  const payload = {
    ...rawPayload,
    status: normalizeStatus(rawPayload.status),
    runtime: rawPayload.runtime || lastRuntime
  };
  payload.task = payload.task || buildTask(payload.status, payload.updatedAt || nowIso());

  const key = JSON.stringify({
    status: payload.status,
    detail: payload.detail,
    updatedAt: payload.updatedAt,
    runtime: payload.runtime
  });
  if (key === lastPayloadKey) return;
  lastPayloadKey = key;

  await writeLocalState(payload);
  try {
    await postState(payload);
  } catch (error) {
    // File write is enough; server will pick it up on refresh.
  }
}

function createTailer(filePath) {
  let position = 0;
  let leftover = '';
  let initialized = false;
  let busy = false;

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      let stat;
      try {
        stat = await fs.promises.stat(filePath);
      } catch (error) {
        position = 0;
        leftover = '';
        return;
      }

      if (!initialized) {
        position = replay ? 0 : stat.size;
        initialized = true;
        return;
      }

      if (stat.size < position) {
        position = 0;
        leftover = '';
      }

      if (stat.size === position) return;

      const length = stat.size - position;
      const handle = await fs.promises.open(filePath, 'r');
      try {
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, position);
        position = stat.size;
        const chunk = leftover + buffer.toString('utf8');
        const lines = chunk.split(/\r?\n/);
        leftover = lines.pop() || '';
        for (const line of lines) {
          const signal = classifyLine(line);
          if (signal) await publish(signal);
        }
      } finally {
        await handle.close();
      }
    } finally {
      busy = false;
    }
  }

  setInterval(tick, pollMs).unref?.();
  tick();
}

createTailer(agentLogPath);
createTailer(gatewayLogPath);

console.log(`Hermes state bridge running. agent=${agentLogPath} gateway=${gatewayLogPath} state=${liveStatePath} target=${target}`);
setInterval(() => {}, 60 * 60 * 1000);
