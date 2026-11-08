import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { ASSET_DIR, newId, nowIso, row, run, sha256 } from "./db";
import { AppError } from "./http";

/**
 * دارایی‌های تصویری بیرون از SQLite نگه‌داری می‌شوند.
 * کلید ذخیره‌سازی نسبی و بر پایهٔ هش است؛ بنابراین جابه‌جایی کل پوشهٔ داده
 * چیزی را نمی‌شکند و دو فایل یکسان فقط یک نسخه روی دیسک دارند.
 */

export interface Asset {
  id: string;
  storageKey: string;
  thumbKey: string | null;
  filename: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  sha256: string;
  kind: string;
  createdAt: string;
}

export function imageSize(buf: Buffer): { width: number; height: number; mime: string } | null {
  // PNG
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), mime: "image/png" };
  }
  // JPEG: پیمایش بخش‌ها تا SOF
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buf[offset + 1];
      const size = buf.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7), mime: "image/jpeg" };
      }
      offset += 2 + size;
    }
    return { width: 0, height: 0, mime: "image/jpeg" };
  }
  // WebP (VP8X / VP8 / VP8L)
  if (buf.length > 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8X") {
      const w = 1 + buf.readUIntLE(24, 3);
      const h = 1 + buf.readUIntLE(27, 3);
      return { width: w, height: h, mime: "image/webp" };
    }
    if (chunk === "VP8 ") {
      return {
        width: buf.readUInt16LE(26) & 0x3fff,
        height: buf.readUInt16LE(28) & 0x3fff,
        mime: "image/webp",
      };
    }
    return { width: 0, height: 0, mime: "image/webp" };
  }
  return null;
}

function mapAsset(r: Record<string, unknown>): Asset {
  return {
    id: String(r.id),
    storageKey: String(r.storage_key),
    thumbKey: r.thumb_key ? String(r.thumb_key) : null,
    filename: String(r.filename),
    mime: String(r.mime),
    bytes: Number(r.bytes),
    width: r.width == null ? null : Number(r.width),
    height: r.height == null ? null : Number(r.height),
    sha256: String(r.sha256),
    kind: String(r.kind),
    createdAt: String(r.created_at),
  };
}

export function safeName(name: string, fallback = "image"): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

function extFor(mime: string): string {
  if (mime.includes("jpeg") || mime.includes("jpg")) return ".jpg";
  if (mime.includes("webp")) return ".webp";
  if (mime.includes("gif")) return ".gif";
  return ".png";
}

