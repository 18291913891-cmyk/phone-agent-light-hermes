# Phone Agent Light

Turn an old phone or a spare screen into a calm always-on status display for a local AI agent.

This fork focuses on a low-latency Hermes Agent status screen with a portrait phone UI, SSE updates, a live-state API, and a simple human-level state machine:

```text
Idle → Thinking → Running → Done/Error → Idle
```

Chinese portrait mode labels:

```text
待机摸鱼 → 努力思考中 → 拼命干活中 → 终于完成了 / 出错了
```

## What is different in this version

This version is tuned for a local Hermes Agent workflow:

- portrait phone display at `display.html`
- default port `8790` to avoid common local AI dashboard conflicts
- `POST /api/hermes-state` for direct agent status pushes
- `GET /api/events` Server-Sent Events for live updates
- Hermes live-state snapshot support through `~/.hermes/agent_live_state.json`
- log bridge fallback via `scripts/hermes-log-state-bridge.js`
- frontend monotonic state machine: no accidental idle while an agent is still working
- final state is only accepted from a real turn boundary, not from intermediate tool/API events
- dark pixel-character portrait UI with multiple skins

Full design notes: [docs/DESIGN.md](docs/DESIGN.md)

## Screenshots

### Phone display

![Phone Agent Light running on an Android phone](docs/product-display.jpg)

### Portrait display

![Phone Agent Light portrait display](docs/product-display-2.jpg)

### Control panel

![Phone Agent Light control panel](docs/control-panel.png)

## Quick start

You need Node.js 18+.

```bash
git clone https://github.com/YOUR_NAME/phone-agent-light-hermes.git
cd phone-agent-light-hermes
cp .env.example .env
npm start
```

Open on the host computer:

```text
http://127.0.0.1:8790/
```

Open on the phone, replacing the IP with your computer's LAN IP:

```text
http://YOUR_COMPUTER_LAN_IP:8790/display.html
```

The phone and computer must be on the same LAN/Wi-Fi.

## Environment

Example `.env`:

```env
HOST=0.0.0.0
PORT=8790
DEFAULT_PAGE=display.html
AGENT_LIGHT_URL=http://127.0.0.1:8790

# Optional local-agent integrations. These read private local files.
ENABLE_HERMES_BINDING=0
ENABLE_CODEX_BINDING=0

# Optional chat mode. Leave empty for mock mode.
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini
OPENAI_BASE_URL=https://api.openai.com/v1
```

`.env` is ignored by git. Do not commit local tokens, private paths, logs, or live-state snapshots.

## Running with Hermes logs only

If you do not have direct Hermes hooks, you can still use the log bridge fallback:

```bash
PORT=8790 DEFAULT_PAGE=display.html ENABLE_HERMES_BINDING=1 npm start
```

In another terminal:

```bash
AGENT_LIGHT_URL=http://127.0.0.1:8790 node scripts/hermes-log-state-bridge.js
```

The bridge tails Hermes logs and posts status updates to `/api/hermes-state`.

## Recommended low-latency Hermes integration

For the best experience, push state directly from Hermes lifecycle events.

Recommended event contract:

| Event | Display state | Meaning |
|---|---:|---|
| `gateway/inbound` | `THINKING` | Gateway accepted an inbound message |
| `pre_turn` | `THINKING` | Agent turn started |
| `pre_llm_call` / `pre_api_request` | `THINKING` | Model request starting |
| `pre_tool_call` | `RUNNING` | Tool execution starting |
| `post_tool_call` | `RUNNING` | Tool finished, but turn may continue |
| `post_api_request` / `post_llm_call` | progress only | Not a final state |
| `post_turn` | `DONE` / `ERROR` | Final user-facing turn result |

Important rule:

```text
Only post_turn should publish terminal DONE/ERROR.
```

A minimal payload:

```bash
curl -X POST http://127.0.0.1:8790/api/hermes-state \
  -H 'Content-Type: application/json' \
  -d '{
    "status": "THINKING",
    "detail": "收到消息，马上处理",
    "updatedAt": "2026-01-01T00:00:00.000Z",
    "task": { "active": true, "label": "THINKING" },
    "runtime": { "source": "gateway/inbound" }
  }'
```

## Frontend state machine

The display intentionally smooths noisy backend events.

Rules:

```text
IDLE → THINKING → RUNNING → DONE/ERROR → IDLE
```

- once `THINKING` or `RUNNING` starts, the display does not return to `IDLE` because of silence
- `RUNNING` does not regress to `THINKING` in the same turn
- `DONE/ERROR` is held for 3 minutes
- repeated old terminal snapshots are consumed so the display does not flicker
- a new active turn clears the previous terminal state

This is why the display feels like a stable status light instead of a log viewer.

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | default page, usually `display.html` |
| `GET` | `/display.html` | portrait phone display |
| `GET` | `/api/state` | current state snapshot |
| `GET` | `/api/events` | SSE stream |
| `POST` | `/api/hermes-state` | external status push |
| `GET` | `/api/bindings` | available local-agent bindings |
| `POST` | `/api/bindings/select` | switch local-agent binding |

## Manual status updates

```bash
npm run send -- THINKING
npm run send -- RUNNING
npm run send -- DONE
npm run send -- ERROR
```

## Optional Android WebView shell

The included Android shell is a minimal fullscreen WebView wrapper.

```bash
npm run android:build
```

The APK is written to:

```text
android-shell/dist/phone-focus-shell.apk
```

Browser mode is easier and should be tested first.

## Privacy and security

This project is meant for local LAN use.

Do not expose it directly to the public internet.

Local-agent integrations may read:

```text
~/.hermes/logs/agent.log
~/.hermes/logs/gateway.log
~/.hermes/agent_live_state.json
~/.codex/sessions/**/*.jsonl
```

These files may contain prompts, local paths, tool outputs, or private messages. Keep bindings disabled unless you understand the privacy impact.

## Project structure

```text
server.js                         HTTP server, state API, SSE
lib/agent-bindings.js             local-agent adapters and live-state snapshot
scripts/hermes-log-state-bridge.js Hermes log bridge fallback
public/display.html               portrait phone page
public/display.js                 frontend state machine
public/display.css                portrait visual style
public/index.html                 desktop control panel
android-shell/                    optional Android WebView shell
docs/DESIGN.md                    architecture and state logic
```

## License

MIT. See [LICENSE](LICENSE).

This repository is based on the original Phone Agent Light idea and adapted for a Hermes Agent low-latency status-display workflow.
