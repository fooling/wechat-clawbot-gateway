import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import qrcode from "qrcode-terminal";
import {
  fetchQRCode,
  pollQRStatus,
  getUpdates,
  sendMessage,
  extractMessageSummary,
  downloadMedia as cdnDownload,
  uploadMedia as cdnUpload,
  checkSession,
  notifyStart,
  notifyStop,
  MessageType,
  MessageItemType,
  UploadMediaType,
} from "../protocol/weixin.js";
import type {
  LoginCredentials,
  IncomingMessage,
  WeixinMessage,
  MessageItem,
  CDNMedia,
} from "../protocol/weixin.js";
import { ContextTokenStore } from "./context-token-store.js";
import { FailedMessageStore } from "./failed-message-store.js";

const MAX_QR_REFRESH = 3;
const LOGIN_DEADLINE_MS = 8 * 60_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const SESSION_EXPIRED_ERRCODE = -14;
const HEARTBEAT_INTERVAL_MS = 5 * 60_000; // 5 min keepalive

export interface SessionMetrics {
  loginTime: number;
  heartbeatTotal: number;
  heartbeatOk: number;
  heartbeatFail: number;
  heartbeatExpired: number;
  lastHeartbeatTime: number;
  lastHeartbeatOk: boolean;
  pollTotal: number;
  pollErrors: number;
  pollSessionExpired: number;
  lastPollTime: number;
  messagesReceived: number;
}

export interface WxClientOptions {
  credentialsPath: string;
  contextTokensPath: string;
  failedMessagesPath: string;
  failedMessagesEnabled: boolean;
}

export class WxClient extends EventEmitter {
  private credentials: LoginCredentials | null = null;
  private running = false;
  private getUpdatesBuf = "";
  private readonly contextTokens: ContextTokenStore;
  private readonly failedMessages: FailedMessageStore;
  private readonly flushingUsers = new Set<string>();
  private credentialsPath: string;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private metrics: SessionMetrics = {
    loginTime: 0,
    heartbeatTotal: 0, heartbeatOk: 0, heartbeatFail: 0, heartbeatExpired: 0,
    lastHeartbeatTime: 0, lastHeartbeatOk: true,
    pollTotal: 0, pollErrors: 0, pollSessionExpired: 0,
    lastPollTime: 0, messagesReceived: 0,
  };

  constructor(options: WxClientOptions) {
    super();
    this.credentialsPath = path.resolve(options.credentialsPath);
    this.contextTokens = new ContextTokenStore(options.contextTokensPath);
    this.failedMessages = new FailedMessageStore(options.failedMessagesPath, options.failedMessagesEnabled);
    if (this.contextTokens.size > 0) {
      console.log(`[wx] Loaded ${this.contextTokens.size} context_token(s) from ${this.contextTokens.path}`);
    }
    if (this.failedMessages.enabled) {
      console.log(`[wx] Failed-message recovery enabled, dir=${this.failedMessages.path}`);
    }
  }

  // ── Public API ─────────────────────────────────────────

  async login(): Promise<void> {
    const saved = this.loadCredentials();
    if (saved) {
      this.credentials = saved;
      this.metrics.loginTime = Date.now();
      console.log(`[wx] Using saved credentials (accountId=${saved.accountId})`);
      this.emit("ready");
      return;
    }

    console.log("[wx] Fetching login QR code...");
    let qr = await fetchQRCode();
    this.displayQRCode(qr.qrcode_img_content);

    let refreshCount = 0;
    const deadline = Date.now() + LOGIN_DEADLINE_MS;

    while (Date.now() < deadline) {
      const status = await pollQRStatus(qr.qrcode);

      switch (status.status) {
        case "wait":
          break;
        case "scaned":
          console.log("[wx] Scanned, please confirm on your phone...");
          break;
        case "expired":
          refreshCount++;
          if (refreshCount >= MAX_QR_REFRESH) {
            throw new Error("QR code expired too many times");
          }
          console.log(`[wx] QR expired, refreshing... (${refreshCount}/${MAX_QR_REFRESH})`);
          qr = await fetchQRCode();
          this.displayQRCode(qr.qrcode_img_content);
          break;
        case "confirmed": {
          if (!status.bot_token || !status.ilink_bot_id) {
            throw new Error("Login confirmed but missing token or bot_id");
          }
          const creds: LoginCredentials = {
            token: status.bot_token,
            baseUrl: status.baseurl || "https://ilinkai.weixin.qq.com",
            accountId: status.ilink_bot_id,
            userId: status.ilink_user_id,
          };
          this.saveCredentials(creds);
          this.credentials = creds;
          this.metrics.loginTime = Date.now();
          console.log(`[wx] Login success! accountId=${creds.accountId}`);
          this.emit("ready");
          return;
        }
      }

      await sleep(1000);
    }

    throw new Error("Login timed out");
  }

