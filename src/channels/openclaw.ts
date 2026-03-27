import http from "node:http";
import { EventEmitter } from "node:events";
import type { Channel, ChannelContext } from "./channel.js";
import type { OpenClawConfig } from "../config.js";
import type { WeixinMessage, IncomingMessage } from "../protocol/weixin.js";
import { extractTextFromMessage, mediaItemAsFile, MessageType, MessageItemType, MessageState } from "../protocol/weixin.js";

const SENDABLE_TYPES: Set<number> = new Set([MessageItemType.TEXT, MessageItemType.IMAGE, MessageItemType.FILE]);

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function respond(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export class OpenClawChannel implements Channel {
  readonly name = "openclaw";
  private server: http.Server | null = null;
  private queue: WeixinMessage[] = [];
  private emitter = new EventEmitter();
  private ctx: ChannelContext | null = null;
  private readonly config: OpenClawConfig;

  constructor(config: OpenClawConfig) {
    this.config = config;
  }

  start(ctx: ChannelContext): Promise<void> {
    this.ctx = ctx;

    ctx.onCommand("openclaw", async (userId: string, args: string) => {
      const msg: WeixinMessage = {
        from_user_id: userId,
        create_time_ms: Date.now(),
        message_type: MessageType.USER,
        message_state: MessageState.FINISH,
        item_list: [{ type: MessageItemType.TEXT, text_item: { text: args } }],
      };
      this.enqueue(msg);
    }, "发送消息给外部 AI Agent\n  用法: /openclaw <消息内容>");

    // Forward media messages to agent queue
    ctx.onMessage((incoming: IncomingMessage) => {
      if (incoming.mediaType) {
        this.enqueue(incoming.raw);
      }
    });

    return new Promise((resolve) => {
      this.server = http.createServer(async (req, res) => {
        try {
          const auth = req.headers.authorization ?? "";
          if (auth !== `Bearer ${this.config.token}`) {
            respond(res, 401, { error: "Unauthorized" });
            return;
          }

          if (req.method !== "POST") {
            respond(res, 405, { error: "Method not allowed" });
            return;
          }

          const url = req.url ?? "";
          if (url === "/openclaw/getupdates") {
            await this.handleGetUpdates(res);
          } else if (url === "/openclaw/sendmessage") {
            await this.handleSendMessage(req, res);
          } else {
            respond(res, 404, { error: "Not found" });
          }
        } catch {
          respond(res, 500, { error: "Internal error" });
        }
      });

      this.server.listen(this.config.port, () => {
        ctx.debug("listening on port " + this.config.port);
        resolve();
      });
    });
  }

  private async handleGetUpdates(res: http.ServerResponse): Promise<void> {
    const msgs = await this.waitForMessage(30_000);
    respond(res, 200, { ret: 0, msgs });
  }

  private async handleSendMessage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let data: Record<string, unknown>;
    try {
      const raw = await readBody(req);
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      respond(res, 400, { error: "Invalid JSON" });
      return;
    }

    const msg = (data.msg as WeixinMessage | undefined);
    if (!msg) {
      respond(res, 400, { error: "Missing msg" });
      return;
    }

    const text = extractTextFromMessage(msg);
    const mediaItems = msg.item_list?.filter(i => i.type && i.type !== MessageItemType.TEXT) ?? [];

    if (!text && mediaItems.length === 0) {
      respond(res, 400, { error: "Empty message" });
      return;
    }

    // Text and media must be sent separately (WeChat limitation)
    if (text) {
      if (msg.to_user_id) {
        await this.ctx!.send(msg.to_user_id, "[openclaw] " + text);
      } else {
        await this.ctx!.notify("[openclaw] " + text);
      }
    }
    // Filter + downgrade unsupported types (VOICE→FILE, VIDEO→FILE)
    const safeItems = mediaItems.flatMap(item => {
      if (SENDABLE_TYPES.has(item.type!)) return [item];
      const fallback = mediaItemAsFile(item);
      return fallback ? [fallback] : [];
    });
    if (safeItems.length > 0) {
      if (msg.to_user_id) {
        await this.ctx!.sendMedia(msg.to_user_id, safeItems);
      } else {
        await this.ctx!.notifyMedia(safeItems);
      }
    }

    respond(res, 200, { ret: 0 });
  }

  private waitForMessage(timeoutMs: number): Promise<WeixinMessage[]> {
    return new Promise((resolve) => {
      if (this.queue.length > 0) {
        resolve(this.queue.splice(0));
        return;
      }
      const timer = setTimeout(() => {
        this.emitter.removeListener("enqueue", onMsg);
        resolve([]);
      }, timeoutMs);
      const onMsg = () => {
        clearTimeout(timer);
        resolve(this.queue.splice(0));
      };
      this.emitter.once("enqueue", onMsg);
    });
  }

  private enqueue(msg: WeixinMessage): void {
    this.queue.push(msg);
    this.emitter.emit("enqueue");
  }

  stop(): Promise<void> {
    this.emitter.emit("enqueue");
    this.queue = [];
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }
}
