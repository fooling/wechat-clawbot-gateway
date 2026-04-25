import fs from "node:fs";
import path from "node:path";

/**
 * iLink context_token 持久化存储。
 * 主动推送（webhook/cron）必须带 context_token，否则 sendmessage 返回
 * HTTP 200 + body {"ret":-2} 静默丢消息。token 永不主动过期，可无限复用，
 * 所以核心策略是：每收到 IN 消息更新一次，落盘；重启后仍可推送。
 */
export class ContextTokenStore {
  private readonly tokens = new Map<string, string>();
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    this.load();
  }

  get path(): string {
    return this.filePath;
  }

  get size(): number {
    return this.tokens.size;
  }

  get(userId: string): string | undefined {
    return this.tokens.get(userId);
  }

  /** Returns true if value changed (and was persisted), false if no-op (same value or empty). */
  set(userId: string, token: string): boolean {
    if (!token) return false;
    if (this.tokens.get(userId) === token) return false;
    this.tokens.set(userId, token);
    this.persist();
    return true;
  }

  entries(): IterableIterator<[string, string]> {
    return this.tokens.entries();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(raw) as Record<string, unknown>;
      for (const [uid, token] of Object.entries(data)) {
        if (typeof token === "string" && token) this.tokens.set(uid, token);
      }
    } catch (err) {
      console.error(`[context-token-store] Failed to load ${this.filePath}: ${err}`);
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const obj: Record<string, string> = {};
      for (const [uid, token] of this.tokens) obj[uid] = token;
      fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2), "utf-8");
      try { fs.chmodSync(this.filePath, 0o600); } catch { /* ignore on platforms without chmod */ }
    } catch (err) {
      console.error(`[context-token-store] Failed to save ${this.filePath}: ${err}`);
    }
  }
}
