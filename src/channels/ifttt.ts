import type { Channel, ChannelContext } from "./channel.js";
import type { IftttConfig } from "../config.js";

export class IftttChannel implements Channel {
  readonly name = "ifttt";
  private config: IftttConfig;

  constructor(config: IftttConfig) {
    this.config = config;
  }

  async start(ctx: ChannelContext): Promise<void> {
    ctx.onCommand("ifttt", async (_userId: string, args: string) => {
      const spaceIdx = args.indexOf(" ");
      const event = spaceIdx === -1 ? args.trim() : args.slice(0, spaceIdx).trim();
      const value1 = spaceIdx === -1 ? "" : args.slice(spaceIdx + 1).trim();

      if (!event) {
        return "[ifttt] 用法: /ifttt <event> [message]";
      }

      const url = `https://maker.ifttt.com/trigger/${encodeURIComponent(event)}/with/key/${this.config.key}`;

      try {
        ctx.debug(`triggering event: ${event}`);
        const body: Record<string, string> = {};
        if (value1) body.value1 = value1;

        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const text = await res.text();
          ctx.debug(`trigger failed: ${res.status} ${text}`);
          return `[ifttt] 触发失败: ${res.status}`;
        }

        return `[ifttt] 已触发: ${event}`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.debug(`trigger error: ${message}`);
        return `[ifttt] 触发失败: ${message}`;
      }
    }, "触发 IFTTT 自动化\n  用法: /ifttt <event> [message]");

    ctx.debug("registered command /ifttt → maker.ifttt.com");
  }

  async stop(): Promise<void> {
    // No cleanup needed
  }
}
