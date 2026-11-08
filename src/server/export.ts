import { PDFDocument } from "pdf-lib";
import { newId, nowIso, parseJson, row, rows, run } from "./db";
import { AppError } from "./http";
import { exportAbsolutePath, safeName, writeExport } from "./storage";
import { listChapters, listScenes, requireProject } from "./repo/projects";
import { listPanels } from "./repo/panels";
import { ensureDoc, placementsFor, textLayers } from "./repo/layout";
import { createProjectPackage } from "./backup";

export interface ExportRecord {
  id: string;
  kind: string;
  filename: string;
  url: string;
  createdAt: string;
  meta: Record<string, unknown>;
}

function record(projectId: string, kind: string, filename: string, key: string, meta: Record<string, unknown>): ExportRecord {
  const id = newId();
  run(
    "INSERT INTO exports (id, project_id, kind, asset_id, filename, meta, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?)",
    id,
    projectId,
    kind,
    filename,
    JSON.stringify({ ...meta, key }),
    nowIso(),
  );
  return { id, kind, filename, url: `/api/exports/${id}`, createdAt: nowIso(), meta };
}

export function listExports(projectId: string): ExportRecord[] {
  return rows("SELECT * FROM exports WHERE project_id = ? ORDER BY created_at DESC LIMIT 40", projectId).map((r) => {
    const meta = parseJson<Record<string, unknown>>(r.meta, {});
    return {
      id: String(r.id),
      kind: String(r.kind),
      filename: String(r.filename),
      url: `/api/exports/${String(r.id)}`,
      createdAt: String(r.created_at),
      meta,
    };
  });
}

export function exportFile(id: string): { filename: string; abs: string; kind: string } {
  const found = row("SELECT * FROM exports WHERE id = ?", id);
  if (!found) throw new AppError("خروجی پیدا نشد.", 404, "export_missing");
  const meta = parseJson<Record<string, unknown>>(found.meta, {});
  const key = String(meta.key ?? "");
  if (!key) throw new AppError("فایل خروجی نامعتبر است.", 500, "export_invalid");
  return { filename: String(found.filename), abs: exportAbsolutePath(key), kind: String(found.kind) };
}

export function exportMarkdown(projectId: string): ExportRecord {
  const project = requireProject(projectId);
  const chapters = listChapters(projectId);
  const scenes = listScenes(projectId);
  const lines: string[] = [`# ${project.title}`, ""];
  if (project.subtitle) lines.push(`> ${project.subtitle}`, "");
  for (const chapter of chapters) {
    lines.push(`## ${chapter.title}`, "");
    if (chapter.summary) lines.push(`> ${chapter.summary}`, "");
    for (const scene of scenes.filter((s) => s.chapterId === chapter.id)) {
      lines.push(`### ${scene.title}`, "");
      if (scene.isFlashback) lines.push("_(فلش‌بک)_", "");
      lines.push(scene.text.trim(), "");
    }
  }
  const buffer = Buffer.from(`\uFEFF${lines.join("\n")}`, "utf8");
  const filename = `${safeName(project.title, "project")}.md`;
  const { key } = writeExport(projectId, filename, buffer);
  return record(projectId, "markdown", filename, key, { bytes: buffer.byteLength, encoding: "utf-8-bom" });
}

/** خروجی مفهوم پنل‌ها به‌صورت متن؛ برای مرور و ویرایش، نه جایگزین تصویر. */
export function exportPanelScript(projectId: string): ExportRecord {
  const project = requireProject(projectId);
  const panels = listPanels(projectId);
  const lines: string[] = [`# ${project.title} — فیلم‌نامهٔ پنل‌ها`, ""];
  for (const panel of panels) {
    lines.push(`## پنل ${panel.position}: ${panel.title}`);
    lines.push(`- نما: ${panel.shotSize} / زاویه: ${panel.cameraAngle}`);
    if (panel.sourceExcerpt) lines.push(`- متن منبع: ${panel.sourceExcerpt}`);
    if (panel.action) lines.push(`- کنش: ${panel.action}`);
    if (panel.characters.length) {
      lines.push(`- شخصیت‌ها: ${panel.characters.map((c) => `${c.name}${c.position ? ` (${c.position})` : ""}`).join("، ")}`);
    }
    for (const d of panel.dialogue) lines.push(`- ${d.kind === "dialogue" ? "گفت‌وگو" : d.kind}: ${d.speaker ? `${d.speaker}: ` : ""}«${d.text}»`);
    if (panel.needsReview) lines.push(`- ⚠ نیازمند بازبینی: ${panel.reviewReason}`);
    lines.push("");
  }
  const buffer = Buffer.from(`\uFEFF${lines.join("\n")}`, "utf8");
  const filename = `${safeName(project.title, "project")}-panels.md`;
  const { key } = writeExport(projectId, filename, buffer);
  return record(projectId, "panel-script", filename, key, { bytes: buffer.byteLength });
}

