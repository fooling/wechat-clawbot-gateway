# WeChat Channel Gateway - 架构设计

## 设计目标

构建一个极简的微信消息网关。微信作为唯一上游，下游通过 Channel 插件机制对接任意服务。

核心原则：**微信是通道，不是应用。**

## 整体架构

```
                    ┌──────────────────┐
                    │  WeChat iLink    │
                    │  (腾讯网关)       │
                    └────────┬─────────┘
                             │ HTTP long-poll + send
                             │
                    ┌────────▼─────────┐
                    │    WxClient      │
                    │  QR登录/收发消息   │
                    │  凭证持久化        │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │    Gateway       │
                    │  命令路由          │
                    │  全局事件总线       │
                    │  Channel 生命周期  │
                    └────────┬─────────┘
                             │
          ┌──────────┬───────┴───────┬──────────┐
          │          │               │          │
     ┌────▼───┐ ┌───▼────┐   ┌─────▼────┐ ┌───▼────┐
     │  TUI   │ │Webhook │   │   MQTT   │ │  LLM   │
     │系统控制台│ │HTTP接收 │   │ 双向桥接  │ │无状态透传│
     └────────┘ └────────┘   └──────────┘ └────────┘
```

## 运行模式

两种互斥的运行模式，由启动参数决定：

```bash
wechat-gateway              # daemon 模式：无终端交互，适合 systemd
wechat-gateway --tui        # TUI 模式：带终端控制台，手动前台运行
```

| | daemon 模式 | TUI 模式 |
|---|---|---|
| TUI Channel | 不加载 | 加载（系统控制台 + 聊天） |
| 其他 Channel | 正常加载 | 正常加载 |
| 日志输出 | stdout（systemd journal 收集） | TUI 日志面板 |
| 适用场景 | 长期后台运行 | 调试、手动聊天 |

## 核心层

### WxClient

复用 iLink 协议，封装为事件驱动接口。只做两件事：连接微信、收发消息。

```typescript
class WxClient extends EventEmitter {
  // 登录（自动尝试加载已保存凭证，失败则走QR流程）
  login(): Promise<void>

  // 发送文本消息
  send(userId: string, text: string, contextToken?: string): Promise<void>

  // 事件
  on('message', (msg: IncomingMessage) => void)
  on('ready', () => void)
  on('error', (err: Error) => void)
}

interface IncomingMessage {
  userId: string        // 发送者
  text: string          // 消息文本（已解析引用）
  raw: WeixinMessage    // 原始协议消息
}
```

**职责边界：**
- QR 登录 + 凭证持久化（`data/credentials.json`，权限 `0o600`）
- 长轮询收消息（35s 超时，失败指数退避）
- 发送消息（自动管理 context_token）
- 不关心消息内容的含义，不做路由

### Gateway

连接 WxClient 和所有 Channel。管理命令路由、消息分发、全局事件广播。

```typescript
class Gateway extends EventEmitter {
  constructor(wxClient: WxClient, config: GatewayConfig)

  // Channel 注册
  use(channel: Channel): void

  // 启动所有 Channel，开始处理消息
  start(): Promise<void>
  stop(): Promise<void>

  // 全局事件（TUI 和日志系统监听）
  on('log', (entry: LogEntry) => void)
  on('debug', (entry: DebugEntry) => void)
}

interface LogEntry {
  timestamp: number
  source: string          // 'wx', 'tui', 'webhook-transmission', 'deepseek', ...
  direction: 'in' | 'out' // 消息方向：入站/出站
  userId: string
  text: string
}

interface DebugEntry {
  timestamp: number
  channel: string
  detail: string
}
```

**内部机制：**

```
微信消息进入
    │
    ├─ emit('log', { direction: 'in', ... })  ← 全局广播
    │
    ▼
解析命令前缀 (/xxx)
    │
    ├─ 匹配到已注册命令 → 调用对应 Channel handler
    │
    └─ 无匹配 → 调用 default handler（TUI 或丢弃）
    │
    ▼
Channel 返回回复或调用 send
    │
    ├─ emit('log', { direction: 'out', ... })  ← 全局广播
    │
    ▼
WxClient.send()
```

## Channel 接口

每个 Channel 实现一个极简接口：

```typescript
interface Channel {
  readonly name: string

  start(ctx: ChannelContext): Promise<void>
  stop(): Promise<void>
}

interface ChannelContext {
  // 发消息给指定微信用户
  send(userId: string, text: string): Promise<void>

  // 发消息给默认通知用户（配置中指定）
  notify(text: string): Promise<void>

  // 注册命令处理器：微信发 "/cmd args" 时触发
  onCommand(cmd: string, handler: CommandHandler): void

  // 注册默认处理器：无命令前缀的消息触发
  onDefault(handler: MessageHandler): void

  // 发布调试信息
  debug(detail: string): void
}

type CommandHandler = (userId: string, args: string) => Promise<string | void>
type MessageHandler = (userId: string, text: string) => Promise<string | void>
```

