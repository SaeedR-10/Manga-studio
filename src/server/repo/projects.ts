import { newId, nowIso, parseJson, row, rows, run, sha256, transaction } from "../db";
import { AppError } from "../http";
import { findMatches, normalizePersian, wordCount } from "@/lib/persian";
import type { Chapter, Project, ProjectSettings, Scene, SceneVersion } from "@/lib/types";
import { DEFAULT_MODELS } from "../models";

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  text: { provider: "openai", model: DEFAULT_MODELS.text.openai },
  image: { provider: "openai", model: DEFAULT_MODELS.image.openai },
  caps: { generationsPerPanel: 2, reviewsPerPanel: 1, chapterBudgetUsd: null, unknownCostPolicy: "block" },
  readingOrder: "rtl",
  adaptation: { panelsPerScene: 12 },
};

export function mergeSettings(raw: unknown): ProjectSettings {
  const base = DEFAULT_PROJECT_SETTINGS;
  const input = (raw ?? {}) as Partial<ProjectSettings>;
  const number = (value: unknown, fallback: number, min: number, max: number) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
  };
  const budget = input.caps?.chapterBudgetUsd;
  return {
    text: {
      provider: input.text?.provider || base.text.provider,
      model: input.text?.model || base.text.model,
    },
    image: {
      provider: input.image?.provider || base.image.provider,
      model: input.image?.model || base.image.model,
    },
    caps: {
      generationsPerPanel: number(input.caps?.generationsPerPanel, base.caps.generationsPerPanel, 1, 10),
      reviewsPerPanel: number(input.caps?.reviewsPerPanel, base.caps.reviewsPerPanel, 0, 5),
      chapterBudgetUsd:
        budget == null || budget === ("" as unknown)
          ? null
          : Number.isFinite(Number(budget))
            ? Math.max(0, Number(budget))
            : null,
      unknownCostPolicy: input.caps?.unknownCostPolicy === "allow" ? "allow" : "block",
    },
    readingOrder: input.readingOrder === "ltr" ? "ltr" : "rtl",
    adaptation: { panelsPerScene: number(input.adaptation?.panelsPerScene, base.adaptation.panelsPerScene, 1, 28) },
  };
}

