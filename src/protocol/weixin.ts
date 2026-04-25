import crypto from "node:crypto";

// ── Constants ──────────────────────────────────────────────

export const ILINK_AUTH_BASE_URL = "https://ilinkai.weixin.qq.com";

const BOT_TYPE = "3";
const DEFAULT_API_TIMEOUT_MS = 30_000;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const QR_POLL_TIMEOUT_MS = 35_000;
const CDN_DOWNLOAD = "https://novac2c.cdn.weixin.qq.com/c2c/download";
const CDN_UPLOAD = "https://novac2c.cdn.weixin.qq.com/c2c/upload";

// 直接抄官方 @tencent-weixin/openclaw-weixin 当前版本，让请求和官方客户端无法
// 区分。bump 时同步两个常量：channel_version 是字符串、ClientVersion 是
// (major<<16)|(minor<<8)|patch 的紧凑 int。
// 2.1.10 (2026-04-24) → 131338
const ILINK_CHANNEL_VERSION = "2.1.10";
const ILINK_APP_CLIENT_VERSION = 131338;

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

export const UploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
} as const;

// ── Media Types ────────────────────────────────────────────

export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
}

export interface TextItem {
  text?: string;
}

export interface ImageItem {
  media?: CDNMedia;
  thumb_media?: CDNMedia;
  aeskey?: string;
  url?: string;
  mid_size?: number;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
  hd_size?: number;
}

export interface VoiceItem {
  media?: CDNMedia;
  encode_type?: number;
  bits_per_sample?: number;
  sample_rate?: number;
  playtime?: number;
  text?: string;
}

export interface FileItem {
  media?: CDNMedia;
  file_name?: string;
  md5?: string;
  len?: string;
}

export interface VideoItem {
  media?: CDNMedia;
  thumb_media?: CDNMedia;
  video_size?: number;
  play_length?: number;
  video_md5?: string;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
}

// ── Message Structures ─────────────────────────────────────