**设计要点：**
- Channel 不直接接触 WeChat 协议，只通过 `ChannelContext` 交互
- 返回 `string` 自动回复，返回 `void` 则不回复（Channel 可手动调用 `send`）
- 消息前缀 `[tag]` 由 Channel 自行决定，Gateway 不强制格式
- `notify()` 当前发给单个配置用户，内部实现为 `send(notifyUser, text)`，未来扩展多用户只改此处

## 内置 Channel

### 1. TUI Channel — 系统控制台

仅在 `--tui` 模式下加载。双重身份：全局消息监控 + 聊天窗口。

```
┌─────────────────────────────────────────────┐
│  [log] 全局消息流 + 调试信息                   │
│                                             │
│  09:31 ← wx/张三: 你好                       │
│  09:31 → [tui] 你好                          │
│  09:32 → [webhook-transmission] 任务完成       │
│  09:33 ← wx/张三: /deepseek 黄金价格           │
│  09:33   [debug] llm/deepseek: 请求发送        │
│  09:35 → [deepseek] 黄金和石油...              │
│                                             │
│─────────────────────────────────────────────│
│  wx:connected | channels: 4 | user: 张三     │
│  > 输入消息...                                │
└─────────────────────────────────────────────┘
```

**上方日志区：**
- 监听 Gateway 的 `log` 和 `debug` 事件，实时滚动显示
- 所有 Channel 的出入站消息一览无余
- 颜色区分方向和来源（`←` 入站绿色，`→` 出站蓝色，debug 灰色）

**下方输入区：**
- 注册为 default handler，无命令前缀的微信消息打印到日志区
- 终端输入直接发给微信：`ctx.send(activeUser, "[tui] " + input)`
- `activeUser` 自动跟踪最近发消息的用户

**实现：** Node.js 原生 `readline` + ANSI 转义码，不引入 TUI 框架。

### 2. Webhook Channel

HTTP 服务器，接收外部系统调用，通过模板渲染后转发到微信。单向：外部 → 微信。

```
POST /webhook/transmission
{"name": "ubuntu-24.04.iso", "size": "4.2GB"}
→ 模板 "任务 {{name}} 下载完成（{{size}}）"
→ 微信收到 "[webhook-transmission] 任务 ubuntu-24.04.iso 下载完成（4.2GB）"
```

**模板渲染：**
- 配置文件中为每个 endpoint 定义模板
- 简单 `{{key}}` 字符串替换，不引入模板引擎
- 调用方传 JSON，字段与模板变量对应

**实现：** 原生 `http.createServer`，可选 Bearer token 鉴权。

### 3. MQTT Channel

双向桥接 MQTT 和微信，对接 HomeAssistant 等智能家居系统。可选启用，需外部 broker。

**出站（MQTT → 微信）：**
```
HA 发布 wechat/notify/plain "门已经打开"
→ 微信收到 "[ha] 门已经打开"
```

**入站（微信 → MQTT → HA）：**
```
微信发送 "/ha 打开客厅灯"
→ mqtt.publish("wechat/command", "打开客厅灯")
→ HA 订阅该主题，执行 conversation.process
```

**实现：** `mqtt` 库，纯客户端连接已有 broker。

**HA 侧配置参考：**
```yaml
# configuration.yaml
automation:
  - trigger:
      platform: mqtt
      topic: "wechat/command"
    action:
      - service: conversation.process
        data:
          text: "{{ trigger.payload }}"
```

### 4. LLM Channel

命令触发的无状态 AI 透传。不维护对话历史，每次请求独立。

```
微信发送 "/deepseek 黄金和石油价格有什么联系"
→ 单次调用 DeepSeek API（无上下文）
→ 微信收到 "[deepseek] 黄金和石油价格通常呈现..."
```

- 支持多模型配置，每个模型绑定一个 `/command`
- API Key 通过环境变量引用
- 无对话历史管理，纯请求-响应透传

### 5. OpenClaw Channel

将 Gateway 反向暴露为 OpenClaw 兼容服务端，让外部 AI Agent 框架通过标准协议接入微信。Gateway 变成双向桥梁：既是 iLink 的客户端，也是 OpenClaw 的服务端。

```
外部 AI Agent / 框架
    ↓ OpenClaw 协议（HTTP long-poll + send）
Gateway OpenClaw Server (:9200)
    ↓
微信用户
```

