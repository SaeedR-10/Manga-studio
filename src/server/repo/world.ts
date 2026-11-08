import { newId, nowIso, parseJson, row, rows, run } from "../db";
import { AppError } from "../http";
import type { CanonEntry } from "../prompts";
import type { Entity, EntityKind, EntityVersion, Fact, FactStatus } from "@/lib/types";
import { buildCanonView, FactLike, inScope, resolveVersion, VersionLike } from "../canon";

function mapEntity(r: Record<string, unknown>): Entity {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    kind: String(r.kind) as EntityKind,
    name: String(r.name),
    summary: String(r.summary ?? ""),
    details: parseJson(r.details, {}),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapVersion(r: Record<string, unknown>): EntityVersion {
  return {
    id: String(r.id),
    entityId: String(r.entity_id),
    version: Number(r.version),
    label: String(r.label ?? ""),
    layer: String(r.layer ?? "identity"),
    payload: parseJson(r.payload, {}),
    fixedTraits: Number(r.fixed_traits) === 1,
    validFrom: r.valid_from ? String(r.valid_from) : null,
    validTo: r.valid_to ? String(r.valid_to) : null,
    notes: String(r.notes ?? ""),
    createdAt: String(r.created_at),
    approvedAt: r.approved_at ? String(r.approved_at) : null,
  };
}

function mapFact(r: Record<string, unknown>): Fact {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    subjectType: String(r.subject_type) as "entity" | "project",
    subjectId: String(r.subject_id ?? ""),
    attribute: String(r.attribute),
    value: String(r.value),
    sourceType: String(r.source_type),
    sourceRef: String(r.source_ref ?? ""),
    status: String(r.status) as FactStatus,
    scopeStart: r.scope_start ? String(r.scope_start) : null,
    scopeEnd: r.scope_end ? String(r.scope_end) : null,
    conflictGroup: r.conflict_group ? String(r.conflict_group) : null,
    resolutionNote: String(r.resolution_note ?? ""),
    createdBy: String(r.created_by ?? "user"),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

// ------------------------------------------------------------------ entities

export function listEntities(projectId: string, kind?: string): Entity[] {
  const result = kind
    ? rows("SELECT * FROM entities WHERE project_id = ? AND kind = ? ORDER BY name", projectId, kind)
    : rows("SELECT * FROM entities WHERE project_id = ? ORDER BY kind, name", projectId);
  return result.map(mapEntity);
}

export function getEntity(id: string): Entity | null {
  const found = row("SELECT * FROM entities WHERE id = ?", id);
  return found ? mapEntity(found) : null;
}

export function createEntity(input: {
  projectId: string;
  kind: EntityKind;
  name: string;
  summary?: string;
  details?: Record<string, unknown>;
}): Entity {
  const name = input.name.trim();
  if (!name) throw new AppError("نام موجودیت خالی است.", 400, "empty_name");
  const id = newId();
  const now = nowIso();
  run(
    `INSERT INTO entities (id, project_id, kind, name, summary, details, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.projectId,
    input.kind,
    name,
    input.summary ?? "",
    JSON.stringify(input.details ?? {}),
    now,
    now,
  );
  return getEntity(id)!;
}

export function updateEntity(id: string, patch: { name?: string; summary?: string; details?: Record<string, unknown> }): Entity {
  const entity = getEntity(id);
  if (!entity) throw new AppError("موجودیت پیدا نشد.", 404, "entity_missing");
  run(
    "UPDATE entities SET name = ?, summary = ?, details = ?, updated_at = ? WHERE id = ?",
    patch.name?.trim() || entity.name,
    patch.summary ?? entity.summary,
    JSON.stringify(patch.details ?? entity.details),
    nowIso(),
    id,
  );
  return getEntity(id)!;
}

export function deleteEntity(id: string): void {
  run("DELETE FROM entities WHERE id = ?", id);
}

export function listEntityVersions(entityId: string): EntityVersion[] {
  return rows("SELECT * FROM entity_versions WHERE entity_id = ? ORDER BY version DESC", entityId).map(mapVersion);
}

export function addEntityVersion(input: {
  entityId: string;
  label: string;
  layer: string;
  payload: Record<string, unknown>;
  fixedTraits?: boolean;
  validFrom?: string | null;
  validTo?: string | null;
  notes?: string;
  approved?: boolean;
}): EntityVersion {
  const last = row("SELECT MAX(version) AS v FROM entity_versions WHERE entity_id = ?", input.entityId);
  const version = Number(last?.v ?? 0) + 1;
  const id = newId();
  const now = nowIso();
  run(
    `INSERT INTO entity_versions (id, entity_id, version, label, layer, payload, fixed_traits, valid_from, valid_to, notes, created_at, approved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.entityId,
    version,
    input.label,
    input.layer,
    JSON.stringify(input.payload),
    input.fixedTraits ? 1 : 0,
    input.validFrom ?? null,
    input.validTo ?? null,
    input.notes ?? "",
    now,
    input.approved ? now : null,
  );
  return mapVersion(row("SELECT * FROM entity_versions WHERE id = ?", id)!);
}

export function approveEntityVersion(id: string): EntityVersion {
  const found = row("SELECT * FROM entity_versions WHERE id = ?", id);
  if (!found) throw new AppError("نسخه پیدا نشد.", 404, "version_missing");
  run("UPDATE entity_versions SET approved_at = ? WHERE id = ?", nowIso(), id);
  return mapVersion(row("SELECT * FROM entity_versions WHERE id = ?", id)!);
}

export function deleteEntityVersion(id: string): void {
  run("DELETE FROM entity_versions WHERE id = ?", id);
}

/** نسخه‌ای که در یک زمان داستانی معتبر است (فقط تأییدشده‌ها). */
export function versionsAt(entityId: string, at: string | null) {
  const versions: VersionLike[] = listEntityVersions(entityId).map((v) => ({
    id: v.id,
    entityId: v.entityId,
    layer: v.layer,
    label: v.label,
    payload: v.payload,
    validFrom: v.validFrom,
    validTo: v.validTo,
    approvedAt: v.approvedAt,
  }));
  const layers = [...new Set(versions.map((v) => v.layer))];
  const out: Array<ReturnType<typeof resolveVersion>> = [];
  for (const layer of layers) {
    out.push(resolveVersion(versions, { entityId, layer, at }));
  }
  return out;
}

// --------------------------------------------------------------------- facts

export function listFacts(projectId: string, options: { subjectId?: string; status?: FactStatus } = {}): Fact[] {
  let sql = "SELECT * FROM facts WHERE project_id = ?";
  const params: unknown[] = [projectId];
  if (options.subjectId) {
    sql += " AND subject_id = ?";
    params.push(options.subjectId);
  }
  if (options.status) {
    sql += " AND status = ?";
    params.push(options.status);
  }
  sql += " ORDER BY updated_at DESC";
  return rows(sql, ...params).map(mapFact);
}

export function getFact(id: string): Fact | null {
  const found = row("SELECT * FROM facts WHERE id = ?", id);
  return found ? mapFact(found) : null;
}

export function createFact(input: {
  projectId: string;
  subjectType?: "entity" | "project";
  subjectId?: string;
  attribute: string;
  value: string;
  sourceType: string;
  sourceRef?: string;
  status?: FactStatus;
  scopeStart?: string | null;
  scopeEnd?: string | null;
  createdBy?: string;
  resolutionNote?: string;
}): Fact {
  if (!input.attribute.trim()) throw new AppError("نام ویژگی خالی است.", 400, "empty_attribute");
  if (!input.value.trim()) throw new AppError("مقدار واقعیت خالی است.", 400, "empty_value");
  const id = newId();
  const now = nowIso();
  run(
    `INSERT INTO facts (id, project_id, subject_type, subject_id, attribute, value, source_type, source_ref, status, scope_start, scope_end, conflict_group, resolution_note, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    id,
    input.projectId,
    input.subjectType ?? "entity",
    input.subjectId ?? "",
    input.attribute.trim(),
    input.value.trim(),
    input.sourceType,
    input.sourceRef ?? "",
    input.status ?? "proposed",
    input.scopeStart ?? null,
    input.scopeEnd ?? null,
    input.resolutionNote ?? "",
    input.createdBy ?? "user",
    now,
    now,
  );
  return getFact(id)!;
}

export function setFactStatus(id: string, status: FactStatus, note = ""): Fact {
  const fact = getFact(id);
  if (!fact) throw new AppError("واقعیت پیدا نشد.", 404, "fact_missing");
  run("UPDATE facts SET status = ?, resolution_note = ?, updated_at = ? WHERE id = ?", status, note || fact.resolutionNote, nowIso(), id);
  return getFact(id)!;
}

export function updateFact(
  id: string,
  patch: { value?: string; scopeStart?: string | null; scopeEnd?: string | null; attribute?: string },
): Fact {
  const fact = getFact(id);
  if (!fact) throw new AppError("واقعیت پیدا نشد.", 404, "fact_missing");
  run(
    "UPDATE facts SET value = ?, attribute = ?, scope_start = ?, scope_end = ?, updated_at = ? WHERE id = ?",
    patch.value?.trim() || fact.value,
    patch.attribute?.trim() || fact.attribute,
    patch.scopeStart === undefined ? fact.scopeStart : patch.scopeStart,
    patch.scopeEnd === undefined ? fact.scopeEnd : patch.scopeEnd,
    nowIso(),
    id,
  );
  return getFact(id)!;
}

export function deleteFact(id: string): void {
  run("DELETE FROM facts WHERE id = ?", id);
}

export function factLikes(projectId: string, at: string | null): FactLike[] {
  return listFacts(projectId).map((f) => ({
    id: f.id,
    subjectId: f.subjectId,
    attribute: f.attribute,
    value: f.value,
    status: f.status,
    sourceType: f.sourceType,
    sourceRef: f.sourceRef,
    scopeStart: f.scopeStart,
    scopeEnd: f.scopeEnd,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    conflictGroup: f.conflictGroup,
    createdBy: f.createdBy,
  }));
}

export interface IdentityConflictCandidate {
  id: string;
  label: string;
  layer: string;
  version: number;
  approvedAt: string | null;
  validFrom: string | null;
  validTo: string | null;
  payload: Record<string, unknown>;
}

export interface IdentityConflict {
  entityId: string;
  entityName: string;
  layer: string;
  reason: string;
  candidates: IdentityConflictCandidate[];
}

/**
 * اطلاعات قطعی معتبر در زمان یک صحنه، برای ساخت پرامپت.
 * نسخه‌های ظاهریِ متعارض حذف نمی‌شوند: هم در `conflicts` گزارش می‌شوند و هم
 * ساختارشان با شناسه/لایه/منشأ برمی‌گردد تا تولید تا تصمیم صریح کاربر متوقف شود.
 */
export function canonEntriesAt(projectId: string, input: {
  storyDate: string | null;
  entityIds: string[];
}): { entries: CanonEntry[]; conflicts: string[]; identityConflicts: IdentityConflict[] } {
  const facts = factLikes(projectId, input.storyDate);
  const view = buildCanonView(facts, { subjectIds: input.entityIds, at: input.storyDate });
  const names = new Map(listEntities(projectId).map((e) => [e.id, e.name]));
  const entries: CanonEntry[] = view.resolved.map((r) => ({
    subject: names.get(r.subjectId) ?? (r.subjectId || "جهان داستان"),
    attribute: r.attribute,
    value: r.value,
    status: r.status,
    reason: r.reason,
    sourceRef: r.sourceRef,
  }));
  const conflicts = [...view.conflicts].map((group) =>
    group
      .map((f) => `${names.get(f.subjectId) ?? f.subjectId} / ${f.attribute}: ${f.value}`)
      .join(" ←→ "),
  );
  const identityConflicts: IdentityConflict[] = [];
  for (const entityId of input.entityIds) {
    const entityName = names.get(entityId) ?? entityId;
    for (const layer of versionsAt(entityId, input.storyDate)) {
      if (layer.status === "conflict") {
        // نسخه‌های تأییدشدهٔ هم‌زمان با مقدار متفاوت: نه یکی را بی‌صدا انتخاب
        // می‌کنیم و نه هویت را حذف می‌کنیم؛ تعارض با منشأ کامل گزارش می‌شود.
        const layerName = layer.candidates[0]?.layer ?? "identity";
        const candidates: IdentityConflictCandidate[] = layer.candidates.map((v) => ({
          id: v.id,
          label: v.label,
          layer: v.layer,
          version: 0,
          approvedAt: v.approvedAt,
          validFrom: v.validFrom,
          validTo: v.validTo,
          payload: v.payload,
        }));
        identityConflicts.push({
          entityId,
          entityName,
          layer: layerName,
          reason: layer.reason,
          candidates,
        });
        conflicts.push(
          `${entityName} / ${layerName}: ${candidates
            .map((c) => `${c.label || c.id.slice(0, 8)}${c.validFrom ? ` از ${c.validFrom}` : ""}${c.validTo ? ` تا ${c.validTo}` : ""}`)
            .join(" ←→ ")} — چند نسخهٔ تأییدشده در همین بازه معتبرند و انتخاب باید صریح باشد.`,
        );
        continue;
      }
      if (layer.status !== "resolved" || !layer.chosen) continue;
      const payloadText = Object.entries(layer.chosen.payload)
        .filter(([, v]) => typeof v === "string" || typeof v === "number")
        .map(([k, v]) => `${k}: ${v}`)
        .join("؛ ");
      entries.push({
        subject: entityName,
        attribute: `${layer.chosen.layer}${layer.chosen.label ? ` (${layer.chosen.label})` : ""}`,
        value: payloadText || "—",
        status: "resolved",
        reason: "نسخهٔ تأییدشدهٔ معتبر در همین زمان",
        sourceRef: layer.chosen.id,
      });
    }
  }
  return { entries, conflicts, identityConflicts };
}

/** ویژگی‌هایی که در زمان صحنه تعارض دارند یا نامشخص‌اند (برای هشدار رابط). */
export function canonWarnings(projectId: string, input: { storyDate: string | null; entityIds: string[] }) {
  const facts = factLikes(projectId, input.storyDate);
  const view = buildCanonView(facts, { subjectIds: input.entityIds, at: input.storyDate });
  return {
    conflicts: view.conflicts.map((g) => g.map((f) => ({ id: f.id, attribute: f.attribute, value: f.value }))),
    unknown: view.unknown,
  };
}

// ----------------------------------------------------------- character memory

export interface KnowledgeRow {
  id: string;
  characterId: string;
  factId: string | null;
  knowledge: "knows" | "suspects" | "unaware";
  revealScenePosition: number | null;
  note: string;
}

export function listKnowledge(characterId: string): KnowledgeRow[] {
  return rows("SELECT * FROM character_knowledge WHERE character_id = ?", characterId).map((r) => ({
    id: String(r.id),
    characterId: String(r.character_id),
    factId: r.fact_id ? String(r.fact_id) : null,
    knowledge: String(r.knowledge) as KnowledgeRow["knowledge"],
    revealScenePosition: null,
    note: String(r.note ?? ""),
  }));
}

export function upsertKnowledge(input: {
  projectId: string;
  characterId: string;
  factId: string;
  knowledge: "knows" | "suspects" | "unaware";
  revealSceneId?: string | null;
  note?: string;
}): void {
  const existing = row(
    "SELECT id FROM character_knowledge WHERE character_id = ? AND fact_id = ?",
    input.characterId,
    input.factId,
  );
  if (existing) {
    run(
      "UPDATE character_knowledge SET knowledge = ?, reveal_scene_id = ?, note = ? WHERE id = ?",
      input.knowledge,
      input.revealSceneId ?? null,
      input.note ?? "",
      String(existing.id),
    );
    return;
  }
  run(
    `INSERT INTO character_knowledge (id, project_id, character_id, fact_id, knowledge, reveal_scene_id, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    newId(),
    input.projectId,
    input.characterId,
    input.factId,
    input.knowledge,
    input.revealSceneId ?? null,
    input.note ?? "",
    nowIso(),
  );
}

export function knowledgeForProject(projectId: string) {
  return rows(
    `SELECT k.*, s.chapter_id, s.position AS scene_position, c.position AS chapter_position
       FROM character_knowledge k
       LEFT JOIN scenes s ON s.id = k.reveal_scene_id
       LEFT JOIN chapters c ON c.id = s.chapter_id
      WHERE k.project_id = ?`,
    projectId,
  ).map((r) => ({
    characterId: String(r.character_id),
    factId: r.fact_id ? String(r.fact_id) : "",
    knowledge: String(r.knowledge) as "knows" | "suspects" | "unaware",
    revealScenePosition:
      r.chapter_position == null ? null : Number(r.chapter_position) * 1000 + Number(r.scene_position ?? 0),
  }));
}

// ---------------------------------------------------------------- chronology

export function listTimeline(projectId: string) {
  return rows("SELECT * FROM timeline_events WHERE project_id = ? ORDER BY story_date, created_at", projectId).map((r) => ({
    id: String(r.id),
    sceneId: r.scene_id ? String(r.scene_id) : null,
    label: String(r.label),
    storyDate: r.story_date ? String(r.story_date) : null,
    kind: String(r.kind),
    note: String(r.note ?? ""),
  }));
}

export function createTimelineEvent(input: {
  projectId: string;
  label: string;
  storyDate: string | null;
  sceneId?: string | null;
  kind?: string;
  note?: string;
}): { id: string } {
  const id = newId();
  run(
    `INSERT INTO timeline_events (id, project_id, scene_id, label, story_date, kind, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.projectId,
    input.sceneId ?? null,
    input.label,
    input.storyDate,
    input.kind ?? "event",
    input.note ?? "",
    nowIso(),
  );
  return { id };
}

export function deleteTimelineEvent(id: string): void {
  run("DELETE FROM timeline_events WHERE id = ?", id);
}

// -------------------------------------------------------------- scene state

export function getSceneState(sceneId: string) {
  const found = row("SELECT * FROM scene_state WHERE scene_id = ?", sceneId);
  if (!found) return { sceneId, locationId: null as string | null, presentEntities: [] as string[], overrides: {} as Record<string, unknown> };
  return {
    sceneId,
    locationId: found.location_id ? String(found.location_id) : null,
    presentEntities: parseJson<string[]>(found.present_entities, []),
    overrides: parseJson<Record<string, unknown>>(found.overrides, {}),
  };
}

export function saveSceneState(input: {
  sceneId: string;
  locationId?: string | null;
  presentEntities?: string[];
  overrides?: Record<string, unknown>;
}): void {
  const existing = row("SELECT id FROM scene_state WHERE scene_id = ?", input.sceneId);
  if (existing) {
    run(
      "UPDATE scene_state SET location_id = ?, present_entities = ?, overrides = ?, updated_at = ? WHERE scene_id = ?",
      input.locationId ?? null,
      JSON.stringify(input.presentEntities ?? []),
      JSON.stringify(input.overrides ?? {}),
      nowIso(),
      input.sceneId,
    );
    return;
  }
  run(
    `INSERT INTO scene_state (id, scene_id, location_id, present_entities, overrides, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    newId(),
    input.sceneId,
    input.locationId ?? null,
    JSON.stringify(input.presentEntities ?? []),
    JSON.stringify(input.overrides ?? {}),
    nowIso(),
  );
}

// ------------------------------------------------------------------- styles

export function listStyles(projectId: string) {
  return rows("SELECT * FROM style_profiles WHERE project_id = ? ORDER BY is_default DESC, name", projectId).map((r) => ({
    id: String(r.id),
    name: String(r.name),
    description: String(r.description ?? ""),
    palette: String(r.palette ?? ""),
    linework: String(r.linework ?? ""),
    notes: String(r.notes ?? ""),
    isDefault: Number(r.is_default) === 1,
  }));
}

export function createStyle(input: {
  projectId: string;
  name: string;
  description?: string;
  palette?: string;
  linework?: string;
  notes?: string;
  isDefault?: boolean;
}): { id: string } {
  const id = newId();
  const now = nowIso();
  if (input.isDefault) run("UPDATE style_profiles SET is_default = 0 WHERE project_id = ?", input.projectId);
  run(
    `INSERT INTO style_profiles (id, project_id, name, description, palette, linework, notes, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.projectId,
    input.name.trim() || "سبک تازه",
    input.description ?? "",
    input.palette ?? "",
    input.linework ?? "",
    input.notes ?? "",
    input.isDefault ? 1 : 0,
    now,
    now,
  );
  return { id };
}

export function defaultStyle(projectId: string) {
  return listStyles(projectId).find((s) => s.isDefault) ?? listStyles(projectId)[0] ?? null;
}

export function factLooksActive(fact: Fact, at: string | null): boolean {
  return inScope({ scopeStart: fact.scopeStart, scopeEnd: fact.scopeEnd }, at);
}

/**
 * وابستگی‌های یک موجودیت: صحنه‌هایی که در آن‌ها حاضر است، پنل‌هایی که در
 * کادرند و مراجع تأییدشده‌ای که به آن وصل‌اند. برای نمایش «چه چیزی به این
 * نسخهٔ هویت وابسته است» استفاده می‌شود.
 */
export function entityDependencies(entityId: string): {
  scenes: Array<{ id: string; title: string; storyDate: string | null }>;
  panels: Array<{ id: string; title: string; sceneId: string }>;
} {
  const scenes = rows(
    `SELECT s.id, s.title, s.story_date
       FROM scene_state ss JOIN scenes s ON s.id = ss.scene_id
      WHERE ss.present_entities LIKE ?
      ORDER BY s.created_at`,
    `%"${entityId}"%`,
  ).map((r) => ({ id: String(r.id), title: String(r.title), storyDate: r.story_date ? String(r.story_date) : null }));
  const panels = rows(
    `SELECT id, title, scene_id FROM panels WHERE characters LIKE ? ORDER BY position`,
    `%"entityId":"${entityId}"%`,
  ).map((r) => ({ id: String(r.id), title: String(r.title), sceneId: String(r.scene_id) }));
  return { scenes, panels };
}