export interface MessageItem {
  type?: number;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
  ref_msg?: { title?: string; message_item?: MessageItem };
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  delete_time_ms?: number;
  session_id?: string;
  group_id?: string;
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

export type MediaType = "image" | "voice" | "video" | "file";

export interface IncomingMessage {
  userId: string;
  text: string;
  mediaType?: MediaType;
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
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function apiPost<T>(
  baseUrl: string,
  endpoint: string,
  body: Record<string, unknown>,
  token?: string,
  timeoutMs = DEFAULT_API_TIMEOUT_MS,
): Promise<T> {
  return withRetry(async () => {
    const url = new URL(endpoint, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    const wrappedBody = endpoint.startsWith("ilink/bot/") && body.base_info === undefined
      ? { ...body, base_info: { channel_version: ILINK_CHANNEL_VERSION } }
      : body;
    const bodyStr = JSON.stringify(wrappedBody);
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ── Auth Functions ─────────────────────────────────────────

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

// ── Send Constraints ───────────────────────────────────────

// Bot API only supports sending these item types. VOICE/VIDEO are silently ignored by WeChat.
const SENDABLE_ITEM_TYPES: Set<number> = new Set([MessageItemType.TEXT, MessageItemType.IMAGE, MessageItemType.FILE]);

// uploadMedia only supports IMAGE and FILE. VIDEO/VOICE uploads succeed at CDN but fail at send.
const UPLOADABLE_MEDIA_TYPES: Set<number> = new Set([UploadMediaType.IMAGE, UploadMediaType.FILE]);

export function mediaItemAsFile(item: MessageItem): MessageItem | null {
  if (item.type === MessageItemType.VOICE && item.voice_item?.media) {
    return {
      type: MessageItemType.FILE,
      file_item: { media: item.voice_item.media, file_name: "voice.silk" },
    };
  }
  if (item.type === MessageItemType.VIDEO && item.video_item?.media) {
    return {
      type: MessageItemType.FILE,
      file_item: {
        media: item.video_item.media,
        file_name: "video.mp4",
        len: item.video_item.video_size ? String(item.video_item.video_size) : undefined,
      },
    };
  }
  return null;
}

// ── Messaging Functions ────────────────────────────────────

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

export interface SendResult {
  ret: number;          // 0 = success; non-zero (常见 -2) = 业务失败，body 已被 console.error
  errcode?: number;
  errmsg?: string;
}

export async function sendMessage(
  baseUrl: string,
  token: string,
  to: string,
  items: MessageItem[],
  contextToken?: string,
): Promise<SendResult> {
  // Filter unsupported types (VOICE/VIDEO silently ignored by WeChat)
  const sanitized = items.filter(item => {
    if (!item.type || SENDABLE_ITEM_TYPES.has(item.type)) return true;
    console.error(`[wx] sendMessage: item type ${item.type} not supported by bot API, dropped`);
    return false;
  });
  if (!sanitized.length) return { ret: 0 };

  const clientId = `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const resp = await apiPost<{ ret?: number; errcode?: number; errmsg?: string; [k: string]: unknown }>(
    baseUrl,
    "ilink/bot/sendmessage",
    {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: sanitized.length ? sanitized : undefined,
        context_token: contextToken,
      } satisfies WeixinMessage,
    },
    token,
  );
  // iLink 业务错误返回 HTTP 200 但 body 里 ret != 0；最常见 ret=-2（context_token 缺失/失效）
  // 见 src/core/context-token-store.ts 注释
  const ret = typeof resp?.ret === "number" ? resp.ret : 0;
  if (ret !== 0) {
    const types = sanitized.map(i => i.type).join(",");
    console.error(`[wx] sendMessage to=${to} types=[${types}] ret=${ret} errcode=${resp?.errcode ?? ""} errmsg=${resp?.errmsg ?? ""} body=${JSON.stringify(resp)}`);
  }
  return { ret, errcode: resp?.errcode, errmsg: resp?.errmsg };
}

export async function sendTextMessage(
  baseUrl: string,
  token: string,
  to: string,
  text: string,
  contextToken?: string,
): Promise<SendResult> {
  const items: MessageItem[] = text
    ? [{ type: MessageItemType.TEXT, text_item: { text } }]
    : [];
  return sendMessage(baseUrl, token, to, items, contextToken);
}

// ── Session Health ─────────────────────────────────────

export async function checkSession(
  baseUrl: string,
  token: string,
): Promise<{ ret?: number; errcode?: number; errmsg?: string }> {
  return apiPost(baseUrl, "ilink/bot/getconfig", {}, token);
}

// 官方 SDK @tencent-weixin/openclaw-weixin v2.1.10 (2026-04-24) 新增：
// 启动时声明 channel 处于 active-receive 状态、退出时反向通知。怀疑 ret=-2
// 静默丢消息的 5h+ 衰减窗口就是缺这个 liveness 信号导致的。
export async function notifyStart(
  baseUrl: string,
  token: string,
): Promise<{ ret?: number; errcode?: number; errmsg?: string }> {
  return apiPost(baseUrl, "ilink/bot/msg/notifystart", {}, token);
}

export async function notifyStop(
  baseUrl: string,
  token: string,
): Promise<{ ret?: number; errcode?: number; errmsg?: string }> {
  return apiPost(baseUrl, "ilink/bot/msg/notifystop", {}, token);
}

// ── Message Parsing ────────────────────────────────────────

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

export function extractMessageSummary(msg: WeixinMessage): {
  text: string;
  mediaType?: MediaType;
} {
  const items = msg.item_list;
  if (!items?.length) return { text: "" };

  for (const item of items) {
    switch (item.type) {
      case MessageItemType.TEXT:
        return { text: extractTextFromMessage(msg) };

      case MessageItemType.VOICE: {
        const v = item.voice_item;
        const stt = v?.text?.trim();
        const dur = v?.playtime ? `${Math.round(v.playtime / 1000)}s` : "";
        return {
          text: stt || `[语音${dur ? " " + dur : ""}]`,
          mediaType: "voice",
        };
      }

      case MessageItemType.IMAGE: {
        const img = item.image_item;
        const dim = img?.thumb_width && img?.thumb_height
          ? ` ${img.thumb_width}x${img.thumb_height}` : "";
        return { text: `[图片${dim}]`, mediaType: "image" };
      }

      case MessageItemType.FILE: {
        const f = item.file_item;
        const name = f?.file_name || "未知文件";
        const size = f?.len ? ` ${formatSize(parseInt(f.len, 10))}` : "";
        return { text: `[文件: ${name}${size}]`, mediaType: "file" };
      }

      case MessageItemType.VIDEO: {
        const v = item.video_item;
        const dur = v?.play_length ? ` ${v.play_length}s` : "";
        return { text: `[视频${dur}]`, mediaType: "video" };
      }
    }
  }
  return { text: "" };
}

// ── CDN Media Operations ───────────────────────────────────

export function decodeAesKey(base64Key: string): Buffer {
  const decoded = Buffer.from(base64Key, "base64");
  if (decoded.length === 16) return decoded;
  const hex = decoded.toString("utf-8");
  if (hex.length === 32) return Buffer.from(hex, "hex");
  throw new Error("Invalid AES key format");
}

export async function downloadMedia(cdnMedia: CDNMedia): Promise<Buffer> {
  const param = cdnMedia.encrypt_query_param;
  if (!param) throw new Error("Missing encrypt_query_param");
  const aesKeyStr = cdnMedia.aes_key;
  if (!aesKeyStr) throw new Error("Missing aes_key");

  const url = `${CDN_DOWNLOAD}?encrypted_query_param=${encodeURIComponent(param)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CDN download failed: ${res.status}`);
  const encrypted = Buffer.from(await res.arrayBuffer());

  const key = decodeAesKey(aesKeyStr);
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

export interface UploadResult {
  cdnMedia: CDNMedia;
  thumbCdnMedia?: CDNMedia;
  encryptedSize: number;    // AES-PKCS7 padding 后大小，ImageItem.mid_size 要用这个
}

export async function uploadMedia(
  baseUrl: string,
  token: string,
  file: Buffer,
  mediaType: number,
  toUser?: string,
  options?: { thumb?: Buffer },
): Promise<UploadResult> {
  if (!UPLOADABLE_MEDIA_TYPES.has(mediaType)) {
    throw new Error(`uploadMedia: media_type ${mediaType} not supported (use IMAGE=1 or FILE=3)`);
  }

  const aesKey = crypto.randomBytes(16);
  const aesKeyHex = aesKey.toString("hex");
  const filekey = crypto.randomBytes(16).toString("hex");

  const rawMd5 = crypto.createHash("md5").update(file).digest("hex");
  const cipher = crypto.createCipheriv("aes-128-ecb", aesKey, null);
  const encrypted = Buffer.concat([cipher.update(file), cipher.final()]);

  // 1. Get upload URL
  const uploadReq: Record<string, unknown> = {
    filekey,
    media_type: mediaType,
    to_user_id: toUser,
    rawsize: file.length,
    filesize: encrypted.length,
    rawfilemd5: rawMd5,
    aeskey: aesKeyHex,
    no_need_thumb: !options?.thumb,
  };
  if (options?.thumb) {
    const thumbMd5 = crypto.createHash("md5").update(options.thumb).digest("hex");
    const tc = crypto.createCipheriv("aes-128-ecb", aesKey, null);
    const thumbEncrypted = Buffer.concat([tc.update(options.thumb), tc.final()]);
    uploadReq.thumb_rawsize = options.thumb.length;
    uploadReq.thumb_filesize = thumbEncrypted.length;
    uploadReq.thumb_rawfilemd5 = thumbMd5;
  }

  const uploadResp = await apiPost<{
    upload_param?: string;
    upload_full_url?: string;
    thumb_upload_param?: string;
    thumb_upload_full_url?: string;
    ret?: number;
    errcode?: number;
    errmsg?: string;
  }>(baseUrl, "ilink/bot/getuploadurl", uploadReq, token);

  // iLink 新版 API 返回 upload_full_url（完整 URL + taskid）；老版本返回 upload_param 由客户端拼 URL
  const cdnUploadUrl = uploadResp.upload_full_url
    ?? (uploadResp.upload_param
      ? `${CDN_UPLOAD}?encrypted_query_param=${encodeURIComponent(uploadResp.upload_param)}&filekey=${encodeURIComponent(filekey)}`
      : null);
  if (!cdnUploadUrl) {
    throw new Error(`getuploadurl failed: ${JSON.stringify(uploadResp)}`);
  }

  // 2. Upload encrypted file to CDN
  const cdnRes = await fetch(cdnUploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(encrypted),
  });
  if (!cdnRes.ok) {
    const errMsg = cdnRes.headers.get("x-error-message") || await cdnRes.text();
    throw new Error(`CDN upload failed: ${cdnRes.status} ${errMsg}`);
  }

  // 参考 photon-hq/wechat-ilink-client：当前 iLink API 只返回 x-encrypted-param，这就是 downloadParam
  // 老的 x-encrypted-query-param 在新版 API 下不再返回；upload_full_url 里的 param 是给上传用的
  const downloadParam = cdnRes.headers.get("x-encrypted-param")
    ?? cdnRes.headers.get("x-encrypted-query-param")
    ?? uploadResp.upload_param
    ?? (uploadResp.upload_full_url ? new URL(uploadResp.upload_full_url).searchParams.get("encrypted_query_param") : null)
    ?? undefined;

  const aesKeyBase64 = Buffer.from(aesKeyHex).toString("base64");

  // 3. Upload thumbnail if provided
  let thumbCdnMedia: CDNMedia | undefined;
  const thumbUploadUrl = options?.thumb
    ? (uploadResp.thumb_upload_full_url
      ?? (uploadResp.thumb_upload_param
        ? `${CDN_UPLOAD}?encrypted_query_param=${encodeURIComponent(uploadResp.thumb_upload_param)}&filekey=${encodeURIComponent(filekey)}`
        : null))
    : null;
  if (options?.thumb && thumbUploadUrl) {
    const tc = crypto.createCipheriv("aes-128-ecb", aesKey, null);
    const thumbEncrypted = Buffer.concat([tc.update(options.thumb), tc.final()]);
    const thumbRes = await fetch(thumbUploadUrl, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(thumbEncrypted),
    });
    if (thumbRes.ok) {
      const thumbDownloadParam = thumbRes.headers.get("x-encrypted-query-param")
        ?? uploadResp.thumb_upload_param
        ?? (uploadResp.thumb_upload_full_url ? new URL(uploadResp.thumb_upload_full_url).searchParams.get("encrypted_query_param") : null)
        ?? undefined;
      if (thumbDownloadParam) {
        thumbCdnMedia = { encrypt_query_param: thumbDownloadParam, aes_key: aesKeyBase64 };
      }
    }
  }

  return {
    cdnMedia: { encrypt_query_param: downloadParam, aes_key: aesKeyBase64 },
    thumbCdnMedia,
    encryptedSize: encrypted.length,
  };
}