**入站（微信 → Agent）：**
```
微信发送 "/openclaw 帮我查一下明天的天气"
  → Gateway 匹配命令 /openclaw → OpenClaw Channel handler
  → 消息入队，等待 Agent 通过 getupdates 拉取
  → Agent 处理后调用 sendmessage
  → 微信收到 "[openclaw] 明天晴，25°C"
```

**出站（Agent → 微信）：**
```
Agent 主动调用 sendmessage
  → OpenClaw Channel 收到
  → ctx.notify("[openclaw] Agent 主动推送的消息")
  → 微信用户收到
```

**暴露的 HTTP 接口（镜像 iLink 协议格式）：**

```
POST /openclaw/getupdates     ← Agent 长轮询拉取微信消息
POST /openclaw/sendmessage    ← Agent 发送消息到微信
```

- 请求/响应格式复用 iLink 的 `WeixinMessage` 结构，Agent 侧开发体验一致
- 支持 Bearer token 鉴权
- 内部用消息队列缓冲：微信消息入队，Agent poll 时出队

## 配置

单一 YAML 配置文件 `config.yaml`：

```yaml
wechat:
  credentials_path: data/credentials.json
  # 首次收到微信消息时自动记录为默认通知用户
  # 也可手动指定 user id
  notify_user: ""

channels:
  webhook:
    enabled: false
    port: 9100
    token: ""  # 可选鉴权，为空则不校验
    endpoints:
      transmission:
        template: "任务 {{name}} 下载完成"
      doorbell:
        template: "{{message}}"

  mqtt:
    enabled: false
    broker: mqtt://localhost:1883
    username: ""
    password: ""
    subscribe:
      - topic: wechat/notify/plain
        tag: ha
    commands:
      ha:
        topic: wechat/command

  llm:
    deepseek:
      enabled: true
      base_url: https://api.deepseek.com
      model: deepseek-chat
      api_key_env: DEEPSEEK_API_KEY
      system_prompt: "简洁回答问题。"
    gpt:
      enabled: false
      base_url: https://api.openai.com/v1
      model: gpt-4o
      api_key_env: OPENAI_API_KEY
```

**设计决策：**
- 一个文件管所有配置，避免 `.env` + yaml 分裂
- API Key 只记录环境变量名，实际值从环境变量读取
- `enabled: false` 的 Channel 不加载，不引入依赖
- `notify_user` 支持自动捕获：首次收到消息时记录发送者 ID
- TUI 不在配置文件中，由启动参数 `--tui` 控制

## 项目结构

```
src/
├── index.ts                 # 入口：加载配置 → 初始化 → 启动
├── config.ts                # 配置加载与校验
├── core/
│   ├── gateway.ts           # Gateway：事件总线 + 路由 + Channel 生命周期
│   └── wx-client.ts         # WxClient：微信连接（含 auth + long-poll）
├── protocol/
│   └── weixin.ts            # iLink 协议：类型定义 + HTTP 请求封装
└── channels/
    ├── channel.ts           # Channel / ChannelContext 接口定义
    ├── tui.ts               # TUI Channel（系统控制台）
    ├── webhook.ts           # Webhook Channel
    ├── mqtt.ts              # MQTT Channel
    └── llm.ts               # LLM Channel
```

**层级关系：**
```
index.ts → Gateway → WxClient → protocol/weixin.ts
                   → Channel[]  → ChannelContext (Gateway 提供)
```

- `protocol/` 纯协议层，只有类型和 HTTP 函数，无状态
- `core/` 有状态运行时
- `channels/` 各自独立，互不依赖

## 部署

### systemd 服务

```ini
# /etc/systemd/system/wechat-gateway.service
[Unit]
Description=WeChat Channel Gateway
After=network.target

[Service]
Type=simple
User=wechat
WorkingDirectory=/opt/wechat-gateway
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
EnvironmentFile=/opt/wechat-gateway/.env

[Install]
WantedBy=multi-user.target
```

```bash
# .env（仅存放 API Key，不放其他配置）
DEEPSEEK_API_KEY=sk-xxx
OPENAI_API_KEY=sk-xxx
```

**首次部署流程：**
```bash
# 1. 首次用 TUI 模式启动，完成扫码登录
node dist/index.js --tui
# 扫码确认后凭证保存到 data/credentials.json

# 2. 之后用 systemd 后台运行
sudo systemctl enable --now wechat-gateway
```

### 目录规范

```
/opt/wechat-gateway/
├── dist/                    # 编译产物
├── config.yaml              # 运行配置
├── .env                     # API Key（权限 600）
└── data/
    └── credentials.json     # 微信凭证（权限 600）
```

