import http from "node:http";
import type { Channel, ChannelContext } from "./channel.js";
import type { WebhookConfig, WebhookEndpointConfig, WebhookImagesConfig } from "../config.js";
import { stitchImages, ensureSharpAvailable } from "./stitch.js";

const DEFAULT_MAX_COUNT = 16;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

function readBodyBuffer(req: http.IncomingMessage, maxBytes?: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (maxBytes !== undefined) {
      const declared = Number(req.headers["content-length"] ?? "0");
      if (Number.isFinite(declared) && declared > maxBytes) {
        const err: NodeJS.ErrnoException = new Error("body exceeds limit");
        err.code = "E_BODY_TOO_LARGE";
        req.destroy();
        reject(err);
        return;
      }
    }
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (maxBytes !== undefined && total > maxBytes) {
        const err: NodeJS.ErrnoException = new Error("body exceeds limit");
        err.code = "E_BODY_TOO_LARGE";
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function isTooLarge(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as NodeJS.ErrnoException).code === "E_BODY_TOO_LARGE";
}

function respond(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function renderTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(data[key] ?? ""));
}

// Dynamic import so busboy is only needed when image endpoints exist.
// busboy has no bundled types; we use it untyped on purpose (optional dep).
type BusboyFactory = (opts: { headers: http.IncomingHttpHeaders; limits?: Record<string, number> }) => any;
let busboyPromise: Promise<BusboyFactory> | null = null;
async function getBusboy(): Promise<BusboyFactory> {
  if (!busboyPromise) {
    busboyPromise = (async () => {
      const modName = "busboy";
      const mod: any = await import(modName);
      return (mod.default ?? mod) as BusboyFactory;
    })();
  }
  return busboyPromise;
}

interface MultipartResult {
  files: Buffer[];
  fields: Record<string, string>;
}

async function parseMultipart(
  req: http.IncomingMessage,
  maxCount: number,
  maxBytes: number,
): Promise<MultipartResult> {
  const Busboy = await getBusboy();
  return new Promise((resolve, reject) => {
    const bb = Busboy({
      headers: req.headers,
      limits: { files: maxCount + 1, fileSize: maxBytes + 1, fields: 50 },
    });
    const files: Buffer[] = [];
    const fields: Record<string, string> = {};
    let errored = false;
    const fail = (code: string, msg: string) => {
      if (errored) return;
      errored = true;
      const err: NodeJS.ErrnoException = new Error(msg);
      err.code = code;
      req.destroy();
      reject(err);
    };

    bb.on("file", (_name: string, stream: NodeJS.ReadableStream) => {
      if (files.length >= maxCount) {
        stream.resume();
        fail("E_TOO_MANY_IMAGES", `too many images (max_count=${maxCount})`);
        return;
      }
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("limit", () => fail("E_IMAGE_TOO_LARGE", "image exceeds max_bytes_per_image"));
      stream.on("end", () => {
        if (!errored) files.push(Buffer.concat(chunks));
      });
    });
    bb.on("field", (name: string, val: string) => { fields[name] = val; });
    bb.on("close", () => { if (!errored) resolve({ files, fields }); });
    bb.on("error", (err: unknown) => fail("E_MULTIPART", String((err as Error)?.message ?? err)));
    req.on("error", (err) => fail("E_MULTIPART", String(err?.message ?? err)));
    req.pipe(bb);
  });
}

async function collectImagesFromRequest(
  req: http.IncomingMessage,
  cfg: WebhookImagesConfig,
  data: Record<string, unknown>,
  ctx: ChannelContext,
): Promise<{ buffers: Buffer[]; error?: { status: number; msg: string } }> {
  const maxCount = cfg.max_count ?? DEFAULT_MAX_COUNT;
  const maxBytes = cfg.max_bytes_per_image ?? DEFAULT_MAX_BYTES;
  const contentType = (req.headers["content-type"] ?? "").toLowerCase();

  if (contentType.startsWith("multipart/form-data")) {
    try {
      const { files, fields } = await parseMultipart(req, maxCount, maxBytes);
      for (const [k, v] of Object.entries(fields)) data[k] = v;
      ctx.debug(`multipart OK: files=${files.length} sizes=[${files.map(b => b.length).join(",")}] fields=${JSON.stringify(fields)}`);
      return { buffers: files.slice(0, maxCount) };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      ctx.debug(`multipart parse failed: ${err}`);
      if (code === "E_IMAGE_TOO_LARGE") {
        return { buffers: [], error: { status: 413, msg: "image exceeds max_bytes_per_image" } };
      }
      if (code === "E_TOO_MANY_IMAGES") {
        return { buffers: [], error: { status: 413, msg: `too many images (max_count=${maxCount})` } };
      }
      return { buffers: [], error: { status: 400, msg: "multipart parse failed" } };
    }
  }

  if (contentType.startsWith("image/")) {
    try {
      const buf = await readBodyBuffer(req, maxBytes);
      return { buffers: [buf] };
    } catch (err) {
      if (isTooLarge(err)) {
        return { buffers: [], error: { status: 413, msg: "image exceeds max_bytes_per_image" } };
      }
      ctx.debug(`read image body failed: ${err}`);
      return { buffers: [], error: { status: 400, msg: "read body failed" } };
    }
  }

  if (contentType.startsWith("application/json")) {
    // base64 inflate ~4/3 ≈ 1.34; leave 40% headroom for JSON overhead
    const jsonBodyLimit = Math.ceil(maxCount * maxBytes * 1.4) + 64 * 1024;
    let raw: Buffer;
    try {
      raw = await readBodyBuffer(req, jsonBodyLimit);
    } catch (err) {
      if (isTooLarge(err)) {
        return { buffers: [], error: { status: 413, msg: "JSON body exceeds limit" } };
      }
      ctx.debug(`read JSON body failed: ${err}`);
      return { buffers: [], error: { status: 400, msg: "read body failed" } };
    }
    let body: Record<string, unknown> = {};
    if (raw.length) {
      try { body = JSON.parse(raw.toString("utf-8")) as Record<string, unknown>; }
      catch { return { buffers: [], error: { status: 400, msg: "invalid JSON body" } }; }
    }
    for (const [k, v] of Object.entries(body)) {
      if (k !== "images") data[k] = v;
    }

    const buffers: Buffer[] = [];
    const b64 = Array.isArray(body.images) ? (body.images as unknown[]) : [];
    for (const item of b64.slice(0, maxCount)) {
      if (typeof item !== "string") continue;
      const stripped = item.replace(/^data:image\/[^;]+;base64,/, "");
      const buf = Buffer.from(stripped, "base64");
      if (buf.length && buf.length <= maxBytes) buffers.push(buf);
    }
    return { buffers };
  }

  ctx.debug(`415 rejected: method=${req.method} ct="${contentType}" content-length=${req.headers["content-length"] ?? "?"}`);
  return { buffers: [], error: { status: 415, msg: `unsupported content-type: ${contentType || "(none)"}` } };
}

