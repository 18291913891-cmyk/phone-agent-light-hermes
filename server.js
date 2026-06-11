const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { URL } = require('url');
require('./lib/load-env').loadEnvFile();
const { createBindingManager, writeLiveStateSnapshot } = require('./lib/agent-bindings');

const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 8790);
const publicDir = path.join(__dirname, 'public');

const clients = new Set();
const MAX_MESSAGES = 24;
const METRICS_HISTORY_LIMIT = 48;

const STATUS_META = {
  IDLE: { label: 'Idle', accent: '#5eb0ff', tone: 'Ready' },
  THINKING: { label: 'Thinking', accent: '#9b6dff', tone: 'Reasoning' },
  WRITING: { label: 'Writing', accent: '#2fd6c4', tone: 'Editing' },
  RUNNING: { label: 'Running', accent: '#ff9f43', tone: 'Tooling' },
  DONE: { label: 'Done', accent: '#3ddc97', tone: 'Complete' },
  ERROR: { label: 'Error', accent: '#ff5d73', tone: 'Attention' },
  NEED_CONFIRM: { label: 'Confirm', accent: '#f9f871', tone: 'Awaiting input' }
};

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webp': 'image/webp'
};

const conversation = {
  systemPrompt: [
    'You are the Mac-hosted assistant for an old Android e-ink phone.',
    'Keep responses concise, practical, and friendly.',
    'When giving steps, prefer numbered lists.'
  ].join(' '),
  messages: [],
  lastResponseId: null,
  lastUsage: null,
  running: false,
  lastError: null
};

const systemMetrics = {
  cpuPercent: 0,
  memoryUsedBytes: 0,
  memoryTotalBytes: os.totalmem(),
  memoryPercent: 0,
  cpuHistory: [],
  memoryHistory: [],
  sampledAt: new Date().toISOString()
};

let previousCpuSample = null;
let metricsRefreshPromise = null;

const state = {
  status: 'IDLE',
  tokenPercent: 100,
  detail: 'Waiting for your next move.',
  updatedAt: new Date().toISOString(),
  task: null,
  runtime: {
    model: process.env.OPENAI_API_KEY
      ? (process.env.OPENAI_MODEL || 'gpt-4.1-mini')
      : 'Mock',
    provider: process.env.OPENAI_API_KEY ? 'openai' : 'mock',
    source: 'manual'
  }
};

function getManualRuntime() {
  return {
    model: process.env.OPENAI_API_KEY
      ? (process.env.OPENAI_MODEL || 'gpt-4.1-mini')
      : 'Mock',
    provider: process.env.OPENAI_API_KEY ? 'openai' : 'mock',
    source: 'manual'
  };
}

function clampPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  if (numeric < 0) {
    return 0;
  }

  if (numeric > 100) {
    return 100;
  }

  return numeric;
}

function readCpuSample() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;

  for (const cpu of cpus) {
    const times = cpu && cpu.times ? cpu.times : {};
    idle += Number(times.idle || 0);
    total += Number(times.user || 0)
      + Number(times.nice || 0)
      + Number(times.sys || 0)
      + Number(times.irq || 0)
      + Number(times.idle || 0);
  }

  return { idle, total };
}

function pushMetricSample(history, value) {
  history.push(Math.round(clampPercent(value) * 10) / 10);
  if (history.length > METRICS_HISTORY_LIMIT) {
    history.splice(0, history.length - METRICS_HISTORY_LIMIT);
  }
}

async function readActivityMonitorMemoryBytes() {
  const stdout = execFileSync('/usr/bin/vm_stat', { encoding: 'utf8' });
  const lines = String(stdout || '').split(/\r?\n/);
  let pageSize = 4096;
  const values = {};

  for (const line of lines) {
    const pageSizeMatch = line.match(/page size of (\d+) bytes/i);
    if (pageSizeMatch) {
      pageSize = Number(pageSizeMatch[1]) || pageSize;
      continue;
    }

    const statMatch = line.match(/^([^:]+):\s+([\d.]+)/);
    if (!statMatch) {
      continue;
    }

    values[statMatch[1].trim()] = Number(statMatch[2].replace(/\./g, '')) || 0;
  }

  const anonymousPages = values['Anonymous pages'] || 0;
  const wiredPages = values['Pages wired down'] || 0;
  const compressedPages = values['Pages occupied by compressor'] || 0;

  return (anonymousPages + wiredPages + compressedPages) * pageSize;
}

