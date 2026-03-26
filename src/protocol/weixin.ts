import crypto from "node:crypto";

// ── Constants ──────────────────────────────────────────────

export const ILINK_AUTH_BASE_URL = "https://ilinkai.weixin.qq.com";

const BOT_TYPE = "3";
const DEFAULT_API_TIMEOUT_MS = 30_000;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const QR_POLL_TIMEOUT_MS = 35_000;

// ── Type Definitions ───────────────────────────────────────

export const MessageType = {
  USER: 1,
  BOT: 2,
} as const;

export const MessageItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

export const MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const;

export interface TextItem {
  text?: string;
}

export interface MessageItem {
  type?: number;
  text_item?: TextItem;
  ref_msg?: { title?: string; message_item?: MessageItem };
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
}

export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

export interface QRStatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

export interface LoginCredentials {
  token: string;
  baseUrl: string;
  accountId: string;
  userId?: string;
}

export interface IncomingMessage {
  userId: string;
  text: string;
  raw: WeixinMessage;
}

// ── Internal Helpers ───────────────────────────────────────

const MAX_NETWORK_RETRIES = 5;
const NETWORK_RETRY_DELAY_MS = 3_000;

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const cause = (err as { cause?: { code?: string } }).cause;
  const code = cause?.code ?? (err as { code?: string }).code ?? "";
  return ["EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"].includes(code);
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= MAX_NETWORK_RETRIES || !isNetworkError(err)) throw err;
      console.error(`[wx] ${label} network error, retry ${attempt}/${MAX_NETWORK_RETRIES} in ${NETWORK_RETRY_DELAY_MS / 1000}s...`);
      await new Promise((r) => setTimeout(r, NETWORK_RETRY_DELAY_MS));
    }
  }
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function apiPost<T>(
  baseUrl: string,
  endpoint: string,
  body: Record<string, unknown>,
  token?: string,
  timeoutMs = DEFAULT_API_TIMEOUT_MS,
): Promise<T> {
  return withRetry(async () => {
    const url = new URL(endpoint, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    const bodyStr = JSON.stringify(body);
    const headers = buildHeaders(token);
    headers["Content-Length"] = String(Buffer.byteLength(bodyStr, "utf-8"));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url.toString(), {
        method: "POST",
        headers,
        body: bodyStr,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`API ${endpoint} responded ${res.status}: ${text}`);
      }
      return JSON.parse(text) as T;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }, endpoint);
}

// ── Exported Protocol Functions ────────────────────────────

export async function fetchQRCode(): Promise<QRCodeResponse> {
  return withRetry(async () => {
    const url = `${ILINK_AUTH_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch QR code: ${res.status}`);
    return (await res.json()) as QRCodeResponse;
  }, "fetchQRCode");
}

export async function pollQRStatus(qrcodeStr: string): Promise<QRStatusResponse> {
  return withRetry(async () => {
    const url = `${ILINK_AUTH_BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeStr)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), QR_POLL_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { "iLink-App-ClientVersion": "1" },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`Failed to poll QR status: ${res.status}`);
      return (await res.json()) as QRStatusResponse;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        return { status: "wait" };
      }
      throw err;
    }
  }, "pollQRStatus");
}

export async function getUpdates(
  baseUrl: string,
  token: string,
  buf: string,
  timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS,
): Promise<GetUpdatesResp> {
  try {
    return await apiPost<GetUpdatesResp>(
      baseUrl,
      "ilink/bot/getupdates",
      { get_updates_buf: buf },
      token,
      timeoutMs,
    );
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: buf };
    }
    throw err;
  }
}

export async function sendTextMessage(
  baseUrl: string,
  token: string,
  to: string,
  text: string,
  contextToken?: string,
): Promise<void> {
  const clientId = `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const items: MessageItem[] = text
    ? [{ type: MessageItemType.TEXT, text_item: { text } }]
    : [];

  await apiPost(
    baseUrl,
    "ilink/bot/sendmessage",
    {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: items.length ? items : undefined,
        context_token: contextToken,
      } satisfies WeixinMessage,
    },
    token,
  );
}

export function extractTextFromMessage(msg: WeixinMessage): string {
  const items = msg.item_list;
  if (!items?.length) return "";

  for (const item of items) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      const ref = item.ref_msg;
      const text = item.text_item.text;
      if (!ref) return text;
      const parts: string[] = [];
      if (ref.title) parts.push(ref.title);
      return parts.length ? `[引用: ${parts.join(" | ")}]\n${text}` : text;
    }
  }
  return "";
}
