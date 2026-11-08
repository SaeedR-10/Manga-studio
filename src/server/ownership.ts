import { row } from "./db";
import { AppError, assertSameProject } from "./http";

/**
 * بررسی مالکیت منابع بر پایهٔ شناسه.
 *
 * حتی در برنامهٔ تک‌کاربره، ترکیب شناسه‌های دو پروژه در یک درخواست می‌تواند
 * داده را به‌هم بریزد (پنل پروژهٔ الف با صحنهٔ پروژهٔ ب). این توابع پیش از هر
 * خواندن یا نوشتنِ وابسته به شناسه فراخوانی می‌شوند.
 */

function projectOf(table: string, id: string, column = "project_id"): string | null {
  const found = row(`SELECT ${column} AS project_id FROM ${table} WHERE id = ?`, id);
  return found ? String(found.project_id ?? "") : null;
}

export function assertSceneOwned(projectId: string, sceneId: string): void {
  const owner = projectOf("scenes", sceneId);
  if (!owner) throw new AppError("صحنه پیدا نشد.", 404, "scene_missing");
  assertSameProject(owner, projectId, "صحنه");
}

export function assertChapterOwned(projectId: string, chapterId: string): void {
  const owner = projectOf("chapters", chapterId);
  if (!owner) throw new AppError("فصل پیدا نشد.", 404, "chapter_missing");
  assertSameProject(owner, projectId, "فصل");
}

export function assertPanelOwned(projectId: string, panelId: string): void {
  const owner = projectOf("panels", panelId);
  if (!owner) throw new AppError("پنل پیدا نشد.", 404, "panel_missing");
  assertSameProject(owner, projectId, "پنل");
}

export function assertEntityOwned(projectId: string, entityId: string): void {
  const owner = projectOf("entities", entityId);
  if (!owner) throw new AppError("موجودیت پیدا نشد.", 404, "entity_missing");
  assertSameProject(owner, projectId, "موجودیت");
}

export function assertEntitiesOwned(projectId: string, entityIds: string[]): void {
  for (const id of entityIds) assertEntityOwned(projectId, id);
}

export function assertReferenceOwned(projectId: string, referenceId: string): void {
  const owner = projectOf("reference_assets", referenceId);
  if (!owner) throw new AppError("مرجع پیدا نشد.", 404, "reference_missing");
  assertSameProject(owner, projectId, "مرجع");
}

export function assertRequestOwned(projectId: string, requestId: string): void {
  const owner = projectOf("ai_requests", requestId);
  if (!owner) throw new AppError("درخواست پیدا نشد.", 404, "request_missing");
  assertSameProject(owner, projectId, "درخواست");
}

export function assertLayoutDocOwned(projectId: string, docId: string): void {
  const owner = projectOf("pagination_docs", docId);
  if (!owner) throw new AppError("سند صفحه‌بندی پیدا نشد.", 404, "doc_missing");
  assertSameProject(owner, projectId, "سند صفحه‌بندی");
}