async function sampleSystemMetrics() {
  const cpuSample = readCpuSample();
  const memoryTotalBytes = os.totalmem();
  let cpuPercent = systemMetrics.cpuPercent;
  let memoryUsedBytes;

  if (previousCpuSample) {
    const totalDiff = cpuSample.total - previousCpuSample.total;
    const idleDiff = cpuSample.idle - previousCpuSample.idle;

    if (totalDiff > 0) {
      cpuPercent = clampPercent((1 - idleDiff / totalDiff) * 100);
    }
  }

  previousCpuSample = cpuSample;

  try {
    memoryUsedBytes = readActivityMonitorMemoryBytes ? await readActivityMonitorMemoryBytes() : null;
  } catch (error) {
    memoryUsedBytes = null;
  }

  if (!Number.isFinite(memoryUsedBytes)) {
    memoryUsedBytes = Math.max(0, memoryTotalBytes - os.freemem());
  }

  const memoryPercent = memoryTotalBytes > 0
    ? clampPercent((memoryUsedBytes / memoryTotalBytes) * 100)
    : 0;

  systemMetrics.cpuPercent = Math.round(cpuPercent * 10) / 10;
  systemMetrics.memoryUsedBytes = memoryUsedBytes;
  systemMetrics.memoryTotalBytes = memoryTotalBytes;
  systemMetrics.memoryPercent = Math.round(memoryPercent * 10) / 10;
  systemMetrics.sampledAt = new Date().toISOString();

  pushMetricSample(systemMetrics.cpuHistory, systemMetrics.cpuPercent);
  pushMetricSample(systemMetrics.memoryHistory, systemMetrics.memoryPercent);

  return systemMetrics;
}

function refreshSystemMetrics() {
  if (metricsRefreshPromise) {
    return metricsRefreshPromise;
  }

  metricsRefreshPromise = sampleSystemMetrics()
    .catch(() => systemMetrics)
    .finally(() => {
      metricsRefreshPromise = null;
    });

  return metricsRefreshPromise;
}

function deriveManualTask(next, nowIsoString) {
  const nextStatus = next && next.status ? String(next.status).toUpperCase() : String(state.status || 'IDLE').toUpperCase();
  const previousTask = state.task || null;
  const activeStatuses = {
    THINKING: true,
    WRITING: true,
    RUNNING: true,
    NEED_CONFIRM: true
  };

  if (activeStatuses[nextStatus]) {
    return {
      active: true,
      startedAt: previousTask && previousTask.startedAt ? previousTask.startedAt : nowIsoString,
      endedAt: null,
      estimatedDurationSec: previousTask && previousTask.estimatedDurationSec ? previousTask.estimatedDurationSec : null,
      label: nextStatus
    };
  }

  if (nextStatus === 'DONE' || nextStatus === 'ERROR') {
    if (previousTask && previousTask.startedAt) {
      return {
        active: false,
        startedAt: previousTask.startedAt,
        endedAt: nowIsoString,
        estimatedDurationSec: previousTask.estimatedDurationSec || null,
        label: nextStatus
      };
    }

    return {
      active: false,
      startedAt: nowIsoString,
      endedAt: nowIsoString,
      estimatedDurationSec: null,
      label: nextStatus
    };
  }

  if (nextStatus === 'IDLE') {
    return next && Object.prototype.hasOwnProperty.call(next, 'task') ? next.task : null;
  }

  return previousTask;
}

function enrichState() {
  const liveState = bindingManager.getCurrentState();
  const meta = STATUS_META[liveState.status] || STATUS_META.IDLE;
  return {
    ...liveState,
    runtime: liveState.runtime || (bindingManager.getCurrentBindingId() === 'manual' ? getManualRuntime() : null),
    system: systemMetrics,
    meta,
    binding: bindingManager.getCurrentBinding(),
    conversation: {
      running: conversation.running,
      messageCount: conversation.messages.length,
      lastResponseId: conversation.lastResponseId,
      lastUsage: conversation.lastUsage,
      lastError: conversation.lastError
    }
  };
}

function sendJson(res, code, payload) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function broadcast() {
  const payload = 'data: ' + JSON.stringify(enrichState()) + '\n\n';
  for (const res of clients) {
    res.write(payload);
  }
}

function updateState(next) {
  const nowIsoString = new Date().toISOString();
  const merged = Object.assign({}, next, {
    updatedAt: nowIsoString,
    task: next && Object.prototype.hasOwnProperty.call(next, 'task')
      ? next.task
      : deriveManualTask(next, nowIsoString)
  });

  Object.assign(state, merged);
  bindingManager.notifyManualMutation();
}

