# wechat-gateway

[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![WeChat](https://img.shields.io/badge/WeChat-iLink_API-07C160?logo=wechat&logoColor=white)](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)
[![License](https://img.shields.io/badge/License-MIT-blue)](./LICENSE)

极简微信消息网关。微信作为通道，下游通过 Channel 插件对接任意服务。

## 特性

- **Gateway + Channel 插件架构** — 微信是通道，不是应用
- **多媒体消息** — 接收图片/语音(自动转文字)/文件/视频；发送图片/文件
- **TUI 终端控制台** — 实时消息监控 + 手动聊天
- **Webhook** — 外部系统 HTTP 调用 → 微信通知（HA、QNAP、Transmission 等）
- **MQTT 双向桥接** — 对接 HomeAssistant 等智能家居
- **LLM 无状态透传** — 命令触发的 AI 单次问答（DeepSeek、GPT 等）
- **IFTTT 双向自动化** — 微信触发 IFTTT Applet / IFTTT 推送到微信
- **OpenClaw 服务端** — 暴露 iLink 兼容接口，让外部 Agent 接入微信
- **扫码即用** — 凭证持久化，重启无需重新扫码
- **失败消息恢复（可选）** — 主动推送 ret=-2 等业务失败时持久化入队，用户下次发消息后自动回放

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
  # 默认: ~/.wechat-gateway/credentials.json
  # credentials_path: ~/.wechat-gateway/credentials.json
  # 默认: ~/.wechat-gateway/context_tokens.json（per-user iLink 推送锚点，主动推送必需）
  # context_tokens_path: ~/.wechat-gateway/context_tokens.json
  notify_user: ""                      # 留空自动捕获首条消息发送者
  failed_messages_enabled: false       # 主动推送 ret=-2 时入队，下次该用户发消息后回放
  # failed_messages_path: ~/.wechat-gateway/failed_messages

channels:
  webhook:
    enabled: false
    port: 9100
    token: ""              # 留空不校验鉴权
    endpoints:
      ha:                  # HomeAssistant notify 通用接口
        template: "{{message}}"
      qnap:                # QNAP Notification Center（自定义 SMS）
        template: "{{msg}}"
      transmission:        # Transmission 下载完成回调
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

  ifttt:
    enabled: false
    key: "your-ifttt-webhooks-key"
```

API Key 放在 `.env` 文件中（参考 `.env.example`）。
配置文件查找顺序：`./config.yaml` → `/etc/wechat-gateway/config.yaml`。

### 失败消息恢复（可选）

iLink 主动推送的 `sendmessage` 在 token 失效或服务端校验未通过时会返回 HTTP 200 + `{"ret":-2}` **静默丢消息**。开启 `failed_messages_enabled: true` 后：

- 任何 ret != 0 的发送失败会把整条消息（包括 image/file 的 CDN 引用）序列化到 `failed_messages_path` 目录，文件名 `{timestamp}-{userId}-{rand}.json`。
- 下一次该用户发来 IN 消息（`context_token` 自动刷新）时，立即按时间戳顺序回放队列；任一条仍失败则停止本轮、保留文件、累加 `attempts`，等下一次 IN 触发再试。
- 队列与 `~/.wechat-gateway/context_tokens.json` 共用同一目录、各自独立文件，对内容不会互相污染。
- 默认关闭。已知局限：图片/文件依赖远端 CDN TTL，长期堆积可能在回放时拿到 CDN 失效错误——必要时手工清理 `failed_messages_path` 即可。

## 架构

```
WeChat User → iLink Gateway ↔ WxClient (long-poll)
                                  ↓
                              Gateway (路由 + 事件总线)
                                  ↓
         ┌───────┬────────┬──────┬──────┬─────────┬───────┐
         TUI  Webhook   MQTT   LLM   IFTTT   OpenClaw
```

## Channel 使用指南

### TUI — 终端控制台

仅在 `--tui` 模式下加载。实时显示所有消息流 + 终端手动聊天。

**终端界面：**

```
09:31 <- wx/张三: 你好                              ← 绿色，微信入站
09:31 -> [tui] 你好呀                               ← 蓝色，TUI 出站
09:32 -> [webhook-transmission] 任务下载完成          ← 蓝色，其他 Channel 出站
09:33   [debug] mqtt: broker connected              ← 灰色，调试信息
[wx:ok | 张三] > _                                   ← 输入区
```

**微信 → 终端：**

```
微信聊天框输入：你好
  → 终端显示：09:31 <- wx/张三: 你好
```

所有微信消息（包括命令）都会显示在终端日志区，无论是否被其他 Channel 处理。

**终端 → 微信：**

```
终端输入：晴天，适合出门
  → 微信聊天框收到：[tui] 晴天，适合出门
```

自动发给最近发过消息的用户（`activeUser`）。

---

### Webhook — HTTP 通知转发

外部系统通过 HTTP GET/POST 发送数据，经模板渲染后转发到微信。**单向：外部 → 微信。** 支持 JSON body 和 URL query 参数（兼容 QNAP 自定义 SMS 等）。

**配置示例：**

```yaml
channels:
  webhook:
    enabled: true
    port: 9100
    token: "my-secret"    # 留空则不校验
    endpoints:
      ha:
        template: "{{message}}"
      qnap:
        template: "{{msg}}"
      transmission:
        template: "任务 {{name}} 下载完成（{{size}}）"
```

**外部系统 → 微信：**

```bash
# 通用消息（HomeAssistant / curl / 任意 HTTP 客户端）
curl -X POST http://localhost:9100/webhook/ha \
  -H "Authorization: Bearer my-secret" \
  -H "Content-Type: application/json" \
  -d '{"message": "前门已打开"}'
```

```
微信聊天框收到：[webhook-ha] 前门已打开
```

```bash
# Transmission 下载完成回调
curl -X POST http://localhost:9100/webhook/transmission \
  -H "Authorization: Bearer my-secret" \
  -H "Content-Type: application/json" \
  -d '{"name": "ubuntu-24.04.iso", "size": "4.2GB"}'
```

```
微信聊天框收到：[webhook-transmission] 任务 ubuntu-24.04.iso 下载完成（4.2GB）
```

```bash
# QNAP Notification Center（自定义 SMS 提供商，GET + query 参数）
# QNAP URL模板: http://<ip>:9100/webhook/qnap?msg=@@Text@@&phone=@@PhoneNumber@@
curl "http://localhost:9100/webhook/qnap?msg=磁盘温度过高&phone=10086"
```

```
微信聊天框收到：[webhook-qnap] 磁盘温度过高
```

**模板语法：** `{{key}}` 会被 JSON body 或 URL query 参数中对应字段的值替换。支持 GET 和 POST。

**HTTP 响应：**

| 状态码 | 含义 |
|--------|------|
| 200 `{"ok": true}` | 发送成功 |
| 400 | JSON 解析失败 |
| 401 | token 不匹配 |
| 404 | endpoint 不存在 |
| 405 | 非 POST 方法 |

**HomeAssistant 对接：**

在 HA 的 `configuration.yaml` 中添加，即可获得 `notify.wechat` 服务：

```yaml
# 方式一：notify 平台（推荐，像 Pushbullet 一样用）
notify:
  - platform: rest
    name: wechat
    resource: http://localhost:9100/webhook/ha
    method: POST_JSON
    headers:
      Authorization: "Bearer my-secret"
    data:
      message: "{{ message }}"
```

重启 HA 后，自动化直接调用：

```yaml
automation:
  - alias: "门窗告警"
    trigger:
      - platform: state
        entity_id: binary_sensor.front_door
        to: "on"
    action:
      - service: notify.wechat
        data:
          message: "前门已打开"
```

也可以在 HA 的 **开发者工具 → 服务** 中搜索 `notify.wechat`，手动发消息测试。

---

### MQTT — 双向桥接

对接 HomeAssistant 等智能家居系统。支持 MQTT → 微信通知 和 微信 → MQTT 命令。

**配置示例：**

```yaml
channels:
  mqtt:
    enabled: true
    broker: mqtt://192.168.1.100:1883
    username: "ha"
    password: "secret"
    subscribe:
      - topic: wechat/notify/plain
        tag: ha
    commands:
      ha:
        topic: wechat/command
```

**MQTT → 微信（外部设备发通知）：**

```bash
# HomeAssistant 发布 MQTT 消息
mosquitto_pub -t wechat/notify/plain -m "前门已打开"
```

```
微信聊天框收到：[ha] 前门已打开
```

可以在 HA 自动化中配置：门窗传感器触发 → 发 MQTT → 微信收到通知。

**微信 → MQTT（手机控制设备）：**

```
微信聊天框输入：/ha 打开客厅灯
  → 微信聊天框收到回复：[ha] 已发送
  → MQTT broker 收到：topic=wechat/command, payload="打开客厅灯"
```

HA 侧订阅 `wechat/command` 并配合 `conversation.process` 即可实现自然语言控制：

```yaml
# HA configuration.yaml
automation:
  - trigger:
      platform: mqtt
      topic: "wechat/command"
    action:
      - service: conversation.process
        data:
          text: "{{ trigger.payload }}"
```

---

### LLM — 无状态 AI 透传

命令触发的 AI 单次问答。每个模型注册一个 `/命令`，无对话历史，每次请求独立。

**配置示例：**

```yaml
channels:
  llm:
    deepseek:
      enabled: true
      base_url: https://api.deepseek.com
      model: deepseek-chat
      api_key_env: DEEPSEEK_API_KEY      # 从 .env 读取
      system_prompt: "简洁回答问题。"
    gpt:
      enabled: true
      base_url: https://api.openai.com/v1
      model: gpt-4o
      api_key_env: OPENAI_API_KEY
      system_prompt: ""
```

**微信 → AI → 微信：**

```
微信聊天框输入：/deepseek 黄金和石油价格有什么联系
  → 微信聊天框收到：[deepseek] 黄金和石油价格通常呈现正相关关系...
```

```
微信聊天框输入：/gpt 翻译成英文：今天天气很好
  → 微信聊天框收到：[gpt] The weather is very nice today.
```

```
微信聊天框输入：/deepseek
  → 微信聊天框收到：[deepseek] 请输入问题
```

每个模型独立，互不影响。同一个用户连续发的两条消息之间没有上下文关联。

---

### IFTTT — 双向自动化

微信触发 IFTTT Applet，或 IFTTT 事件推送到微信。

**配置示例：**

```yaml
channels:
  # 出站：微信 → IFTTT（/ifttt 命令触发 Maker Webhooks）
  ifttt:
    enabled: true
    key: "your-ifttt-webhooks-key"    # https://ifttt.com/maker_webhooks → Documentation

  # 入站：IFTTT → 微信（通过 Webhook channel 接收）
  webhook:
    enabled: true
    port: 9100
    endpoints:
      ifttt:
        template: "{{message}}"
```

**微信 → IFTTT（触发 Applet）：**

```
微信聊天框输入：/ifttt scene_arrived_home
  → 微信聊天框收到：[ifttt] 已触发: scene_arrived_home
  → IFTTT Maker Webhooks 收到 trigger，执行关联的 Applet
```

```
微信聊天框输入：/ifttt send_note 记得买牛奶
  → 微信聊天框收到：[ifttt] 已触发: send_note
  → IFTTT 收到 event=send_note, value1="记得买牛奶"
```

```
微信聊天框输入：/ifttt
  → 微信聊天框收到：[ifttt] 用法: /ifttt <event> [message]
```

IFTTT 侧创建 Applet：**If** Webhooks (Receive a web request) → event name 填对应的事件名 → **Then** 执行动作。

**IFTTT → 微信（Applet 推送通知）：**

在 IFTTT Applet 的 **Then** 动作中选 Webhooks (Make a web request)：

| 字段 | 值 |
|------|-----|
| URL | `http://<your-ip>:9100/webhook/ifttt` |
| Method | POST |
| Content Type | application/json |
| Body | `{"message": "{{EventName}} triggered"}` |

```
IFTTT Applet 触发 → POST 到 webhook
  → 微信聊天框收到：[webhook-ifttt] weather_alert triggered
```

---

### OpenClaw — Agent 接入服务端

将 Gateway 反向暴露为 OpenClaw 兼容 HTTP 接口，让外部 AI Agent 框架通过标准协议接入微信。

**配置示例：**

```yaml
channels:
  openclaw:
    enabled: true
    port: 9200
    token: "my-agent-token"    # 必须配置
```

**微信 → Agent（用户发消息给 Agent）：**

```
微信聊天框输入：/openclaw 帮我查一下明天的天气
  → 消息进入 OpenClaw 内部队列（微信不会立即收到回复）
  → 等待 Agent 处理后回复
```

Agent 通过 HTTP 拉取消息：

```bash
# Agent 长轮询拉取（最长等 30s）
curl -X POST http://localhost:9200/openclaw/getupdates \
  -H "Authorization: Bearer my-agent-token" \
  -H "Content-Type: application/json" \
  -d '{}'

# 响应（有消息时立即返回，无消息等 30s 后返回空）：
{
  "ret": 0,
  "msgs": [{
    "from_user_id": "o9cq8...",
    "message_type": 1,
    "item_list": [{"type": 1, "text_item": {"text": "帮我查一下明天的天气"}}]
  }]
}
```

**Agent → 微信（Agent 回复用户）：**

```bash
# Agent 处理完毕，发送回复
curl -X POST http://localhost:9200/openclaw/sendmessage \
  -H "Authorization: Bearer my-agent-token" \
  -H "Content-Type: application/json" \
  -d '{
    "msg": {
      "to_user_id": "o9cq8...",
      "item_list": [{"type": 1, "text_item": {"text": "明天晴，25°C"}}]
    }
  }'
```

```
微信聊天框收到：[openclaw] 明天晴，25°C
```

Agent 也可以主动推送（省略 `to_user_id` 则发给默认通知用户）：

```bash
curl -X POST http://localhost:9200/openclaw/sendmessage \
  -H "Authorization: Bearer my-agent-token" \
  -H "Content-Type: application/json" \
  -d '{"msg": {"item_list": [{"type": 1, "text_item": {"text": "定时任务完成"}}]}}'
```

```
微信聊天框收到：[openclaw] 定时任务完成
```

---

## 项目结构

```
src/
├── index.ts                 # 入口
├── config.ts                # YAML 配置加载
├── core/
│   ├── gateway.ts                # 事件总线 + 命令路由 + Channel 生命周期
│   ├── wx-client.ts              # 微信连接（QR登录 + long-poll + 发消息）
│   ├── context-token-store.ts    # 每用户 iLink context_token 持久化
│   └── failed-message-store.ts   # 失败消息持久化队列 + 回放（可选）
├── protocol/
│   └── weixin.ts            # iLink 协议（类型 + HTTP 函数）
└── channels/
    ├── channel.ts           # Channel / ChannelContext 接口定义
    ├── tui.ts               # TUI 终端控制台
    ├── webhook.ts           # Webhook（HTTP → 微信通知）
    ├── mqtt.ts              # MQTT 双向桥接
    ├── llm.ts               # LLM 无状态透传
    ├── ifttt.ts             # IFTTT 双向自动化
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

### 注册 systemd 服务

```bash
# 1. 首次扫码登录
npm run dev

# 2. 一键注册 daemon（自动编译 + 安装 systemd 服务）
npm run setup-service

# 3. 启动
sudo systemctl start wechat-gateway
```

`setup-service` 会自动检测当前目录、Node 路径和用户，生成 service 文件并注册到 systemd。

**常用命令：**

```bash
sudo systemctl start wechat-gateway      # 启动
sudo systemctl stop wechat-gateway       # 停止
sudo systemctl restart wechat-gateway    # 重启
sudo systemctl status wechat-gateway     # 状态
journalctl -u wechat-gateway -f          # 查看日志
```

### 生产部署（独立目录）

如果需要部署到独立目录（如 `/opt/wechat-gateway`），使用安装脚本：

```bash
npm run build
sudo bash deploy/install.sh
```

脚本会自动：创建 `wechat` 系统用户 → 复制编译产物到 `/opt/wechat-gateway` → 安装生产依赖 → 注册 systemd 服务。安装后按提示编辑配置、扫码、启动。

## 协议说明

本项目使用腾讯官方 OpenClaw 微信渠道的公开 HTTP API 协议（`ilink/bot/*`），通过扫码授权方式合法接入微信。

## License

MIT
