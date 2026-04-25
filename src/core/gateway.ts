import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { WxClient, SessionMetrics } from "./wx-client.js";
import type { GatewayConfig } from "../config.js";
import type {
  Channel,
  ChannelContext,
  CommandHandler,
  MessageHandler,
  LogEntry,
  DebugEntry,
} from "../channels/channel.js";
import type { IncomingMessage, MessageItem, CDNMedia } from "../protocol/weixin.js";

export class Gateway extends EventEmitter {
  private wxClient: WxClient;
  private channels: Channel[] = [];
  private commandHandlers = new Map<string, { channel: string; handler: CommandHandler; help?: string }>();
  private defaultHandler: { channel: string; handler: MessageHandler } | null = null;
  private notifyUser: string;
  private notifyUserPath: string;

  constructor(wxClient: WxClient, config: GatewayConfig) {
    super();
    this.wxClient = wxClient;
    // Persist notify_user alongside credentials
    this.notifyUserPath = path.resolve(path.dirname(config.wechat.credentials_path), "notify_user");
    this.notifyUser = config.wechat.notify_user || this.loadNotifyUser();
  }

  getNotifyUser(): string {
    return this.notifyUser;
  }

  use(channel: Channel): void {
    this.channels.push(channel);
  }

  async start(): Promise<void> {
    for (const channel of this.channels) {
      const ctx = this.createContext(channel.name);
      await channel.start(ctx);
    }

    this.wxClient.on("message", (msg: IncomingMessage) => {
      this.handleIncoming(msg).catch((err) => {
        this.emitDebug("gateway", `Unhandled routing error: ${err}`);
      });
    });

    this.wxClient.startPolling();
  }

  async stop(): Promise<void> {
    for (const channel of [...this.channels].reverse()) {
      try {
        await channel.stop();
      } catch (err) {
        this.emitDebug(channel.name, `stop error: ${err}`);
      }
    }
    await this.wxClient.stop();
  }

  // ── Internal ───────────────────────────────────────────

  private createContext(channelName: string): ChannelContext {
    return {
      send: async (userId: string, text: string) => {
        this.emitLog("out", channelName, userId, text);
        await this.wxClient.send(userId, text);
      },
      notify: async (text: string) => {
        if (!this.notifyUser) {
          this.emitDebug(channelName, "notify_user not set, message dropped");
          return;
        }
        this.emitLog("out", channelName, this.notifyUser, text);
        await this.wxClient.send(this.notifyUser, text);
      },
      onCommand: (cmd: string, handler: CommandHandler, help?: string) => {
        if (this.commandHandlers.has(cmd)) {
          throw new Error(`Command /${cmd} already registered`);
        }
        this.commandHandlers.set(cmd, { channel: channelName, handler, help });
      },
      onDefault: (handler: MessageHandler) => {
        if (this.defaultHandler) {
          throw new Error(`Default handler already registered by ${this.defaultHandler.channel}`);
        }
        this.defaultHandler = { channel: channelName, handler };
      },
      sendMedia: async (userId: string, items: MessageItem[]) => {
        const types = items.map(i => i.type).join(",");
        this.emitLog("out", channelName, userId, `[media:${types}]`);
        await this.wxClient.sendMedia(userId, items);
      },
      notifyMedia: async (items: MessageItem[]) => {
        if (!this.notifyUser) {
          this.emitDebug(channelName, "notify_user not set, media dropped");
          return;
        }
        const types = items.map(i => i.type).join(",");
        this.emitLog("out", channelName, this.notifyUser, `[media:${types}]`);
        await this.wxClient.sendMedia(this.notifyUser, items);
      },
      downloadMedia: async (cdnMedia: CDNMedia) => {
        return this.wxClient.downloadMedia(cdnMedia);
      },
      uploadImage: async (buffer: Buffer) => {
        return this.wxClient.uploadImage(buffer, this.notifyUser || undefined);
      },
      onMessage: (handler: (msg: IncomingMessage) => void) => {
        this.on("message", handler);
      },
      debug: (detail: string) => {
        this.emitDebug(channelName, detail);
      },
      onLog: (handler: (entry: LogEntry) => void) => {
        this.on("log", handler);
      },
      onDebug: (handler: (entry: DebugEntry) => void) => {
        this.on("debug", handler);
      },
    };
  }

