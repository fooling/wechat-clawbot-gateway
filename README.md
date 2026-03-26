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

外部系统通过 HTTP POST 发送数据，经模板渲染后转发到微信。**单向：外部 → 微信。**

**配置示例：**

```yaml
channels:
  webhook:
    enabled: true
    port: 9100
    token: "my-secret"    # 留空则不校验
    endpoints:
      transmission:
        template: "任务 {{name}} 下载完成（{{size}}）"
      doorbell:
        template: "{{message}}"
```

**外部系统 → 微信：**

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
# 门铃通知
curl -X POST http://localhost:9100/webhook/doorbell \
  -H "Content-Type: application/json" \
  -d '{"message": "有人按门铃"}'
```

```
微信聊天框收到：[webhook-doorbell] 有人按门铃
```

**模板语法：** `{{key}}` 会被 JSON body 中对应字段的值替换。

**HTTP 响应：**

| 状态码 | 含义 |
|--------|------|
| 200 `{"ok": true}` | 发送成功 |
| 400 | JSON 解析失败 |
| 401 | token 不匹配 |
| 404 | endpoint 不存在 |
| 405 | 非 POST 方法 |

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
