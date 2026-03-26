import http from "node:http";
import type { Channel, ChannelContext } from "./channel.js";
import type { WebhookConfig } from "../config.js";

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

export class WebhookChannel implements Channel {
  readonly name = "webhook";
  private server: http.Server | null = null;
  private readonly config: WebhookConfig;

  constructor(config: WebhookConfig) {
    this.config = config;
  }

  start(ctx: ChannelContext): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer(async (req, res) => {
        try {
          if (req.method !== "POST") {
            respond(res, 405, { error: "Method not allowed" });
            return;
          }

          const segments = (req.url ?? "").split("/");
          const endpointName = segments[2];

          if (this.config.token) {
            const auth = req.headers.authorization ?? "";
            if (auth !== `Bearer ${this.config.token}`) {
              respond(res, 401, { error: "Unauthorized" });
              return;
            }
          }

          const endpoint = this.config.endpoints[endpointName];
          if (!endpoint) {
            respond(res, 404, { error: "Endpoint not found" });
            return;
          }

          let data: Record<string, unknown>;
          try {
            const raw = await readBody(req);
            data = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            respond(res, 400, { error: "Invalid JSON" });
            return;
          }

          const rendered = endpoint.template.replace(
            /\{\{(\w+)\}\}/g,
            (_, key: string) => String(data[key] ?? ""),
          );

          try {
            await ctx.notify(`[webhook-${endpointName}] ${rendered}`);
          } catch (err) {
            ctx.debug(`notify error: ${err}`);
          }

          respond(res, 200, { ok: true });
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

  stop(): Promise<void> {
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