  startPolling(): void {
    this.running = true;
    // 对齐官方 SDK：声明本 channel 进入 active-receive 状态。失败仅记日志，
    // 长轮询本身也会隐式维持 liveness，不阻断启动。
    if (this.credentials) {
      const { baseUrl, token } = this.credentials;
      notifyStart(baseUrl, token)
        .then((resp) => {
          if (resp.ret !== undefined && resp.ret !== 0) {
            console.error(`[wx] notifyStart ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg}`);
          }
        })
        .catch((err) => console.error(`[wx] notifyStart error: ${err}`));
    }
    this.pollLoop().catch((err) => {
      this.emit("error", err);
    });
    this.startHeartbeat();
  }

  async send(userId: string, text: string): Promise<void> {
    if (!this.credentials) throw new Error("Not logged in");
    const items: MessageItem[] = text
      ? [{ type: MessageItemType.TEXT, text_item: { text } }]
      : [];
    if (!items.length) return;
    await this.sendMedia(userId, items);
  }

  async sendMedia(userId: string, items: MessageItem[]): Promise<void> {
    if (!this.credentials) throw new Error("Not logged in");
    const contextToken = this.contextTokens.get(userId);
    if (!contextToken) console.warn(`[wx] sendMedia to ${userId} WITHOUT context_token (push will likely silently fail with ret=-2)`);
    const result = await sendMessage(
      this.credentials.baseUrl,
      this.credentials.token,
      userId,
      items,
      contextToken,
    );
    if (result.ret !== 0) {
      this.failedMessages.enqueue(userId, items, { ret: result.ret, errcode: result.errcode, errmsg: result.errmsg });
    }
  }

  async downloadMedia(cdnMedia: CDNMedia): Promise<Buffer> {
    return cdnDownload(cdnMedia);
  }