  private async handleIncoming(msg: IncomingMessage): Promise<void> {
    const { userId, text } = msg;

    this.emitLog("in", "wx", userId, text);
    this.emit("message", msg);

    // Auto-capture notify user and persist
    if (!this.notifyUser) {
      this.notifyUser = userId;
      this.saveNotifyUser(userId);
      this.emitDebug("gateway", `notify_user auto-captured: ${userId}`);
    }

    // Built-in: /heartbeat — session health report
    if (text === "/heartbeat") {
      const reply = this.formatSessionReport(this.wxClient.getSessionMetrics());
      this.emitLog("out", "gateway", userId, "[heartbeat report]");
      await this.wxClient.send(userId, reply);
      return;
    }

    // Help: /? lists all commands, /cmd? shows help for specific command
    if (text === "/?") {
      const lines = ["可用命令:"];
      lines.push("  /heartbeat — 会话健康报告");
      for (const [cmd, entry] of this.commandHandlers) {
        lines.push(`  /${cmd} — ${entry.help || entry.channel}`);
      }
      lines.push("", "输入 /命令? 查看具体用法");
      const reply = lines.join("\n");
      this.emitLog("out", "gateway", userId, reply);
      await this.wxClient.send(userId, reply);
      return;
    }
    if (text.startsWith("/") && text.endsWith("?") && text.length > 2) {
      const cmd = text.slice(1, -1);
      const builtinHelp: Record<string, string> = {
        heartbeat: "/heartbeat — 会话健康报告 (心跳探针、长轮询、运行时间)",
      };
      const entry = this.commandHandlers.get(cmd);
      const reply = builtinHelp[cmd]
        ?? (entry ? `/${cmd} — ${entry.help || "无详细说明"}` : `未知命令: /${cmd}\n输入 /? 查看所有可用命令`);
      this.emitLog("out", "gateway", userId, reply);
      await this.wxClient.send(userId, reply);
      return;
    }

    // Command routing: /cmd args
    if (text.startsWith("/")) {
      const spaceIdx = text.indexOf(" ");
      const cmd = spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx);
      const args = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1);

      const entry = this.commandHandlers.get(cmd);
      if (entry) {
        try {
          const reply = await entry.handler(userId, args);
          if (typeof reply === "string") {
            this.emitLog("out", entry.channel, userId, reply);
            await this.wxClient.send(userId, reply);
          }
        } catch (err) {
          this.emitDebug(entry.channel, `command /${cmd} error: ${err}`);
        }
        return;
      }
      // Unrecognized command falls through to default handler
    }

    // Default handler
    if (this.defaultHandler) {
      try {
        const reply = await this.defaultHandler.handler(userId, text);
        if (typeof reply === "string") {
          this.emitLog("out", this.defaultHandler.channel, userId, reply);
          await this.wxClient.send(userId, reply);
        }
      } catch (err) {
        this.emitDebug(this.defaultHandler.channel, `default handler error: ${err}`);
      }
    }
  }

  private loadNotifyUser(): string {
    try {
      return fs.readFileSync(this.notifyUserPath, "utf-8").trim();
    } catch {
      return "";
    }
  }

  private saveNotifyUser(userId: string): void {
    try {
      fs.mkdirSync(path.dirname(this.notifyUserPath), { recursive: true });
      fs.writeFileSync(this.notifyUserPath, userId, "utf-8");
    } catch {
      // ignore
    }
  }

  private formatSessionReport(m: SessionMetrics): string {
    const now = Date.now();
    const uptime = m.loginTime ? formatDuration(now - m.loginTime) : "未登录";
    const lastHb = m.lastHeartbeatTime ? formatAgo(now - m.lastHeartbeatTime) : "尚无";
    const lastPoll = m.lastPollTime ? formatAgo(now - m.lastPollTime) : "尚无";
    const hbHealth = m.heartbeatTotal
      ? `${((m.heartbeatOk / m.heartbeatTotal) * 100).toFixed(1)}%`
      : "N/A";
    const pollHealth = m.pollTotal
      ? `${(((m.pollTotal - m.pollErrors) / m.pollTotal) * 100).toFixed(1)}%`
      : "N/A";

    return [
      "── 会话健康报告 ──",
      "",
      `运行时间: ${uptime}`,
      `收到消息: ${m.messagesReceived}`,
      "",
      "心跳探针 (getconfig):",
      `  总计: ${m.heartbeatTotal}  成功率: ${hbHealth}`,
      `  成功: ${m.heartbeatOk}  失败: ${m.heartbeatFail}  过期: ${m.heartbeatExpired}`,
      `  上次: ${lastHb}  状态: ${m.lastHeartbeatOk ? "OK" : "FAIL"}`,
      "",
      "长轮询 (getupdates):",
      `  总计: ${m.pollTotal}  成功率: ${pollHealth}`,
      `  错误: ${m.pollErrors}  过期(-14): ${m.pollSessionExpired}`,
      `  上次成功: ${lastPoll}`,
    ].join("\n");
  }

  private emitLog(direction: "in" | "out", source: string, userId: string, text: string): void {
    this.emit("log", {
      timestamp: Date.now(),
      source,
      direction,
      userId,
      text,
    } satisfies LogEntry);
  }

  private emitDebug(channel: string, detail: string): void {
    this.emit("debug", {
      timestamp: Date.now(),
      channel,
      detail,
    } satisfies DebugEntry);
  }
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}天`);
  if (h) parts.push(`${h}时`);
  parts.push(`${m}分`);
  return parts.join("");
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}秒前`;
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}分钟前`;
  return `${Math.floor(ms / 3600_000)}小时前`;
}