function mapProject(r: Record<string, unknown>): Project {
  return {
    id: String(r.id),
    title: String(r.title),
    subtitle: String(r.subtitle ?? ""),
    description: String(r.description ?? ""),
    language: String(r.language ?? "fa"),
    publishFormat: r.publish_format === "page" ? "page" : "vertical",
    settings: mergeSettings(parseJson(r.settings, {})),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function listProjects(): Project[] {
  return rows("SELECT * FROM projects ORDER BY updated_at DESC").map(mapProject);
}

/**
 * خلاصهٔ کتابخانه: عنوان پروژه + آخرین صحنه‌ای که تغییر کرده + شمار واژه و پنل.
 * برای «ادامهٔ نوشتن» استفاده می‌شود و هیچ دادهٔ ساختگی ندارد.
 */
export function listProjectSummaries(): Array<{
  project: Project;
  lastScene: { id: string; title: string; chapterTitle: string; updatedAt: string } | null;
  sceneCount: number;
  wordCount: number;
  panelCount: number;
}> {
  return listProjects().map((project) => {
    const last = row(
      `SELECT s.id, s.title, s.updated_at, c.title AS chapter_title
         FROM scenes s JOIN chapters c ON c.id = s.chapter_id
        WHERE s.project_id = ?
        ORDER BY s.updated_at DESC LIMIT 1`,
      project.id,
    );
    const stats = row(
      `SELECT (SELECT COUNT(*) FROM scenes WHERE project_id = ?) AS scenes,
              (SELECT COALESCE(SUM(word_count), 0) FROM scenes WHERE project_id = ?) AS words,
              (SELECT COUNT(*) FROM panels WHERE project_id = ?) AS panels`,
      project.id,
      project.id,
      project.id,
    );
    return {
      project,
      lastScene: last
        ? {
            id: String(last.id),
            title: String(last.title),
            chapterTitle: String(last.chapter_title ?? ""),
            updatedAt: String(last.updated_at),
          }
        : null,
      sceneCount: Number(stats?.scenes ?? 0),
      wordCount: Number(stats?.words ?? 0),
      panelCount: Number(stats?.panels ?? 0),
    };
  });
}

export function getProject(id: string): Project | null {
  const found = row("SELECT * FROM projects WHERE id = ?", id);
  return found ? mapProject(found) : null;
}

export function requireProject(id: string): Project {
  const project = getProject(id);
  if (!project) throw new AppError("پروژه پیدا نشد.", 404, "project_missing");
  return project;
}

export function createProject(input: {
  title: string;
  subtitle?: string;
  description?: string;
  publishFormat?: "vertical" | "page";
  settings?: Partial<ProjectSettings>;
}): Project {
  const title = input.title.trim();
  if (!title) throw new AppError("نام پروژه خالی است.", 400, "empty_title");
  const id = newId();
  const now = nowIso();
  transaction(() => {
    run(
      `INSERT INTO projects (id, title, subtitle, description, language, publish_format, settings, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'fa', ?, ?, ?, ?)`,
      id,
      title,
      input.subtitle ?? "",
      input.description ?? "",
      input.publishFormat === "page" ? "page" : "vertical",
      JSON.stringify(mergeSettings(input.settings)),
      now,
      now,
    );
    const workId = newId();
    run(
      `INSERT INTO works (id, project_id, title, genre, synopsis, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, ?, ?)`,
      workId,
      id,
      title,
      input.description ?? "",
      now,
      now,
    );
    run(
      `INSERT INTO adaptations (id, project_id, work_id, title, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', ?, ?)`,
      newId(),
      id,
      workId,
      `${title} — اقتباس`,
      now,
      now,
    );
    const docId = newId();
    run(
      `INSERT INTO pagination_docs (id, project_id, format, title, page_width, page_height, gap, settings, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1200, 1800, 16, '{}', ?, ?)`,
      docId,
      id,
      input.publishFormat === "page" ? "page" : "vertical",
      "صفحه‌بندی اصلی",
      now,
      now,
    );
  });
  return requireProject(id);
}

export function updateProject(
  id: string,
  patch: Partial<Pick<Project, "title" | "subtitle" | "description" | "publishFormat">> & { settings?: Record<string, unknown> },
): Project {
  const project = requireProject(id);
  const patchSettings = (patch.settings ?? {}) as { caps?: Record<string, unknown> };
  const settings = patch.settings
    ? mergeSettings({
        ...project.settings,
        ...patch.settings,
        caps: { ...project.settings.caps, ...(patchSettings.caps ?? {}) },
      })
    : project.settings;
  run(
    `UPDATE projects SET title = ?, subtitle = ?, description = ?, publish_format = ?, settings = ?, updated_at = ? WHERE id = ?`,
    patch.title?.trim() || project.title,
    patch.subtitle ?? project.subtitle,
    patch.description ?? project.description,
    patch.publishFormat ?? project.publishFormat,
    JSON.stringify(settings),
    nowIso(),
    id,
  );
  return requireProject(id);
}

export function deleteProject(id: string): void {
  run("DELETE FROM projects WHERE id = ?", id);
}

export function defaultAdaptationId(projectId: string): string {
  const found = row("SELECT id FROM adaptations WHERE project_id = ? ORDER BY created_at LIMIT 1", projectId);
  if (!found) throw new AppError("نسخهٔ اقتباس پیدا نشد.", 404, "adaptation_missing");
  return String(found.id);
}

// ------------------------------------------------------------------ chapters

function mapChapter(r: Record<string, unknown>): Chapter {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    position: Number(r.position),
    title: String(r.title),
    summary: String(r.summary ?? ""),
    storyDate: r.story_date ? String(r.story_date) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function listChapters(projectId: string): Chapter[] {
  return rows("SELECT * FROM chapters WHERE project_id = ? ORDER BY position", projectId).map(mapChapter);
}

export function createChapter(projectId: string, title: string): Chapter {
  requireProject(projectId);
  const last = row("SELECT MAX(position) AS p FROM chapters WHERE project_id = ?", projectId);
  const position = Number(last?.p ?? 0) + 1;
  const id = newId();
  const now = nowIso();
  run(
    `INSERT INTO chapters (id, project_id, position, title, summary, story_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', NULL, ?, ?)`,
    id,
    projectId,
    position,
    title.trim() || `فصل ${position}`,
    now,
    now,
  );
  return mapChapter(row("SELECT * FROM chapters WHERE id = ?", id)!);
}

export function updateChapter(id: string, patch: { title?: string; summary?: string; storyDate?: string | null; position?: number }): Chapter {
  const found = row("SELECT * FROM chapters WHERE id = ?", id);
  if (!found) throw new AppError("فصل پیدا نشد.", 404, "chapter_missing");
  const current = mapChapter(found);
  run(
    `UPDATE chapters SET title = ?, summary = ?, story_date = ?, position = ?, updated_at = ? WHERE id = ?`,
    patch.title?.trim() || current.title,
    patch.summary ?? current.summary,
    patch.storyDate === undefined ? current.storyDate : patch.storyDate,
    patch.position ?? current.position,
    nowIso(),
    id,
  );
  return mapChapter(row("SELECT * FROM chapters WHERE id = ?", id)!);
}

export function deleteChapter(id: string): void {
  run("DELETE FROM chapters WHERE id = ?", id);
}

// --------------------------------------------------------------------- scenes

function mapScene(r: Record<string, unknown>): Scene {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    chapterId: String(r.chapter_id),
    position: Number(r.position),
    title: String(r.title),
    text: String(r.text ?? ""),
    objective: String(r.objective ?? ""),
    status: String(r.status ?? "draft"),
    storyDate: r.story_date ? String(r.story_date) : null,
    isFlashback: Number(r.is_flashback) === 1,
    wordCount: Number(r.word_count ?? 0),
    currentVersionId: r.current_version_id ? String(r.current_version_id) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapVersion(r: Record<string, unknown>): SceneVersion {
  return {
    id: String(r.id),
    sceneId: String(r.scene_id),
    version: Number(r.version),
    text: String(r.text),
    hash: String(r.hash),
    wordCount: Number(r.word_count),
    reason: String(r.reason),
    createdAt: String(r.created_at),
  };
}

export function listScenes(projectId: string): Scene[] {
  return rows(
    `SELECT s.* FROM scenes s JOIN chapters c ON c.id = s.chapter_id
     WHERE s.project_id = ? ORDER BY c.position, s.position`,
    projectId,
  ).map(mapScene);
}

export function getScene(id: string): Scene | null {
  const found = row("SELECT * FROM scenes WHERE id = ?", id);
  return found ? mapScene(found) : null;
}

export function requireScene(id: string): Scene {
  const scene = getScene(id);
  if (!scene) throw new AppError("صحنه پیدا نشد.", 404, "scene_missing");
  return scene;
}

export function createScene(input: {
  chapterId: string;
  title: string;
  text?: string;
  isFlashback?: boolean;
  storyDate?: string | null;
}): Scene {
  const chapter = row("SELECT * FROM chapters WHERE id = ?", input.chapterId);
  if (!chapter) throw new AppError("فصل پیدا نشد.", 404, "chapter_missing");
  const projectId = String(chapter.project_id);
  const last = row("SELECT MAX(position) AS p FROM scenes WHERE chapter_id = ?", input.chapterId);
  const id = newId();
  const now = nowIso();
  const text = input.text ?? "";
  run(
    `INSERT INTO scenes (id, project_id, chapter_id, position, title, text, objective, status, story_date, is_flashback, word_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '', 'draft', ?, ?, ?, ?, ?)`,
    id,
    projectId,
    input.chapterId,
    Number(last?.p ?? 0) + 1,
    input.title.trim() || "صحنهٔ تازه",
    text,
    input.storyDate ?? (chapter.story_date ? String(chapter.story_date) : null),
    input.isFlashback ? 1 : 0,
    wordCount(text),
    now,
    now,
  );
  return requireScene(id);
}

/**
 * ذخیرهٔ متن صحنه.
 * - برای هر تغییر محتوا نسخه ساخته می‌شود؛ ذخیرهٔ خودکار حداکثر هر ۹۰ ثانیه
 *   نسخهٔ تازه می‌سازد تا تاریخچه با هر کلید باد نکند.
 * - در خطای ذخیره، متن قبلی صحنه دست‌نخورده می‌ماند (تراکنش).
 */
export function saveSceneText(input: {
  sceneId: string;
  text: string;
  reason: "manual" | "autosave" | "restore" | "ai" | "seed";
  meta?: Record<string, unknown>;
}): { scene: Scene; version: SceneVersion | null } {
  const scene = requireScene(input.sceneId);
  const hash = sha256(input.text);
  const now = nowIso();
  let version: SceneVersion | null = null;
  const saved = transaction(() => {
    const last = row("SELECT * FROM scene_versions WHERE scene_id = ? ORDER BY version DESC LIMIT 1", scene.id);
    const sameContent = last ? String(last.hash) === hash : false;
    const shouldVersion =
      !sameContent &&
      (input.reason !== "autosave" ||
        !last ||
        String(last.reason) !== "autosave" ||
        Date.now() - new Date(String(last.created_at)).getTime() > 90_000);
    let versionId = scene.currentVersionId;
    if (shouldVersion) {
      const count = Number(last?.version ?? 0) + 1;
      const id = newId();
      run(
        `INSERT INTO scene_versions (id, scene_id, version, text, hash, word_count, reason, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        scene.id,
        count,
        input.text,
        hash,
        wordCount(input.text),
        input.reason,
        JSON.stringify(input.meta ?? {}),
        now,
      );
      versionId = id;
      version = { id, sceneId: scene.id, version: count, text: input.text, hash, wordCount: wordCount(input.text), reason: input.reason, createdAt: now };
    }
    run(
      `UPDATE scenes SET text = ?, word_count = ?, current_version_id = ?, updated_at = ? WHERE id = ?`,
      input.text,
      wordCount(input.text),
      versionId,
      now,
      scene.id,
    );
    return requireScene(scene.id);
  });
  return { scene: saved, version };
}

export function listSceneVersions(sceneId: string, limit = 50): SceneVersion[] {
  return rows("SELECT * FROM scene_versions WHERE scene_id = ? ORDER BY version DESC LIMIT ?", sceneId, limit).map(mapVersion);
}

export function updateSceneMeta(
  sceneId: string,
  patch: { title?: string; objective?: string; storyDate?: string | null; isFlashback?: boolean; status?: string; position?: number },
): Scene {
  const scene = requireScene(sceneId);
  run(
    `UPDATE scenes SET title = ?, objective = ?, story_date = ?, is_flashback = ?, status = ?, position = ?, updated_at = ? WHERE id = ?`,
    patch.title?.trim() || scene.title,
    patch.objective ?? scene.objective,
    patch.storyDate === undefined ? scene.storyDate : patch.storyDate,
    patch.isFlashback === undefined ? (scene.isFlashback ? 1 : 0) : patch.isFlashback ? 1 : 0,
    patch.status ?? scene.status,
    patch.position ?? scene.position,
    nowIso(),
    sceneId,
  );
  return requireScene(sceneId);
}

export function deleteScene(id: string): void {
  run("DELETE FROM scenes WHERE id = ?", id);
}

export interface SearchHit {
  kind: "scene" | "entity" | "fact";
  id: string;
  title: string;
  snippet: string;
  sceneId?: string;
  matches: number;
}

/** جست‌وجوی محلی فارسی در متن صحنه‌ها، موجودیت‌ها و واقعیت‌ها. */
export function searchProject(projectId: string, query: string): SearchHit[] {
  const needle = normalizePersian(query);
  if (!needle) return [];
  const hits: SearchHit[] = [];
  for (const scene of listScenes(projectId)) {
    const haystack = normalizePersian(`${scene.title}\n${scene.text}`);
    if (!haystack.includes(needle)) continue;
    const ranges = findMatches(scene.text, query);
    const start = Math.max(0, (ranges[0]?.start ?? 0) - 40);
    hits.push({
      kind: "scene",
      id: scene.id,
      sceneId: scene.id,
      title: scene.title,
      snippet: scene.text.slice(start, start + 160).replace(/\s+/g, " "),
      matches: ranges.length,
    });
  }
  for (const entity of rows("SELECT * FROM entities WHERE project_id = ?", projectId)) {
    const haystack = normalizePersian(`${entity.name} ${entity.summary}`);
    if (haystack.includes(needle)) {
      hits.push({ kind: "entity", id: String(entity.id), title: String(entity.name), snippet: String(entity.summary ?? ""), matches: 1 });
    }
  }
  for (const fact of rows("SELECT * FROM facts WHERE project_id = ? AND status != 'rejected'", projectId)) {
    const haystack = normalizePersian(`${fact.attribute} ${fact.value}`);
    if (haystack.includes(needle)) {
      hits.push({ kind: "fact", id: String(fact.id), title: String(fact.attribute), snippet: String(fact.value), matches: 1 });
    }
  }
  return hits.slice(0, 40);
}
