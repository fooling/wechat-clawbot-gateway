# wechat-gateway

[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![WeChat](https://img.shields.io/badge/WeChat-iLink_API-07C160?logo=wechat&logoColor=white)](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)
[![License](https://img.shields.io/badge/License-MIT-blue)](./LICENSE)

极简微信消息网关。微信作为通道，下游通过 Channel 插件对接任意服务。

## 特性

- **Gateway + Channel 插件架构** — 微信是通道，不是应用
- **TUI 终端控制台** — 实时消息监控 + 手动聊天
- **Webhook** — 外部系统 HTTP 调用 → 微信通知（Transmission、门铃等）
- **MQTT 双向桥接** — 对接 HomeAssistant 等智能家居
- **LLM 无状态透传** — 命令触发的 AI 单次问答（DeepSeek、GPT 等）
- **OpenClaw 服务端** — 暴露 iLink 兼容接口，让外部 Agent 接入微信
- **扫码即用** — 凭证持久化，重启无需重新扫码

## 快速开始

```bash
npm install
cp config.example.yaml config.yaml  # 编辑配置
npm run dev                          # TUI 模式，首次扫码登录
```

## 运行模式

```bash
npm run dev              # TUI 模式（开发/调试）
npm start                # Daemon 模式（systemd 后台运行）
npm run dev -- --logout  # 清除凭证重新登录
```

## 配置

主配置文件 `config.yaml`（参考 `config.example.yaml`）：

```yaml
wechat:
  credentials_path: data/credentials.json
  notify_user: ""          # 留空自动捕获首条消息发送者

channels:
  webhook:
    enabled: false
    port: 9100
    token: ""
    endpoints:
      transmission:
        template: "任务 {{name}} 下载完成（{{size}}）"

  mqtt:
    enabled: false
    broker: mqtt://localhost:1883
    subscribe:
      - topic: wechat/notify/plain
        tag: ha
    commands:
      ha:
        topic: wechat/command

  llm:
    deepseek:
      enabled: false
      base_url: https://api.deepseek.com
      model: deepseek-chat
      api_key_env: DEEPSEEK_API_KEY
      system_prompt: "简洁回答问题。"

  openclaw:
    enabled: false
    port: 9200
    token: "my-secret"
```

API Key 放在 `.env` 文件中（参考 `.env.example`）。

## 架构

```
WeChat User → iLink Gateway ↔ WxClient (long-poll)
                                  ↓
                              Gateway (路由 + 事件总线)
                                  ↓
              ┌─────────┬────────┬────────┬──────────┐
              TUI    Webhook   MQTT     LLM    OpenClaw
```

## 项目结构

```
src/
├── index.ts                 # 入口
├── config.ts                # YAML 配置加载
├── core/
│   ├── gateway.ts           # 事件总线 + 命令路由 + Channel 生命周期
│   └── wx-client.ts         # 微信连接（QR登录 + long-poll + 发消息）
├── protocol/
│   └── weixin.ts            # iLink 协议（类型 + HTTP 函数）
└── channels/
    ├── channel.ts           # Channel / ChannelContext 接口定义
    ├── tui.ts               # TUI 终端控制台
    ├── webhook.ts           # Webhook（HTTP → 微信通知）
    ├── mqtt.ts              # MQTT 双向桥接
    ├── llm.ts               # LLM 无状态透传
    └── openclaw.ts          # OpenClaw 服务端
```

## 开发自定义 Channel

实现 `Channel` 接口即可扩展新功能，无需修改 Gateway 代码。

### 接口定义

```typescript
interface Channel {
  readonly name: string;
  start(ctx: ChannelContext): Promise<void>;
  stop(): Promise<void>;
}
```

### ChannelContext API

Gateway 在启动时为每个 Channel 创建独立的 `ChannelContext`：

| 方法 | 说明 |
|------|------|
| `send(userId, text)` | 发消息给指定微信用户 |
| `notify(text)` | 发消息给默认通知用户（配置或自动捕获） |
| `onCommand(cmd, handler)` | 注册命令：微信发 `/cmd args` 时触发 |
| `onDefault(handler)` | 注册默认处理器：无命令前缀的消息触发 |
| `debug(detail)` | 发布调试信息（TUI 会显示） |
| `onLog(handler)` | 订阅全局消息日志（入站/出站） |
| `onDebug(handler)` | 订阅全局调试信息 |

### Handler 返回值约定

```typescript
type CommandHandler = (userId: string, args: string) => Promise<string | void>;
type MessageHandler = (userId: string, text: string) => Promise<string | void>;
```

- 返回 `string` → Gateway 自动发送给用户作为回复
- 返回 `void` → 不自动回复（Channel 可手动调用 `ctx.send()`）

### 完整示例

```typescript
// src/channels/my-channel.ts
import type { Channel, ChannelContext } from "./channel.js";

export class MyChannel implements Channel {
  readonly name = "my-channel";

  async start(ctx: ChannelContext): Promise<void> {
    // 注册 /mycmd 命令
    ctx.onCommand("mycmd", async (userId, args) => {
      ctx.debug(`收到命令: ${args}`);
      return `[my-channel] 处理结果: ${args}`;
    });

    // 也可以主动推送
    setInterval(() => {
      ctx.notify("[my-channel] 定时通知");
    }, 60_000);
  }

  async stop(): Promise<void> {
    // 清理资源
  }
}
```

### 注册 Channel

在 `src/index.ts` 中添加：

```typescript
import { MyChannel } from "./channels/my-channel.js";

// 在 gateway.start() 之前
gateway.use(new MyChannel());
```

如果需要配置驱动，在 `src/config.ts` 中添加对应的配置接口，然后在 `index.ts` 中按 `enabled` 字段条件注册。

### 设计要点

- Channel 不直接接触微信协议，只通过 `ChannelContext` 交互
- 命令名全局唯一，重复注册会 throw
- `onDefault` 全局只能注册一个（当前由 TUI 占用）
- 消息前缀 `[tag]` 由 Channel 自行决定，Gateway 不强制格式
- `notify()` 发给 `config.wechat.notify_user`（或自动捕获的用户）

## 部署

```bash
# 1. 首次 TUI 模式扫码
node dist/index.js --tui

# 2. systemd 后台运行
sudo cp deploy/wechat-gateway.service /etc/systemd/system/
sudo systemctl enable --now wechat-gateway
```

详见 `deploy/install.sh`。

## 协议说明

本项目使用腾讯官方 OpenClaw 微信渠道的公开 HTTP API 协议（`ilink/bot/*`），通过扫码授权方式合法接入微信。

## License

MIT
