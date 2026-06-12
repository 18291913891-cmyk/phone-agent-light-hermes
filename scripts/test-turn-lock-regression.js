const fs = require('fs');
const os = require('os');
const path = require('path');
const child_process = require('child_process');
const http = require('http');

const root = 'D:/APPdata/Hermesworkplays/phone-agent-light';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-agent-regression-'));
const agentLog = path.join(tmp, 'agent.log');
const gatewayLog = path.join(tmp, 'gateway.log');
const liveState = path.join(tmp, 'agent_live_state.json');
fs.writeFileSync(agentLog, '');
fs.writeFileSync(gatewayLog, '');

let posts = [];
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/hermes-state') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { posts.push(JSON.parse(body)); } catch (e) {}
      res.writeHead(200, {'content-type':'application/json'});
      res.end('{"ok":true}');
    });
    return;
  }
  res.writeHead(404); res.end();
});

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function append(line) { fs.appendFileSync(agentLog, line + '\n'); }

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const child = child_process.spawn(process.execPath, ['scripts/hermes-log-state-bridge.js'], {
    cwd: root,
    env: {
      ...process.env,
      HERMES_AGENT_LOG: agentLog,
      HERMES_GATEWAY_LOG: gatewayLog,
      PHONE_AGENT_LIVE_STATE_PATH: liveState,
      AGENT_LIGHT_URL: `http://127.0.0.1:${port}`,
      HERMES_STATE_BRIDGE_POLL_MS: '50'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await sleep(200);
  append("2026-06-12 17:00:00,000 - agent.conversation_loop: conversation turn: msg='你好'");
  await sleep(120);
  append('2026-06-12 17:00:01,000 - agent.conversation_loop: API call #1: latency=1s');
  await sleep(120);
  append('2026-06-12 17:00:02,000 - agent.conversation_loop: Turn ended: ok');
  await sleep(120);
  append('2026-06-12 17:00:03,000 - agent.conversation_loop: API call #2: latency=1s');
  append('2026-06-12 17:00:04,000 - agent.tool_executor: tool terminal completed');
  await sleep(300);
  child.kill();
  server.close();
  const final = JSON.parse(fs.readFileSync(liveState, 'utf8'));
  const statuses = posts.map(p => p.status);
  const lastDoneIndex = statuses.lastIndexOf('DONE');
  const activeAfterDone = lastDoneIndex >= 0
    ? statuses.slice(lastDoneIndex + 1).filter(s => s === 'THINKING' || s === 'RUNNING')
    : [];
  console.log(JSON.stringify({finalStatus: final.status, finalDetail: final.detail, postedStatuses: statuses}, null, 2));
  if (final.status !== 'DONE') process.exit(2);
  if (activeAfterDone.length) process.exit(3);
})();