function appendMessage(role, content, extra) {
  const entry = Object.assign({
    id: String(Date.now()) + '-' + Math.random().toString(16).slice(2, 8),
    role,
    content,
    createdAt: new Date().toISOString()
  }, extra || {});

  conversation.messages.push(entry);
  if (conversation.messages.length > MAX_MESSAGES) {
    conversation.messages.splice(0, conversation.messages.length - MAX_MESSAGES);
  }
  return entry;
}

function resetConversation() {
  conversation.messages = [];
  conversation.lastResponseId = null;
  conversation.lastUsage = null;
  conversation.lastError = null;
  conversation.running = false;
  updateState({
    status: 'IDLE',
    tokenPercent: 100,
    detail: 'Conversation cleared. Waiting for your next move.',
    task: null,
    runtime: getManualRuntime()
  });
}

function parseCommand(raw) {
  const command = String(raw || '').trim();
  if (!command) {
    return { error: 'Command is required.' };
  }

  if (command.toUpperCase().indexOf('TOKEN:') === 0) {
    const value = Number(command.split(':')[1]);
    if (!Number.isFinite(value)) {
      return { error: 'TOKEN command must be TOKEN:0-100.' };
    }

    const tokenPercent = Math.max(0, Math.min(100, Math.round(value)));
    return {
      next: {
        tokenPercent,
        detail: 'Token budget updated to ' + tokenPercent + '%.'
      }
    };
  }

  const normalized = command.toUpperCase();
  if (!STATUS_META[normalized]) {
    return {
      error: 'Unknown command: ' + command + '. Supported: ' + Object.keys(STATUS_META).join(', ') + ', TOKEN:x'
    };
  }

  return {
    next: {
      status: normalized,
      detail: STATUS_META[normalized].label + ' signal received.'
    }
  };
}

function serveStatic(res, pathname) {
  const defaultPage = process.env.DEFAULT_PAGE || 'display.html';
  const relativePath = pathname === '/' ? defaultPage : pathname.replace(/^\/+/g, '');
  const filePath = path.join(publicDir, relativePath);
  const normalized = path.normalize(filePath);

  if (normalized.indexOf(publicDir) !== 0) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  fs.readFile(normalized, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    const ext = path.extname(normalized).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': '.html,.css,.js'.indexOf(ext) >= 0 ? 'no-store' : 'public, max-age=300'
    });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 128) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });

    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function getLanUrls() {
  const interfaces = os.networkInterfaces();
  const urls = [];

  for (const values of Object.values(interfaces)) {
    for (const entry of values || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        urls.push('http://' + entry.address + ':' + port);
      }
    }
  }

  return urls;
}

function buildRuntimeConfig() {
  const hasApiKey = !!process.env.OPENAI_API_KEY;
  return {
    host,
    port,
    phoneUrls: getLanUrls(),
    binding: {
      active: bindingManager.getCurrentBinding(),
      options: bindingManager.getBindings()
    },
    ai: {
      provider: hasApiKey ? 'openai' : 'mock',
      ready: hasApiKey,
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      hasApiKey
    }
  };
}

function summarizeUsage(usage) {
  if (!usage) {
    return null;
  }

  const inputTokens = Number(usage.input_tokens || usage.prompt_tokens || 0);
  const outputTokens = Number(usage.output_tokens || usage.completion_tokens || 0);
  const totalTokens = Number(usage.total_tokens || inputTokens + outputTokens);

  return {
    inputTokens,
    outputTokens,
    totalTokens
  };
}

function estimateTokenPercent(usage) {
  if (!usage || !usage.totalTokens) {
    return state.tokenPercent;
  }

  const remaining = 100 - Math.round(Math.min(85, usage.totalTokens / 80));
  return Math.max(12, remaining);
}

function buildResponsesInput() {
  const items = [
    {
      role: 'system',
      content: [
        {
          type: 'input_text',
          text: conversation.systemPrompt
        }
      ]
    }
  ];

  for (const message of conversation.messages) {
    items.push({
      role: message.role,
      content: [
        {
          type: 'input_text',
          text: message.content
        }
      ]
    });
  }

  return items;
}

function extractOutputText(payload) {
  if (!payload) {
    return '';
  }

  if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const chunks = [];
  const output = Array.isArray(payload.output) ? payload.output : [];

  for (const item of output) {
    const content = Array.isArray(item && item.content) ? item.content : [];
    for (const part of content) {
      if (part && typeof part.text === 'string') {
        chunks.push(part.text);
      }
    }
  }

  return chunks.join('\n').trim();
}

