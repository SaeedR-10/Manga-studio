import type { Panel, Placement, TextLayer } from "@/lib/types";

/**
 * رندر صفحه و پنل روی Canvas مرورگر.
 * شکل‌دهی حروف فارسی توسط Chromium انجام می‌شود؛ بنابراین متن فایل نهایی
 * با فونت Vazirmatn و جهت RTL درست نوشته می‌شود.
 */

export interface RenderPageInput {
  pageIndex: number;
  pageWidth: number;
  pageHeight: number;
  placements: Placement[];
  layers: TextLayer[];
  panels: Map<string, Panel>;
}

const imageCache = new Map<string, Promise<ImageBitmap | null>>();

async function loadImage(url: string): Promise<ImageBitmap | null> {
  if (!imageCache.has(url)) {
    imageCache.set(
      url,
      fetch(url)
        .then((res) => (res.ok ? res.blob() : null))
        .then((blob) => (blob ? createImageBitmap(blob) : null))
        .catch(() => null),
    );
  }
  return imageCache.get(url) ?? Promise.resolve(null);
}

export async function ensureFont(): Promise<void> {
  try {
    await document.fonts.load("20px Vazirmatn");
    await document.fonts.ready;
  } catch {
    /* فونت سیستم جایگزین می‌شود */
  }
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function drawCover(ctx: CanvasRenderingContext2D, image: ImageBitmap, x: number, y: number, w: number, h: number) {
  const scale = Math.max(w / image.width, h / image.height);
  const sw = w / scale;
  const sh = h / scale;
  const sx = (image.width - sw) / 2;
  const sy = (image.height - sh) / 2;
  ctx.drawImage(image, sx, sy, sw, sh, x, y, w, h);
}

function drawBalloon(
  ctx: CanvasRenderingContext2D,
  layer: TextLayer,
  pageWidth: number,
  pageHeight: number,
  scale: number,
) {
  const x = layer.x * pageWidth;
  const y = layer.y * pageHeight;
  const w = layer.w * pageWidth;
  const h = layer.h * pageHeight;
  const radius = Math.min(w, h) / 2;
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = layer.kind === "narration" ? "#555" : "#1e1e1e";
  ctx.lineWidth = Math.max(2, 1.6 * scale);
  ctx.beginPath();
  ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (layer.tail && layer.kind === "dialogue") {
    const dir = layer.tail === "left" ? -1 : layer.tail === "right" ? 1 : 0;
    if (dir !== 0) {
      const tx = x + w / 2 + dir * radius * 0.35;
      const ty = y + h - radius * 0.25;
      ctx.beginPath();
      ctx.moveTo(tx - radius * 0.22, ty);
      ctx.lineTo(tx + radius * 0.22, ty);
      ctx.lineTo(tx + dir * radius * 0.55, ty + radius * 0.7);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.fillStyle = "#111";
  ctx.direction = layer.direction;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const fontSize = layer.fontSize * scale;
  ctx.font = `500 ${fontSize}px Vazirmatn, "Segoe UI", Tahoma, sans-serif`;
  const lines = wrapText(ctx, layer.body, w * 0.82);
  const lineHeight = fontSize * 1.5;
  const total = lines.length * lineHeight;
  lines.forEach((line, index) => {
    ctx.fillText(line, x + w / 2, y + h / 2 - total / 2 + lineHeight * (index + 0.5));
  });
  ctx.restore();
}

export async function renderPage(input: RenderPageInput, scale = 2): Promise<HTMLCanvasElement> {
  await ensureFont();
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(input.pageWidth * scale);
  canvas.height = Math.round(input.pageHeight * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("رسم صفحه ممکن نشد.");
  ctx.scale(scale, scale);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, input.pageWidth, input.pageHeight);

  const ordered = [...input.placements].sort((a, b) => a.readingIndex - b.readingIndex);
  for (const placement of ordered) {
    const panel = input.panels.get(placement.panelId);
    const x = placement.x;
    const y = placement.y;
    const w = placement.w;
    const h = placement.h;
    const image = panel?.imageAssetId ? await loadImage(`/api/assets/${panel.imageAssetId}`) : null;
    if (image) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      drawCover(ctx, image, x, y, w, h);
      ctx.restore();
    } else {
      ctx.fillStyle = "#f2f1ed";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "#c9c5bb";
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = "#8a8880";
      ctx.direction = "rtl";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const fontSize = Math.max(12, Math.min(18, w / 28));
      ctx.font = `400 ${fontSize}px Vazirmatn, Tahoma, sans-serif`;
      const lines = wrapText(ctx, panel?.action || "بدون تصویر", w * 0.8).slice(0, 5);
      const lineHeight = fontSize * 1.7;
      const total = lines.length * lineHeight;
      lines.forEach((line, index) => {
        ctx.fillText(line, x + w / 2, y + h / 2 - total / 2 + lineHeight * (index + 0.5));
      });
    }
    ctx.strokeStyle = "#2b2b2b";
    ctx.lineWidth = Math.max(2, 2.4);
    ctx.strokeRect(x, y, w, h);
  }

  for (const layer of input.layers) {
    if (layer.panelId && !input.placements.some((p) => p.panelId === layer.panelId)) continue;
    drawBalloon(ctx, layer, input.pageWidth, input.pageHeight, scale);
  }

  // شمارهٔ صفحه در حاشیهٔ پایین
  ctx.save();
  ctx.fillStyle = "#666";
  ctx.font = `400 ${Math.max(10, 11)}px Vazirmatn, Tahoma, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(String(input.pageIndex + 1), input.pageWidth / 2, input.pageHeight - 6);
  ctx.restore();
  return canvas;
}

export async function renderPanelImage(panel: Panel, layers: TextLayer[], scale = 2): Promise<HTMLCanvasElement> {
  await ensureFont();
  const width = 900;
  const height = 1200;
  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("رسم پنل ممکن نشد.");
  ctx.scale(scale, scale);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  const image = panel.imageAssetId ? await loadImage(`/api/assets/${panel.imageAssetId}`) : null;
  if (image) {
    drawCover(ctx, image, 0, 0, width, height);
  } else {
    ctx.fillStyle = "#f2f1ed";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#8a8880";
    ctx.direction = "rtl";
    ctx.textAlign = "center";
    ctx.font = "400 22px Vazirmatn, Tahoma, sans-serif";
    const lines = wrapText(ctx, panel.action, width * 0.8).slice(0, 8);
    lines.forEach((line, index) => ctx.fillText(line, width / 2, height / 2 + index * 34));
  }
  for (const layer of layers) {
    // مختصات لایه نسبی صفحه است؛ برای پنل به کل کادر نگاشت می‌شود.
    drawBalloon(ctx, layer, width, height, scale);
  }
  return canvas;
}

export function canvasToPngDataUrl(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL("image/png");
}

export function pageCount(placements: Placement[]): number {
  return placements.reduce((max, p) => Math.max(max, p.pageIndex + 1), 0) || 1;
}