  async uploadImage(buffer: Buffer, toUser?: string): Promise<MessageItem> {
    if (!this.credentials) throw new Error("Not logged in");
    const { cdnMedia, encryptedSize } = await cdnUpload(
      this.credentials.baseUrl,
      this.credentials.token,
      buffer,
      UploadMediaType.IMAGE,
      toUser,
    );
    return {
      type: MessageItemType.IMAGE,
      image_item: {
        media: { ...cdnMedia, encrypt_type: 1 },
        mid_size: encryptedSize,
      },
    };
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.credentials) {
      try {
        await notifyStop(this.credentials.baseUrl, this.credentials.token);
      } catch (err) {
        console.error(`[wx] notifyStop error: ${err}`);
      }
    }
  }

  getSessionMetrics(): SessionMetrics {
    return { ...this.metrics };
  }

  clearCredentials(): void {
    try {
      fs.unlinkSync(this.credentialsPath);
    } catch {
      // ignore
    }
  }

  // ── Internal ───────────────────────────────────────────

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.heartbeat().catch((err) => {
        console.error(`[wx] Heartbeat error: ${err}`);
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private async heartbeat(): Promise<void> {
    if (!this.credentials) return;
    this.metrics.heartbeatTotal++;
    this.metrics.lastHeartbeatTime = Date.now();
    try {
      const resp = await checkSession(this.credentials.baseUrl, this.credentials.token);
      if (resp.errcode === SESSION_EXPIRED_ERRCODE) {
        this.metrics.heartbeatExpired++;
        this.metrics.lastHeartbeatOk = false;
        console.error(`[wx] Heartbeat: session expired (errcode ${resp.errcode}, errmsg=${resp.errmsg})`);
        this.emit("sessionExpired");
      } else {
        this.metrics.heartbeatOk++;
        this.metrics.lastHeartbeatOk = true;
      }
    } catch {
      this.metrics.heartbeatFail++;
      this.metrics.lastHeartbeatOk = false;
    }
  }

  private async pollLoop(): Promise<void> {
    let failures = 0;

    while (this.running) {
      if (!this.credentials) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      const { baseUrl, token } = this.credentials;

      try {
        this.metrics.pollTotal++;
        const resp = await getUpdates(
          baseUrl,
          token,
          this.getUpdatesBuf,
        );

        if (resp.ret !== undefined && resp.ret !== 0) {
          if (resp.errcode === SESSION_EXPIRED_ERRCODE) {
            this.metrics.pollSessionExpired++;
            console.error("[wx] Session expired (errcode -14), retrying with existing credentials...");
            this.emit("sessionExpired");
            await sleep(BACKOFF_DELAY_MS);
            continue;
          }

          failures++;
          this.metrics.pollErrors++;
          console.error(`[wx] getUpdates error: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg}`);
          if (failures >= MAX_CONSECUTIVE_FAILURES) {
            failures = 0;
            await sleep(BACKOFF_DELAY_MS);
          } else {
            await sleep(RETRY_DELAY_MS);
          }
          continue;
        }

        failures = 0;
        this.metrics.lastPollTime = Date.now();

        if (resp.get_updates_buf) {
          this.getUpdatesBuf = resp.get_updates_buf;
        }

        const msgs = resp.msgs ?? [];
        this.metrics.messagesReceived += msgs.length;
        for (const msg of msgs) {
          this.processMessage(msg);
        }
      } catch (err) {
        failures++;
        this.metrics.pollErrors++;
        console.error(`[wx] Poll error: ${err}`);
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          failures = 0;
          await sleep(BACKOFF_DELAY_MS);
        } else {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }
  }

  private processMessage(msg: WeixinMessage): void {
    const fromUser = msg.from_user_id;
    if (fromUser && msg.context_token) {
      const updated = this.contextTokens.set(fromUser, msg.context_token);
      if (updated && this.failedMessages.enabled) {
        // token 刚被刷新，是回放失败队列的最佳时机；fire-and-forget，错误内吞
        this.flushPendingFor(fromUser).catch(err => console.error(`[wx] flushPending(${fromUser}): ${err}`));
      }
    }

    if (msg.message_type !== MessageType.USER) return;
    if (!fromUser) return;

    const { text, mediaType } = extractMessageSummary(msg);
    if (!text.trim()) return;

    const incoming: IncomingMessage = { userId: fromUser, text, mediaType, raw: msg };
    this.emit("message", incoming);
  }

  private async flushPendingFor(userId: string): Promise<void> {
    if (this.flushingUsers.has(userId)) return;
    if (!this.credentials) return;
    const pending = this.failedMessages.pendingFor(userId);
    if (pending.length === 0) return;
    this.flushingUsers.add(userId);
    try {
      const { baseUrl, token } = this.credentials;
      const ctxToken = this.contextTokens.get(userId);
      console.log(`[wx] Replaying ${pending.length} pending message(s) for ${userId}`);
      for (const rec of pending) {
        try {
          const result = await sendMessage(baseUrl, token, userId, rec.items, ctxToken);
          if (result.ret === 0) {
            this.failedMessages.remove(rec.filename);
          } else {
            // 仍然失败：保留文件、累加 attempts，并停止本轮回放（避免拉爆）
            this.failedMessages.bumpAttempt(rec, { ret: result.ret, errcode: result.errcode, errmsg: result.errmsg });
            console.error(`[wx] Replay still failing for ${rec.filename} ret=${result.ret}; stopping this round`);
            break;
          }
        } catch (err) {
          console.error(`[wx] Replay error on ${rec.filename}: ${err}`);
          break;
        }
      }
    } finally {
      this.flushingUsers.delete(userId);
    }
  }

  private displayQRCode(qrcodeUrl: string): void {
    qrcode.generate(qrcodeUrl, { small: true });
    console.log(`\nOpen in browser if QR does not display:\n${qrcodeUrl}\n`);
  }

  private saveCredentials(creds: LoginCredentials): void {
    const dir = path.dirname(this.credentialsPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.credentialsPath, JSON.stringify(creds, null, 2), "utf-8");
    try {
      fs.chmodSync(this.credentialsPath, 0o600);
    } catch {
      // ignore on platforms without chmod
    }
  }

  private loadCredentials(): LoginCredentials | null {
    try {
      if (!fs.existsSync(this.credentialsPath)) return null;
      const raw = fs.readFileSync(this.credentialsPath, "utf-8");
      const data = JSON.parse(raw) as LoginCredentials;
      if (data.token && data.baseUrl && data.accountId) return data;
      return null;
    } catch {
      return null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
