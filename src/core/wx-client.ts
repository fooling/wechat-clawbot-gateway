import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import qrcode from "qrcode-terminal";
import {
  fetchQRCode,
  pollQRStatus,
  getUpdates,
  sendTextMessage,
  sendMessage,
  extractMessageSummary,
  downloadMedia as cdnDownload,
  MessageType,
} from "../protocol/weixin.js";
import type {
  LoginCredentials,
  IncomingMessage,
  WeixinMessage,
  MessageItem,
  CDNMedia,
} from "../protocol/weixin.js";

const MAX_QR_REFRESH = 3;
const LOGIN_DEADLINE_MS = 8 * 60_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

export interface WxClientOptions {
  credentialsPath: string;
}

export class WxClient extends EventEmitter {
  private credentials: LoginCredentials | null = null;
  private running = false;
  private getUpdatesBuf = "";
  private contextTokens = new Map<string, string>();
  private credentialsPath: string;

  constructor(options: WxClientOptions) {
    super();
    this.credentialsPath = path.resolve(options.credentialsPath);
  }

  // ── Public API ─────────────────────────────────────────

  async login(): Promise<void> {
    const saved = this.loadCredentials();
    if (saved) {
      this.credentials = saved;
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
    this.pollLoop().catch((err) => {
      this.emit("error", err);
    });
  }

  async send(userId: string, text: string): Promise<void> {
    if (!this.credentials) throw new Error("Not logged in");
    const contextToken = this.contextTokens.get(userId);
    await sendTextMessage(
      this.credentials.baseUrl,
      this.credentials.token,
      userId,
      text,
      contextToken,
    );
  }

  async sendMedia(userId: string, items: MessageItem[]): Promise<void> {
    if (!this.credentials) throw new Error("Not logged in");
    const contextToken = this.contextTokens.get(userId);
    await sendMessage(
      this.credentials.baseUrl,
      this.credentials.token,
      userId,
      items,
      contextToken,
    );
  }

  async downloadMedia(cdnMedia: CDNMedia): Promise<Buffer> {
    return cdnDownload(cdnMedia);
  }

  stop(): void {
    this.running = false;
  }

  clearCredentials(): void {
    try {
      fs.unlinkSync(this.credentialsPath);
    } catch {
      // ignore
    }
  }

  // ── Internal ───────────────────────────────────────────

  private async pollLoop(): Promise<void> {
    if (!this.credentials) throw new Error("Not logged in");

    let failures = 0;

    while (this.running) {
      try {
        const resp = await getUpdates(
          this.credentials.baseUrl,
          this.credentials.token,
          this.getUpdatesBuf,
        );

        if (resp.ret !== undefined && resp.ret !== 0) {
          failures++;
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

        if (resp.get_updates_buf) {
          this.getUpdatesBuf = resp.get_updates_buf;
        }

        for (const msg of resp.msgs ?? []) {
          this.processMessage(msg);
        }
      } catch (err) {
        failures++;
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
    if (msg.message_type !== MessageType.USER) return;

    const fromUser = msg.from_user_id;
    if (!fromUser) return;

    if (msg.context_token) {
      this.contextTokens.set(fromUser, msg.context_token);
    }

    const { text, mediaType } = extractMessageSummary(msg);
    if (!text.trim()) return;

    const incoming: IncomingMessage = { userId: fromUser, text, mediaType, raw: msg };
    this.emit("message", incoming);
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