## 消息流详解

### 场景 1：TUI 双向聊天

```
微信用户发送 "今天天气怎么样"
  → WxClient.on('message')
  → Gateway emit('log', { direction: 'in', source: 'wx', ... })
  → 无命令前缀 → TUI.onDefault handler
  → TUI 日志区显示 "← wx/张三: 今天天气怎么样"

终端输入 "晴天，适合出门"
  → TUI 调用 ctx.send(userId, "[tui] 晴天，适合出门")
  → Gateway emit('log', { direction: 'out', source: 'tui', ... })
  → WxClient.send()
  → 微信用户收到 "[tui] 晴天，适合出门"
```

### 场景 2：Transmission → 微信通知

```
POST http://localhost:9100/webhook/transmission
{"name": "ubuntu-24.04.iso", "size": "4.2GB"}

  → Webhook Channel 匹配 endpoint "transmission"
  → 模板渲染："任务 ubuntu-24.04.iso 下载完成"
  → ctx.notify("[webhook-transmission] 任务 ubuntu-24.04.iso 下载完成")
  → Gateway emit('log', ...) → TUI 日志区可见
  → WxClient.send() → 微信用户收到通知
```

### 场景 3：HA → 微信通知

```
HA mqtt.publish("wechat/notify/plain", "前门已打开")
  → MQTT Channel 收到，匹配 subscribe 规则 tag=ha
  → ctx.notify("[ha] 前门已打开")
  → 微信用户收到通知
```

### 场景 4：微信 → HA 控制

```
微信发送 "/ha 打开客厅灯"
  → Gateway 匹配命令 /ha → MQTT Channel handler
  → mqtt.publish("wechat/command", "打开客厅灯")
  → HA automation 触发 → conversation.process
```

### 场景 5：微信 → LLM

```
微信发送 "/deepseek 黄金和石油价格有什么联系"
  → Gateway 匹配命令 /deepseek → LLM Channel handler
  → ctx.debug("请求发送: deepseek-chat")
  → 单次调用 DeepSeek API（无上下文历史）
  → 返回 "[deepseek] 黄金和石油价格通常呈现..."
  → 微信用户收到回复
```

## 扩展新 Channel

实现 `Channel` 接口即可，无需修改 Gateway 代码：

```typescript
// channels/my-channel.ts
import { Channel, ChannelContext } from './channel.js'

export class MyChannel implements Channel {
  name = 'my-channel'

  async start(ctx: ChannelContext) {
    ctx.onCommand('mycmd', async (userId, args) => {
      return `[my-channel] 处理结果: ${args}`
    })

    startSomeService((data) => {
      ctx.notify(`[my-channel] ${data}`)
    })
  }

  async stop() { /* 清理资源 */ }
}
```

注册：
```typescript
gateway.use(new MyChannel())
```

## 安全

| 事项 | 方案 |
|------|------|
| 微信凭证 | `data/credentials.json`，文件权限 `0o600` |
| API Key | `.env` 文件（权限 `0o600`），配置文件只记录变量名 |
| Webhook 鉴权 | 可选 Bearer token，配置了 token 时拒绝无 token 请求 |
| MQTT 认证 | 支持用户名/密码，broker 侧控制 ACL |
| 配置文件 | `config.yaml` 加入 `.gitignore`，提供 `config.example.yaml` |

## 依赖

```json
{
  "dependencies": {
    "openai": "^4.x",           // LLM Channel
    "mqtt": "^5.x",             // MQTT Channel（可选）
    "qrcode-terminal": "^0.12", // QR 码终端显示
    "yaml": "^2.x"              // 配置文件解析
  }
}
```

- Webhook：Node.js 原生 `http`，零依赖
- TUI：Node.js 原生 `readline` + ANSI 转义码，零依赖
- 未启用的 Channel 不需要对应依赖（optional dependencies）

## 启动流程

```typescript
// index.ts 伪代码
const config = loadConfig('config.yaml')
const wx = new WxClient(config.wechat)
await wx.login()

const gateway = new Gateway(wx, config)

// --tui 模式下加载 TUI
if (process.argv.includes('--tui')) {
  gateway.use(new TuiChannel())
}

if (config.channels.webhook?.enabled) gateway.use(new WebhookChannel(config.channels.webhook))
if (config.channels.mqtt?.enabled)    gateway.use(new MqttChannel(config.channels.mqtt))
for (const [name, cfg] of Object.entries(config.channels.llm ?? {})) {
  if (cfg.enabled) gateway.use(new LlmChannel(name, cfg))
}

await gateway.start()

process.on('SIGINT',  () => gateway.stop())
process.on('SIGTERM', () => gateway.stop())
```
