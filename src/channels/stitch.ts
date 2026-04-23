export type StitchLayout = "grid" | "horizontal" | "vertical";

export interface StitchOptions {
  layout?: StitchLayout;
  maxColumns?: number;
}

type SharpFactory = (input?: Buffer | { create: { width: number; height: number; channels: 3 | 4; background: { r: number; g: number; b: number } } }) => any;

let sharpModPromise: Promise<SharpFactory> | null = null;

export async function ensureSharpAvailable(): Promise<void> {
  await getSharp();
}

async function getSharp(): Promise<SharpFactory> {
  if (!sharpModPromise) {
    sharpModPromise = (async () => {
      try {
        const modName = "sharp";
        const mod: any = await import(modName);
        return (mod.default ?? mod) as SharpFactory;
      } catch {
        throw new Error("图片拼接需要 sharp 依赖，请运行: npm install sharp");
      }
    })();
  }
  return sharpModPromise;
}

const JPEG_QUALITY = 85;
const BLACK = { r: 0, g: 0, b: 0 };
const GRID_CELL_WIDTH_CAP = 800;
const HORIZONTAL_HEIGHT_CAP = 600;
const VERTICAL_WIDTH_CAP = 800;

interface SizedImage {
  buffer: Buffer;
  width: number;
  height: number;
}

export async function stitchImages(buffers: Buffer[], opts: StitchOptions = {}): Promise<Buffer> {
  if (buffers.length === 0) throw new Error("stitchImages: buffers 不能为空");
  const sharp = await getSharp();

  if (buffers.length === 1) {
    return await sharp(buffers[0]).jpeg({ quality: JPEG_QUALITY }).toBuffer();
  }

  const layout: StitchLayout = opts.layout ?? "grid";
  const maxColumns = Math.max(1, opts.maxColumns ?? 3);

  const metas: SizedImage[] = await Promise.all(
    buffers.map(async (buf) => {
      const m = await sharp(buf).metadata();
      return { buffer: buf, width: m.width ?? 0, height: m.height ?? 0 };
    }),
  );

  if (layout === "horizontal") return await stitchHorizontal(sharp, metas);
  if (layout === "vertical") return await stitchVertical(sharp, metas);
  return await stitchGrid(sharp, metas, maxColumns);
}

async function resizeTo(sharp: SharpFactory, buf: Buffer, width?: number, height?: number): Promise<SizedImage> {
  const resized = await sharp(buf).resize({ width, height, fit: "inside" }).toBuffer();
  const meta = await sharp(resized).metadata();
  return { buffer: resized, width: meta.width ?? 0, height: meta.height ?? 0 };
}

async function stitchHorizontal(sharp: SharpFactory, metas: SizedImage[]): Promise<Buffer> {
  const targetHeight = Math.min(HORIZONTAL_HEIGHT_CAP, Math.min(...metas.map((m) => m.height)));
  const resized = await Promise.all(metas.map((m) => resizeTo(sharp, m.buffer, undefined, targetHeight)));
  const totalWidth = resized.reduce((s, m) => s + m.width, 0);

  const composite = resized.map((img, i) => ({
    input: img.buffer,
    left: resized.slice(0, i).reduce((s, m) => s + m.width, 0),
    top: Math.floor((targetHeight - img.height) / 2),
  }));

  return await sharp({ create: { width: totalWidth, height: targetHeight, channels: 3, background: BLACK } })
    .composite(composite)
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
}

async function stitchVertical(sharp: SharpFactory, metas: SizedImage[]): Promise<Buffer> {
  const targetWidth = Math.min(VERTICAL_WIDTH_CAP, Math.min(...metas.map((m) => m.width)));
  const resized = await Promise.all(metas.map((m) => resizeTo(sharp, m.buffer, targetWidth, undefined)));
  const totalHeight = resized.reduce((s, m) => s + m.height, 0);

  const composite = resized.map((img, i) => ({
    input: img.buffer,
    left: Math.floor((targetWidth - img.width) / 2),
    top: resized.slice(0, i).reduce((s, m) => s + m.height, 0),
  }));

  return await sharp({ create: { width: targetWidth, height: totalHeight, channels: 3, background: BLACK } })
    .composite(composite)
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
}

async function stitchGrid(sharp: SharpFactory, metas: SizedImage[], maxColumns: number): Promise<Buffer> {
  const cellWidth = Math.min(GRID_CELL_WIDTH_CAP, Math.min(...metas.map((m) => m.width)));
  const resized = await Promise.all(metas.map((m) => resizeTo(sharp, m.buffer, cellWidth, undefined)));

  const columns = Math.min(maxColumns, resized.length);
  const rows: SizedImage[][] = [];
  for (let i = 0; i < resized.length; i += columns) {
    rows.push(resized.slice(i, i + columns));
  }

  const rowHeights = rows.map((row) => Math.max(...row.map((img) => img.height)));
  const totalWidth = cellWidth * columns;
  const totalHeight = rowHeights.reduce((s, h) => s + h, 0);

  const composite: { input: Buffer; left: number; top: number }[] = [];
  let y = 0;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    const rowHeight = rowHeights[r]!;
    for (let c = 0; c < row.length; c++) {
      const img = row[c]!;
      composite.push({
        input: img.buffer,
        left: c * cellWidth + Math.floor((cellWidth - img.width) / 2),
        top: y + Math.floor((rowHeight - img.height) / 2),
      });
    }
    y += rowHeight;
  }

  return await sharp({ create: { width: totalWidth, height: totalHeight, channels: 3, background: BLACK } })
    .composite(composite)
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
}
