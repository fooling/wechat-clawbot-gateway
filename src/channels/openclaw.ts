import http from "node:http";
import { EventEmitter } from "node:events";
import type { Channel, ChannelContext } from "./channel.js";
import type { OpenClawConfig } from "../config.js";
import type { WeixinMessage } from "../protocol/weixin.js";
import { extractTextFromMessage, MessageType, MessageItemType, MessageState } from "../protocol/weixin.js";

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
    if (!text) {
      respond(res, 400, { error: "Empty message" });
      return;
    }

    if (msg.to_user_id) {
      await this.ctx!.send(msg.to_user_id, "[openclaw] " + text);
    } else {
      await this.ctx!.notify("[openclaw] " + text);
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