export function saveImage(input: {
  buffer: Buffer;
  filename: string;
  mime?: string;
  kind?: "reference" | "panel" | "thumb" | "export" | "import";
  width?: number | null;
  height?: number | null;
}): Asset {
  if (input.buffer.byteLength === 0) throw new AppError("فایل تصویر خالی است.", 400, "empty_file");
  if (input.buffer.byteLength > 40 * 1024 * 1024) {
    throw new AppError("حجم فایل بیش از ۴۰ مگابایت است.", 400, "file_too_large");
  }
  const detected = imageSize(input.buffer);
  const mime = input.mime?.startsWith("image/") ? input.mime : detected?.mime ?? "image/png";
  if (!detected && !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime)) {
    throw new AppError("فقط تصویر PNG، JPEG، WebP یا GIF پذیرفته می‌شود.", 400, "unsupported_image");
  }
  const hash = sha256(input.buffer);
  const id = newId();
  const ext = extFor(mime);
  const key = path.posix.join("assets", hash.slice(0, 2), `${hash}${ext}`);
  const abs = path.join(path.dirname(ASSET_DIR), key);
  if (!fs.existsSync(abs)) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, input.buffer);
    fs.renameSync(tmp, abs);
  }
  run(
    `INSERT INTO assets (id, storage_key, thumb_key, filename, mime, bytes, width, height, sha256, kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    key,
    null,
    safeName(input.filename),
    mime,
    input.buffer.byteLength,
    input.width ?? detected?.width ?? null,
    input.height ?? detected?.height ?? null,
    hash,
    input.kind ?? "reference",
    nowIso(),
  );
  return getAsset(id)!;
}

export function setThumbKey(assetId: string, thumbKey: string | null): void {
  run("UPDATE assets SET thumb_key = ? WHERE id = ?", thumbKey, assetId);
}

export function getAsset(id: string): Asset | null {
  const found = row("SELECT * FROM assets WHERE id = ?", id);
  return found ? mapAsset(found) : null;
}

export function assetPath(asset: Asset, variant: "full" | "thumb" = "full"): string {
  const key = variant === "thumb" && asset.thumbKey ? asset.thumbKey : asset.storageKey;
  const abs = path.resolve(path.dirname(ASSET_DIR), key);
  const root = path.resolve(path.dirname(ASSET_DIR));
  if (!abs.startsWith(root + path.sep)) throw new AppError("مسیر دارایی نامعتبر است.", 500, "invalid_key");
  return abs;
}

export function readAsset(assetId: string): { asset: Asset; buffer: Buffer } {
  const asset = getAsset(assetId);
  if (!asset) throw new AppError("تصویر پیدا نشد.", 404, "asset_missing");
  try {
    return { asset, buffer: fs.readFileSync(assetPath(asset)) };
  } catch {
    throw new AppError(
      "فایل تصویر روی دیسک پیدا نشد.",
      404,
      "asset_file_missing",
      "ممکن است پوشهٔ داده جابه‌جا شده باشد؛ از پشتیبان بازیابی کنید.",
    );
  }
}

export function assetResponse(asset: Asset, req: Request, download = false): Response {
  const abs = assetPath(asset);
  let size = 0;
  try {
    size = fs.statSync(abs).size;
  } catch {
    throw new AppError("فایل تصویر پیدا نشد.", 404, "asset_file_missing");
  }
  const headers = new Headers({
    "content-type": asset.mime,
    "cache-control": "private, max-age=31536000, immutable",
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
  });
  if (download) {
    const ascii = asset.filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
    headers.set("content-disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(asset.filename)}`);
  }
  const range = req.headers.get("range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match) {
      let start = match[1] ? Number(match[1]) : 0;
      let end = match[2] ? Number(match[2]) : size - 1;
      if (!match[1] && match[2]) {
        start = Math.max(0, size - Number(match[2]));
        end = size - 1;
      }
      end = Math.min(end, size - 1);
      if (start <= end && start < size) {
        headers.set("content-range", `bytes ${start}-${end}/${size}`);
        headers.set("content-length", String(end - start + 1));
        const stream = fs.createReadStream(abs, { start, end });
        return new Response(Readable.toWeb(stream) as unknown as BodyInit, { status: 206, headers });
      }
    }
  }
  headers.set("content-length", String(size));
  return new Response(Readable.toWeb(fs.createReadStream(abs)) as unknown as BodyInit, { status: 200, headers });
}

/** نوشتن خروجی روی دیسک در پوشهٔ exports (خارج از assets اصلی). */
export function writeExport(projectId: string, filename: string, buffer: Buffer): { key: string; bytes: number } {
  const safe = safeName(filename, "export");
  const id = newId().slice(0, 8);
  const key = path.posix.join("exports", projectId, `${id}-${safe}`);
  const abs = path.resolve(path.dirname(ASSET_DIR), key);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buffer);
  return { key, bytes: buffer.byteLength };
}

export function exportAbsolutePath(key: string): string {
  const abs = path.resolve(path.dirname(ASSET_DIR), key);
  const root = path.resolve(path.dirname(ASSET_DIR), "exports");
  if (!abs.startsWith(root + path.sep)) throw new AppError("مسیر خروجی نامعتبر است.", 500, "invalid_key");
  return abs;
}
