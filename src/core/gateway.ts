import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { WxClient } from "./wx-client.js";
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
  private commandHandlers = new Map<string, { channel: string; handler: CommandHandler }>();
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
    this.wxClient.stop();
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
      onCommand: (cmd: string, handler: CommandHandler) => {
        if (this.commandHandlers.has(cmd)) {
          throw new Error(`Command /${cmd} already registered`);
        }
        this.commandHandlers.set(cmd, { channel: channelName, handler });
      },
      onDefault: (handler: MessageHandler) => {
        if (this.defaultHandler) {
          throw new Error(`Default handler already registered by ${this.defaultHandler.channel}`);
        }
        this.defaultHandler = { channel: channelName, handler };
      },
      sendMedia: async (userId: string, items: MessageItem[]) => {
        this.emitLog("out", channelName, userId, "[media]");
        await this.wxClient.sendMedia(userId, items);
      },
      notifyMedia: async (items: MessageItem[]) => {
        if (!this.notifyUser) {
          this.emitDebug(channelName, "notify_user not set, media dropped");
          return;
        }
        this.emitLog("out", channelName, this.notifyUser, "[media]");
        await this.wxClient.sendMedia(this.notifyUser, items);
      },
      downloadMedia: async (cdnMedia: CDNMedia) => {
        return this.wxClient.downloadMedia(cdnMedia);
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