async function callOpenAI() {
  const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set.');
  }

  const response = await fetch(baseUrl + '/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      model,
      input: buildResponsesInput(),
      max_output_tokens: 500
    })
  });

  const rawText = await response.text();
  let payload = null;

  try {
    payload = rawText ? JSON.parse(rawText) : null;
  } catch (error) {
    payload = null;
  }

  if (!response.ok) {
    const message = payload && payload.error && payload.error.message
      ? payload.error.message
      : rawText
      ? rawText
      : 'OpenAI request failed with HTTP ' + response.status;
    throw new Error(message);
  }

  return {
    id: payload && payload.id ? payload.id : null,
    text: extractOutputText(payload) || 'No text output returned.',
    usage: summarizeUsage(payload && payload.usage),
    raw: payload
  };
}

async function callMockAssistant(prompt) {
  await new Promise((resolve) => setTimeout(resolve, 480));

  const text = [
    '当前处于离线演示模式，因为还没有提供 OPENAI_API_KEY。',
    '',
    '你刚才的问题是：' + prompt,
    '',
    '等你明天回来后，可以：',
    '1. 导出 OPENAI_API_KEY',
    '2. 重新启动 `npm start`',
    '3. 在控制台页面直接继续对话'
  ].join('\n');

  return {
    id: 'mock-' + Date.now(),
    text,
    usage: {
      inputTokens: Math.max(12, Math.round(prompt.length / 2)),
      outputTokens: 88,
      totalTokens: Math.max(100, Math.round(prompt.length / 2) + 88)
    },
    raw: null
  };
}

async function runConversationTurn(prompt) {
  if (conversation.running) {
    const error = new Error('A conversation turn is already running.');
    error.statusCode = 409;
    throw error;
  }

  conversation.running = true;
  conversation.lastError = null;
  appendMessage('user', prompt);

  updateState({
    status: 'THINKING',
    detail: 'Question received. Asking the Mac-side assistant now.'
  });

  try {
    const result = process.env.OPENAI_API_KEY
      ? await callOpenAI()
      : await callMockAssistant(prompt);

    updateState({
      status: 'WRITING',
      detail: 'Response is ready. Updating the control console and phone display.',
      tokenPercent: estimateTokenPercent(result.usage)
    });

    appendMessage('assistant', result.text, {
      responseId: result.id,
      usage: result.usage
    });

    conversation.lastResponseId = result.id;
    conversation.lastUsage = result.usage;
    conversation.running = false;

    updateState({
      status: 'DONE',
      detail: 'Latest reply delivered to the control console.',
      tokenPercent: estimateTokenPercent(result.usage)
    });

    return result;
  } catch (error) {
    conversation.lastError = error.message || 'Unknown error';
    conversation.running = false;
    updateState({
      status: 'ERROR',
      detail: conversation.lastError
    });
    throw error;
  } finally {
    conversation.running = false;
  }
}

function getConversationPayload() {
  return {
    available: bindingManager.getCurrentBindingId() === 'manual',
    systemPrompt: conversation.systemPrompt,
    messages: conversation.messages,
    running: conversation.running,
    lastResponseId: conversation.lastResponseId,
    lastUsage: conversation.lastUsage,
    lastError: conversation.lastError
  };
}