export class WebhookChannel implements Channel {
  readonly name = "webhook";
  private server: http.Server | null = null;
  private readonly config: WebhookConfig;
  private sharpReady = false;
  private sharpError: string | null = null;

  constructor(config: WebhookConfig) {
    this.config = config;
  }

  private hasImageEndpoint(): boolean {
    return Object.values(this.config.endpoints).some((ep) => ep.images);
  }

  async start(ctx: ChannelContext): Promise<void> {
    if (this.hasImageEndpoint()) {
      try {
        await ensureSharpAvailable();
        await getBusboy();
        this.sharpReady = true;
      } catch (err) {
        this.sharpError = String(err);
        ctx.debug(`image endpoint preflight failed (endpoints will 503): ${err}`);
      }
    }

    return new Promise((resolve) => {
      this.server = http.createServer(async (req, res) => {
        try {
          const url = new URL(req.url ?? "", "http://localhost");
          const segments = url.pathname.split("/");
          const endpointName = segments[2] ?? "";

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

          if (endpoint.images) {
            await this.handleImageEndpoint(endpointName, endpoint, req, res, url, ctx);
          } else {
            await this.handleTextEndpoint(endpointName, endpoint, req, res, url, ctx);
          }
        } catch (err) {
          ctx.debug(`request error: ${err}`);
          respond(res, 500, { error: "Internal error" });
        }
      });

      this.server.listen(this.config.port, () => {
        ctx.debug("listening on port " + this.config.port);
        resolve();
      });
    });
  }

  private async handleTextEndpoint(
    endpointName: string,
    endpoint: WebhookEndpointConfig,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    ctx: ChannelContext,
  ): Promise<void> {
    let data: Record<string, unknown> = {};
    if (req.method === "POST") {
      const raw = (await readBodyBuffer(req)).toString("utf-8");
      if (raw.trim()) {
        try { data = JSON.parse(raw) as Record<string, unknown>; }
        catch { /* not JSON — query params only */ }
      }
    }
    for (const [key, val] of url.searchParams) data[key] = val;

    const rendered = endpoint.template
      ? renderTemplate(endpoint.template, data)
      : "";

    try {
      await ctx.notify(`[webhook-${endpointName}] ${rendered}`);
    } catch (err) {
      ctx.debug(`notify error: ${err}`);
    }
    respond(res, 200, { ok: true });
  }

  private async handleImageEndpoint(
    endpointName: string,
    endpoint: WebhookEndpointConfig,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    ctx: ChannelContext,
  ): Promise<void> {
    if (!this.sharpReady) {
      respond(res, 503, { error: "image pipeline unavailable", detail: this.sharpError });
      return;
    }

    const imagesCfg = endpoint.images!;
    const data: Record<string, unknown> = {};
    for (const [key, val] of url.searchParams) data[key] = val;

    const { buffers, error } = await collectImagesFromRequest(req, imagesCfg, data, ctx);
    if (error) {
      respond(res, error.status, { error: error.msg });
      return;
    }
    if (buffers.length === 0) {
      respond(res, 400, { error: "no images" });
      return;
    }

    try {
      const stitched = await stitchImages(buffers, {
        layout: imagesCfg.layout ?? "grid",
        maxColumns: imagesCfg.max_columns ?? 3,
      });
      ctx.debug(`stitched: inputs=${buffers.length} output=${stitched.length}B (${(stitched.length/1024/1024).toFixed(2)}MB)`);
      const item = await ctx.uploadImage(stitched);
      await ctx.notifyMedia([item]);

      if (endpoint.template) {
        const caption = renderTemplate(endpoint.template, data);
        if (caption.trim()) {
          await ctx.notify(`[webhook-${endpointName}] ${caption}`);
        }
      }
      respond(res, 200, { ok: true, count: buffers.length });
    } catch (err) {
      ctx.debug(`image endpoint ${endpointName} failed: ${err}`);
      respond(res, 500, { error: "image pipeline failed" });
    }
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
