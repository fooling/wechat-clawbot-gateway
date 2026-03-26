# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

wechat-gateway is a WeChat message gateway. WeChat is the transport layer — downstream services connect via pluggable Channel modules. Uses Tencent's iLink HTTP API directly, no framework required.

## Commands

```bash
npm run dev              # TUI mode (default --tui): interactive terminal
npm run build            # Compile TypeScript to dist/
npm start                # Daemon mode: logs to stdout (systemd)
npm run dev -- --logout  # Clear saved credentials and re-login
```

No test framework is configured.

## Architecture

```
WxClient (iLink long-poll) → Gateway (router + event bus) → Channel[]
```

**Two run modes:** `--tui` (interactive terminal) or daemon (systemd journal).

### Core Layer

- **`src/protocol/weixin.ts`** — iLink protocol: type definitions + HTTP functions. Enums: MessageType, MessageItemType, MessageState. Functions: fetchQRCode, pollQRStatus, getUpdates, sendTextMessage, extractTextFromMessage. Network retry built-in (5 attempts, 3s delay).

- **`src/core/wx-client.ts`** — `WxClient` (EventEmitter). QR login + credential persistence (`data/credentials.json`, 0o600). Long-poll loop with exponential backoff. Auto-manages contextTokens for reply threading. Events: `message`, `ready`, `error`.

- **`src/core/gateway.ts`** — `Gateway` (EventEmitter). Command routing (`/cmd args`), default handler fallback, notifyUser auto-capture (persisted to `data/notify_user`). Creates ChannelContext per channel. Events: `log`, `debug`.

- **`src/config.ts`** — YAML config loader. `loadConfig('config.yaml')` → `GatewayConfig`. Missing file → all defaults. Typed interfaces for all channel configs.

### Channel Layer

- **`src/channels/channel.ts`** — Interface definitions: `Channel`, `ChannelContext`, `CommandHandler`, `MessageHandler`, `LogEntry`, `DebugEntry`.

- **`src/channels/tui.ts`** — TUI Channel. readline + ANSI colors. Subscribes to all gateway log/debug events. Terminal input sends to activeUser (auto-tracked).

- **`src/channels/webhook.ts`** — Webhook Channel. `http.createServer` on configurable port. `POST /webhook/:endpoint` → template rendering (`{{key}}`) → `ctx.notify()`. Optional Bearer token auth.

- **`src/channels/mqtt.ts`** — MQTT Channel. Bidirectional bridge. Subscribe topics → WeChat notify. WeChat `/cmd` → MQTT publish. Auto-reconnect via mqtt library.

- **`src/channels/llm.ts`** — LLM Channel. Each model = separate instance with its own `/command`. Stateless single request-response via OpenAI SDK. API key from env var.

- **`src/channels/openclaw.ts`** — OpenClaw Channel. HTTP server mirroring iLink protocol. `POST /openclaw/getupdates` (long-poll) + `POST /openclaw/sendmessage`. Internal message queue. Bearer token auth required.

- **`src/index.ts`** — Entry point. Loads config → WxClient login → Gateway → register channels from config → start. Graceful shutdown on SIGINT/SIGTERM.

### State Management

| State | Storage | Scope |
|---|---|---|
| Login credentials | Disk: `data/credentials.json` | Persists across restarts |
| Notify user | Disk: `data/notify_user` | Persists (auto-captured) |
| Context tokens (reply threading) | In-memory Map | Lost on restart |
| Long-poll buffer | In-memory | Refreshed each poll |
| OpenClaw message queue | In-memory | Lost on restart |

## Configuration

Primary config: `config.yaml` (see `config.example.yaml`). API keys only in `.env`.

```yaml
wechat:
  credentials_path: data/credentials.json
  notify_user: ""          # auto-captured from first message

channels:
  webhook:                 # HTTP endpoint → WeChat notify
    enabled: false
    port: 9100
  mqtt:                    # Bidirectional MQTT bridge
    enabled: false
    broker: mqtt://localhost:1883
  llm:                     # Per-model stateless AI
    deepseek:
      enabled: false
      api_key_env: DEEPSEEK_API_KEY
  openclaw:                # iLink-compatible server for agents
    enabled: false
    port: 9200
```

## Tech Stack

- **Runtime:** Node.js >= 22
- **Language:** TypeScript 5.8 (ES2022 target, Node16 module resolution, strict mode)
- **Dependencies:** `qrcode-terminal`, `yaml`, `mqtt`, `openai`

## Deployment

```bash
# First: TUI mode to scan QR
node dist/index.js --tui

# Then: systemd daemon
sudo systemctl enable --now wechat-gateway
```

See `deploy/wechat-gateway.service` and `deploy/install.sh`.