/**
 * PDF از تصویرهای واقعی صفحه‌ها ساخته می‌شود؛ هر صفحه PNGای است که رابط
 * کاربر با فونت فارسی و چیدمان واقعی ساخته است. متن انتخاب‌پذیر در PDF
 * نسخهٔ اول نیست و در نقشهٔ توسعه ثبت شده است.
 */
export async function exportPdfFromPages(
  projectId: string,
  pages: Array<{ base64: string; width: number; height: number }>,
): Promise<ExportRecord> {
  const project = requireProject(projectId);
  if (pages.length === 0) throw new AppError("صفحه‌ای برای خروجی ارسال نشده است.", 400, "no_pages");
  if (pages.length > 200) throw new AppError("تعداد صفحه‌ها از سقف این نسخه بیشتر است.", 400, "too_many_pages");
  const pdf = await PDFDocument.create();
  pdf.setTitle(project.title);
  pdf.setCreator("Ravayat Studio");
  for (const page of pages) {
    const buffer = Buffer.from(page.base64.replace(/^data:image\/png;base64,/, ""), "base64");
    if (buffer.byteLength === 0) throw new AppError("تصویر صفحه خالی است.", 400, "empty_page");
    const image = await pdf.embedPng(buffer);
    const width = page.width || image.width;
    const height = page.height || image.height;
    const pageRef = pdf.addPage([width, height]);
    pageRef.drawImage(image, { x: 0, y: 0, width, height });
  }
  const bytes = await pdf.save();
  const buffer = Buffer.from(bytes);
  const filename = `${safeName(project.title, "project")}.pdf`;
  const { key } = writeExport(projectId, filename, buffer);
  return record(projectId, "pdf", filename, key, { pages: pages.length, bytes: buffer.byteLength });
}

export function exportPanelPng(projectId: string, panelId: string, dataUrl: string): ExportRecord {
  const panel = row("SELECT * FROM panels WHERE id = ? AND project_id = ?", panelId, projectId);
  if (!panel) throw new AppError("پنل پیدا نشد.", 404, "panel_missing");
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  const buffer = Buffer.from(base64, "base64");
  if (buffer.byteLength === 0) throw new AppError("تصویر پنل خالی است.", 400, "empty_image");
  const filename = `panel-${String(panel.position).padStart(2, "0")}.png`;
  const { key } = writeExport(projectId, filename, buffer);
  return record(projectId, "panel_png", filename, key, { panelId, bytes: buffer.byteLength });
}

export function exportPagePng(projectId: string, pageIndex: number, dataUrl: string): ExportRecord {
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  const buffer = Buffer.from(base64, "base64");
  if (buffer.byteLength === 0) throw new AppError("تصویر صفحه خالی است.", 400, "empty_image");
  const filename = `page-${String(pageIndex + 1).padStart(3, "0")}.png`;
  const { key } = writeExport(projectId, filename, buffer);
  return record(projectId, "page_png", filename, key, { pageIndex, bytes: buffer.byteLength });
}

export async function exportPackage(projectId: string): Promise<ExportRecord> {
  const project = requireProject(projectId);
  const { buffer, manifest } = await createProjectPackage(projectId);
  const filename = `${safeName(project.title, "project")}.ravayat.zip`;
  const { key } = writeExport(projectId, filename, buffer);
  return record(projectId, "package", filename, key, {
    bytes: buffer.byteLength,
    assets: manifest.assets.length,
    secretsIncluded: false,
  });
}

/** دادهٔ کامل صفحه‌بندی برای رندر در رابط کاربر. */
export function layoutBundle(projectId: string) {
  const doc = ensureDoc(projectId);
  return {
    doc,
    placements: placementsFor(doc.id),
    layers: textLayers(doc.id),
  };
}
