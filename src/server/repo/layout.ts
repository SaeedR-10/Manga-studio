import { newId, nowIso, parseJson, row, rows, run, transaction } from "../db";
import { AppError } from "../http";
import type { PaginationDoc, Placement, TextLayer } from "@/lib/types";

/**
 * صفحه‌بندی: پنل‌ها مستقل از جای‌گیری ذخیره می‌شوند و سند صفحه‌بندی
 * جای‌گذاری و ترتیب خواندن خودش را دارد. تغییر قالب فقط همین سند را عوض
 * می‌کند و به پنل‌ها دست نمی‌زند.
 */

function mapDoc(r: Record<string, unknown>): PaginationDoc {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    format: r.format === "page" ? "page" : "vertical",
    title: String(r.title ?? ""),
    pageWidth: Number(r.page_width),
    pageHeight: Number(r.page_height),
    gap: Number(r.gap),
    settings: parseJson(r.settings, {}),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function listDocs(projectId: string): PaginationDoc[] {
  return rows("SELECT * FROM pagination_docs WHERE project_id = ? ORDER BY created_at", projectId).map(mapDoc);
}

export function ensureDoc(projectId: string, format: "vertical" | "page" = "vertical"): PaginationDoc {
  const existing = listDocs(projectId);
  if (existing.length > 0) return existing[0];
  const id = newId();
  const now = nowIso();
  run(
    `INSERT INTO pagination_docs (id, project_id, format, title, page_width, page_height, gap, settings, created_at, updated_at)
     VALUES (?, ?, ?, 'صفحه‌بندی اصلی', 1200, 1800, 16, '{}', ?, ?)`,
    id,
    projectId,
    format,
    now,
    now,
  );
  return listDocs(projectId)[0];
}

export function updateDoc(
  docId: string,
  patch: Partial<Pick<PaginationDoc, "format" | "title" | "pageWidth" | "pageHeight" | "gap" | "settings">>,
): PaginationDoc {
  const found = row("SELECT * FROM pagination_docs WHERE id = ?", docId);
  if (!found) throw new AppError("سند صفحه‌بندی پیدا نشد.", 404, "doc_missing");
  const doc = mapDoc(found);
  run(
    "UPDATE pagination_docs SET format = ?, title = ?, page_width = ?, page_height = ?, gap = ?, settings = ?, updated_at = ? WHERE id = ?",
    patch.format ?? doc.format,
    patch.title ?? doc.title,
    Math.max(320, Math.round(patch.pageWidth ?? doc.pageWidth)),
    Math.max(320, Math.round(patch.pageHeight ?? doc.pageHeight)),
    Math.max(0, Math.round(patch.gap ?? doc.gap)),
    JSON.stringify(patch.settings ?? doc.settings),
    nowIso(),
    docId,
  );
  return listDocs(doc.projectId).find((d) => d.id === docId)!;
}

export function placementsFor(docId: string): Placement[] {
  return rows("SELECT * FROM panel_placements WHERE doc_id = ? ORDER BY page_index, reading_index", docId).map((r) => ({
    id: String(r.id),
    docId: String(r.doc_id),
    panelId: String(r.panel_id),
    pageIndex: Number(r.page_index),
    x: Number(r.x),
    y: Number(r.y),
    w: Number(r.w),
    h: Number(r.h),
    readingIndex: Number(r.reading_index),
  }));
}

/** جای‌گذاری‌ها به‌صورت مجموعه‌ای جایگزین می‌شوند (ترتیب خواندن صریح است). */
export function replacePlacements(
  docId: string,
  items: Array<{ panelId: string; pageIndex: number; x: number; y: number; w: number; h: number; readingIndex: number }>,
): Placement[] {
  transaction(() => {
    run("DELETE FROM panel_placements WHERE doc_id = ?", docId);
    items.forEach((item) => {
      run(
        `INSERT INTO panel_placements (id, doc_id, panel_id, page_index, x, y, w, h, reading_index, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(),
        docId,
        item.panelId,
        Math.max(0, Math.round(item.pageIndex)),
        item.x,
        item.y,
        Math.max(40, item.w),
        Math.max(40, item.h),
        Math.max(0, Math.round(item.readingIndex)),
        nowIso(),
        nowIso(),
      );
    });
  });
  return placementsFor(docId);
}

export function updatePlacement(id: string, patch: Partial<Omit<Placement, "id" | "docId" | "panelId">>): Placement {
  const found = row("SELECT * FROM panel_placements WHERE id = ?", id);
  if (!found) throw new AppError("جای‌گذاری پیدا نشد.", 404, "placement_missing");
  run(
    "UPDATE panel_placements SET page_index = ?, x = ?, y = ?, w = ?, h = ?, reading_index = ?, updated_at = ? WHERE id = ?",
    patch.pageIndex ?? Number(found.page_index),
    patch.x ?? Number(found.x),
    patch.y ?? Number(found.y),
    patch.w ?? Number(found.w),
    patch.h ?? Number(found.h),
    patch.readingIndex ?? Number(found.reading_index),
    nowIso(),
    id,
  );
  const updated = row("SELECT * FROM panel_placements WHERE id = ?", id)!;
  return {
    id: String(updated.id),
    docId: String(updated.doc_id),
    panelId: String(updated.panel_id),
    pageIndex: Number(updated.page_index),
    x: Number(updated.x),
    y: Number(updated.y),
    w: Number(updated.w),
    h: Number(updated.h),
    readingIndex: Number(updated.reading_index),
  };
}

const LAYER_KINDS = new Set(["dialogue", "narration", "thought", "sfx", "caption"]);

export function textLayers(docId: string): TextLayer[] {
  return rows("SELECT * FROM text_layers WHERE doc_id = ? ORDER BY z, created_at", docId).map((r) => ({
    id: String(r.id),
    docId: String(r.doc_id),
    panelId: r.panel_id ? String(r.panel_id) : null,
    placementId: r.placement_id ? String(r.placement_id) : null,
    kind: (LAYER_KINDS.has(String(r.kind)) ? String(r.kind) : "dialogue") as TextLayer["kind"],
    speaker: String(r.speaker ?? ""),
    body: String(r.body ?? ""),
    x: Number(r.x),
    y: Number(r.y),
    w: Number(r.w),
    h: Number(r.h),
    fontSize: Number(r.font_size),
    direction: r.direction === "ltr" ? "ltr" : "rtl",
    tail: String(r.tail ?? ""),
    z: Number(r.z ?? 0),
  }));
}

export function createTextLayer(docId: string, input: Partial<TextLayer> & { body: string; kind: TextLayer["kind"] }): TextLayer {
  const id = newId();
  const now = nowIso();
  run(
    `INSERT INTO text_layers (id, doc_id, panel_id, placement_id, kind, speaker, body, x, y, w, h, font_size, direction, tail, z, style, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
    id,
    docId,
    input.panelId ?? null,
    input.placementId ?? null,
    input.kind,
    input.speaker ?? "",
    input.body,
    input.x ?? 0.12,
    input.y ?? 0.08,
    input.w ?? 0.36,
    input.h ?? 0.14,
    input.fontSize ?? 22,
    input.direction === "ltr" ? "ltr" : "rtl",
    input.tail ?? "",
    input.z ?? 0,
    now,
    now,
  );
  return textLayers(docId).find((l) => l.id === id)!;
}

export function updateTextLayer(
  id: string,
  patch: Partial<Pick<TextLayer, "body" | "speaker" | "kind" | "x" | "y" | "w" | "h" | "fontSize" | "direction" | "tail" | "z">>,
): TextLayer {
  const found = row("SELECT * FROM text_layers WHERE id = ?", id);
  if (!found) throw new AppError("لایهٔ متن پیدا نشد.", 404, "layer_missing");
  run(
    `UPDATE text_layers SET kind = ?, speaker = ?, body = ?, x = ?, y = ?, w = ?, h = ?, font_size = ?, direction = ?, tail = ?, z = ?, updated_at = ? WHERE id = ?`,
    patch.kind ?? String(found.kind),
    patch.speaker ?? String(found.speaker ?? ""),
    patch.body ?? String(found.body ?? ""),
    patch.x ?? Number(found.x),
    patch.y ?? Number(found.y),
    patch.w ?? Number(found.w),
    patch.h ?? Number(found.h),
    patch.fontSize ?? Number(found.font_size),
    patch.direction ?? String(found.direction ?? "rtl"),
    patch.tail ?? String(found.tail ?? ""),
    patch.z ?? Number(found.z ?? 0),
    nowIso(),
    id,
  );
  const updated = rows("SELECT * FROM text_layers WHERE id = ?", id)[0];
  return {
    id: String(updated.id),
    docId: String(updated.doc_id),
    panelId: updated.panel_id ? String(updated.panel_id) : null,
    placementId: updated.placement_id ? String(updated.placement_id) : null,
    kind: String(updated.kind) as TextLayer["kind"],
    speaker: String(updated.speaker ?? ""),
    body: String(updated.body ?? ""),
    x: Number(updated.x),
    y: Number(updated.y),
    w: Number(updated.w),
    h: Number(updated.h),
    fontSize: Number(updated.font_size),
    direction: updated.direction === "ltr" ? "ltr" : "rtl",
    tail: String(updated.tail ?? ""),
    z: Number(updated.z ?? 0),
  };
}

export function deleteTextLayer(id: string): void {
  run("DELETE FROM text_layers WHERE id = ?", id);
}

/** چیدمان خودکار ستون عمودی: پنل‌ها پشت سر هم در صفحه‌های عمودی. */
export function autoLayout(
  docId: string,
  panelIds: string[],
  options: { columnWidth?: number; gap?: number } = {},
): Placement[] {
  const doc = rows("SELECT * FROM pagination_docs WHERE id = ?", docId)[0];
  if (!doc) throw new AppError("سند صفحه‌بندی پیدا نشد.", 404, "doc_missing");
  const width = Math.round(Number(doc.page_width));
  const height = Math.round(Number(doc.page_height));
  const gap = options.gap ?? Number(doc.gap);
  const innerWidth = width - gap * 2;
  let page = 0;
  let y = gap;
  const items: Array<{ panelId: string; pageIndex: number; x: number; y: number; w: number; h: number; readingIndex: number }> = [];
  panelIds.forEach((panelId, index) => {
    const taller = index % 4 === 0;
    const panelHeight = Math.round(innerWidth * (taller ? 0.78 : 0.6));
    if (y + panelHeight > height - gap) {
      page += 1;
      y = gap;
    }
    items.push({
      panelId,
      pageIndex: page,
      x: gap,
      y,
      w: innerWidth,
      h: panelHeight,
      readingIndex: index,
    });
    y += panelHeight + gap;
  });
  return replacePlacements(docId, items);
}
