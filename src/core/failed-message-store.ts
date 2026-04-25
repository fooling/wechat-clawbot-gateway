import fs from "node:fs";
import path from "node:path";
import type { MessageItem } from "../protocol/weixin.js";

/**
 * 失败消息持久化队列。sendMessage 拿到 ret != 0（典型 ret=-2）时把整条消息序列化到目录，
 * 等下一次该用户 IN 消息到达（context_token 刷新后）再批量回放。默认关闭，配置开启。
 *
 * 文件名 `{ts}-{safeUserId}-{rand}.json`，按 ts 升序回放保证顺序。
 *
 * 已知局限：item_list 里可能含 CDN 引用（image/file），CDN 媒体在远端有 TTL，
 * 队列等待过久后回放可能拿到 CDN 失效错误。回放失败时**保留文件**，由后续重试或人工清理。
 */
export interface FailedMessageRecord {
  ts: number;
  userId: string;
  items: MessageItem[];
  attempts: number;
  lastError: { ret?: number; errcode?: number; errmsg?: string };
  filename: string;
}

export class FailedMessageStore {
  readonly enabled: boolean;
  private readonly dirPath: string;

  constructor(dirPath: string, enabled: boolean) {
    this.enabled = enabled;
    this.dirPath = path.resolve(dirPath);
    if (this.enabled) {
      try {
        fs.mkdirSync(this.dirPath, { recursive: true });
      } catch (err) {
        console.error(`[failed-msg] Failed to create dir ${this.dirPath}: ${err}`);
      }
    }
  }

  get path(): string {
    return this.dirPath;
  }

  enqueue(userId: string, items: MessageItem[], lastError: FailedMessageRecord["lastError"]): void {
    if (!this.enabled) return;
    const ts = Date.now();
    const safe = userId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
    const rand = Math.random().toString(36).slice(2, 8);
    const filename = `${ts}-${safe}-${rand}.json`;
    const record: FailedMessageRecord = { ts, userId, items, attempts: 1, lastError, filename };
    try {
      fs.writeFileSync(path.join(this.dirPath, filename), JSON.stringify(record, null, 2), "utf-8");
    } catch (err) {
      console.error(`[failed-msg] Failed to enqueue: ${err}`);
    }
  }

  pendingFor(userId: string): FailedMessageRecord[] {
    if (!this.enabled) return [];
    let entries: string[];
    try {
      entries = fs.readdirSync(this.dirPath);
    } catch {
      return [];
    }
    const out: FailedMessageRecord[] = [];
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = fs.readFileSync(path.join(this.dirPath, name), "utf-8");
        const rec = JSON.parse(raw) as FailedMessageRecord;
        if (rec.userId !== userId) continue;
        rec.filename = name;
        out.push(rec);
      } catch {
        // skip corrupt files
      }
    }
    out.sort((a, b) => a.ts - b.ts);
    return out;
  }

  remove(filename: string): void {
    if (!this.enabled) return;
    try {
      fs.unlinkSync(path.join(this.dirPath, filename));
    } catch (err) {
      console.error(`[failed-msg] Failed to remove ${filename}: ${err}`);
    }
  }

  bumpAttempt(record: FailedMessageRecord, lastError: FailedMessageRecord["lastError"]): void {
    if (!this.enabled) return;
    record.attempts += 1;
    record.lastError = lastError;
    try {
      fs.writeFileSync(path.join(this.dirPath, record.filename), JSON.stringify(record, null, 2), "utf-8");
    } catch (err) {
      console.error(`[failed-msg] Failed to update ${record.filename}: ${err}`);
    }
  }
}