const bindingManager = createBindingManager({
  getManualState: () => state,
  onStateChange: broadcast,
  initialBindingId: process.env.PHONE_AGENT_BINDING || 'manual',
  pollIntervalMs: Number(process.env.PHONE_AGENT_POLL_MS || 300)
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  if (req.method === 'GET' && url.pathname === '/api/state') {
    await refreshSystemMetrics();
    await bindingManager.refresh(false);
    sendJson(res, 200, enrichState());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/config') {
    await refreshSystemMetrics();
    await bindingManager.refresh(false);
    sendJson(res, 200, buildRuntimeConfig());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/conversation') {
    sendJson(res, 200, getConversationPayload());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/bindings') {
    await refreshSystemMetrics();
    await bindingManager.refresh(false);
    sendJson(res, 200, {
      active: bindingManager.getCurrentBinding(),
      options: bindingManager.getBindings()
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    await refreshSystemMetrics();
    await bindingManager.refresh(false);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive'
    });
    res.write('data: ' + JSON.stringify(enrichState()) + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/hermes-state') {
    try {
      const body = await readBody(req);
      const payload = body ? JSON.parse(body) : {};
      const written = await writeLiveStateSnapshot(payload);
      await bindingManager.refresh(true);
      sendJson(res, 200, {
        ok: true,
        state: written,
        current: enrichState()
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Bad request' });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/command') {
    if (bindingManager.getCurrentBindingId() !== 'manual') {
      sendJson(res, 409, { error: '当前已绑定真实 agent，手动状态按钮已禁用。请先切回“手动 / 内置对话”。' });
      return;
    }

    try {
      const body = await readBody(req);
      const payload = body ? JSON.parse(body) : {};
      const parsed = parseCommand(payload.command);

      if (parsed.error) {
        sendJson(res, 400, parsed);
        return;
      }

      updateState(parsed.next);
      sendJson(res, 200, enrichState());
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Bad request' });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/state') {
    if (bindingManager.getCurrentBindingId() !== 'manual') {
      sendJson(res, 409, { error: '当前已绑定真实 agent，不能直接覆盖显示状态。' });
      return;
    }

    try {
      const body = await readBody(req);
      const payload = body ? JSON.parse(body) : {};
      const next = {};

      if (payload.status) {
        const normalized = String(payload.status).toUpperCase();
        if (!STATUS_META[normalized]) {
          sendJson(res, 400, { error: 'Unsupported status value' });
          return;
        }
        next.status = normalized;
      }

      if (payload.tokenPercent !== undefined) {
        const value = Number(payload.tokenPercent);
        if (!Number.isFinite(value)) {
          sendJson(res, 400, { error: 'tokenPercent must be numeric' });
          return;
        }
        next.tokenPercent = Math.max(0, Math.min(100, Math.round(value)));
      }

      if (payload.detail !== undefined) {
        next.detail = String(payload.detail || '');
      }

      updateState(next);
      sendJson(res, 200, enrichState());
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Bad request' });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    if (bindingManager.getCurrentBindingId() !== 'manual') {
      sendJson(res, 409, {
        error: '当前绑定的是外部 agent，这个内置聊天入口已暂停。请切回“手动 / 内置对话”后再发送。',
        state: enrichState(),
        conversation: getConversationPayload()
      });
      return;
    }

    try {
      const body = await readBody(req);
      const payload = body ? JSON.parse(body) : {};
      const prompt = String(payload.prompt || '').trim();

      if (!prompt) {
        sendJson(res, 400, { error: 'prompt is required' });
        return;
      }

      const result = await runConversationTurn(prompt);
      sendJson(res, 200, {
        ok: true,
        reply: result.text,
        responseId: result.id,
        usage: result.usage,
        provider: process.env.OPENAI_API_KEY ? 'openai' : 'mock',
        conversation: getConversationPayload(),
        state: enrichState()
      });
    } catch (error) {
      sendJson(res, error.statusCode || 500, {
        error: error.message || 'Chat failed',
        state: enrichState(),
        conversation: getConversationPayload()
      });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/conversation/reset') {
    if (bindingManager.getCurrentBindingId() !== 'manual') {
      sendJson(res, 409, {
        error: '当前绑定的是外部 agent，内置会话不可重置。',
        conversation: getConversationPayload(),
        state: enrichState()
      });
      return;
    }

    resetConversation();
    sendJson(res, 200, {
      ok: true,
      conversation: getConversationPayload(),
      state: enrichState()
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/bindings/select') {
    try {
      const body = await readBody(req);
      const payload = body ? JSON.parse(body) : {};
      const bindingId = String(payload.bindingId || '').trim();

      if (!bindingId) {
        sendJson(res, 400, { error: 'bindingId is required' });
        return;
      }

      const active = await bindingManager.selectBinding(bindingId);
      sendJson(res, 200, {
        ok: true,
        active,
        options: bindingManager.getBindings(),
        state: enrichState(),
        conversation: getConversationPayload()
      });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message || 'Binding switch failed' });
    }
    return;
  }

  if (req.method === 'GET') {
    serveStatic(res, url.pathname);
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(port, host, () => {
  refreshSystemMetrics().catch(() => {
    return;
  });
  bindingManager.start();
  setInterval(() => {
    refreshSystemMetrics()
      .then(() => {
        broadcast();
      })
      .catch(() => {
        return;
      });
  }, Number(process.env.PHONE_AGENT_METRICS_MS || 1500));
  console.log('Phone Agent Light running at http://' + host + ':' + port);
  for (const item of getLanUrls()) {
    console.log('LAN: ' + item);
  }
});
