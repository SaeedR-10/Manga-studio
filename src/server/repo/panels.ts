import { newId, nowIso, parseJson, row, rows, run, transaction } from "../db";
import { AppError } from "../http";
import type { Panel, PanelCharacter, PanelDialogue } from "@/lib/types";
import type { PanelProposal } from "../validate";
import { listEntities } from "./world";

function mapPanel(r: Record<string, unknown>): Panel {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    adaptationId: String(r.adaptation_id),
    sceneId: String(r.scene_id),
    position: Number(r.position),
    title: String(r.title ?? ""),
    sourceSceneVersionId: r.source_scene_version_id ? String(r.source_scene_version_id) : null,
    sourceExcerpt: String(r.source_excerpt ?? ""),
    narrativeGoal: String(r.narrative_goal ?? ""),
    action: String(r.action ?? ""),
    characters: parseJson<PanelCharacter[]>(r.characters, []),
    locationId: r.location_id ? String(r.location_id) : null,
    timeLabel: String(r.time_label ?? ""),
    shotSize: String(r.shot_size ?? "medium") as Panel["shotSize"],
    cameraAngle: String(r.camera_angle ?? "eye") as Panel["cameraAngle"],
    gazeDirection: String(r.gaze_direction ?? ""),
    movement: String(r.movement ?? ""),
    emotion: String(r.emotion ?? ""),
    lighting: String(r.lighting ?? ""),
    costumes: String(r.costumes ?? ""),
    props: String(r.props ?? ""),
    dialogue: parseJson<PanelDialogue[]>(r.dialogue, []),
    styleProfileId: r.style_profile_id ? String(r.style_profile_id) : null,
    referencesUsed: parseJson<string[]>(r.references_used, []),
    identitySnapshot: parseJson<Record<string, unknown>>(r.identity_snapshot, {}),
    status: String(r.status ?? "draft"),
    needsReview: Number(r.needs_review) === 1,
    reviewReason: String(r.review_reason ?? ""),
    currentTakeId: r.current_take_id ? String(r.current_take_id) : null,
    imageAssetId: r.image_asset_id ? String(r.image_asset_id) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function listPanels(projectId: string, filter: { sceneId?: string; adaptationId?: string } = {}): Panel[] {
  if (filter.sceneId) {
    return rows("SELECT * FROM panels WHERE scene_id = ? ORDER BY position", filter.sceneId).map(mapPanel);
  }
  if (filter.adaptationId) {
    return rows("SELECT * FROM panels WHERE adaptation_id = ? ORDER BY position", filter.adaptationId).map(mapPanel);
  }
  return rows("SELECT * FROM panels WHERE project_id = ? ORDER BY created_at, position", projectId).map(mapPanel);
}

export function getPanel(id: string): Panel | null {
  const found = row("SELECT * FROM panels WHERE id = ?", id);
  return found ? mapPanel(found) : null;
}

export function requirePanel(id: string): Panel {
  const panel = getPanel(id);
  if (!panel) throw new AppError("پنل پیدا نشد.", 404, "panel_missing");
  return panel;
}

export function snapshotPanel(panel: Panel, reason: string): void {
  const last = row("SELECT MAX(version) AS v FROM panel_versions WHERE panel_id = ?", panel.id);
  run(
    `INSERT INTO panel_versions (id, panel_id, version, payload, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    newId(),
    panel.id,
    Number(last?.v ?? 0) + 1,
    JSON.stringify(panel),
    reason,
    nowIso(),
  );
}

/** ساخت پنل‌ها از پیشنهاد (محلی یا AI). هر پنل به نسخهٔ متن منبع گره می‌خورد. */
export function createPanels(input: {
  projectId: string;
  adaptationId: string;
  sceneId: string;
  sourceSceneVersionId: string | null;
  proposals: PanelProposal["panels"];
  startPosition?: number;
  identitySnapshot?: Record<string, unknown>;
}): Panel[] {
  const entities = listEntities(input.projectId);
  const byName = new Map(entities.map((e) => [e.name.trim(), e.id]));
  const locationByName = new Map(entities.filter((e) => e.kind === "location").map((e) => [e.name.trim(), e.id]));
  const start =
    input.startPosition ??
    Number(row("SELECT MAX(position) AS p FROM panels WHERE scene_id = ?", input.sceneId)?.p ?? 0);
  const created: string[] = [];
  transaction(() => {
    const now = nowIso();
    input.proposals.forEach((proposal, index) => {
      const id = newId();
      const characters: PanelCharacter[] = proposal.characters.map((c) => ({
        entityId: c.entityId && byName.size ? c.entityId : byName.get(c.name.trim()) ?? null,
        name: c.name,
        position: c.position,
        gaze: c.gaze,
        emotion: c.emotion,
        clothing: c.clothing,
        identityNote: c.identityNote,
      }));
      run(
        `INSERT INTO panels (id, project_id, adaptation_id, scene_id, position, title, source_scene_version_id, source_excerpt,
           narrative_goal, action, characters, location_id, time_label, shot_size, camera_angle, gaze_direction, movement,
           emotion, lighting, costumes, props, dialogue, style_profile_id, references_used, identity_snapshot, status,
           needs_review, review_reason, current_take_id, image_asset_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '[]', ?, 'draft', 0, '', NULL, NULL, ?, ?)`,
        id,
        input.projectId,
        input.adaptationId,
        input.sceneId,
        start + index + 1,
        proposal.title || `پنل ${start + index + 1}`,
        input.sourceSceneVersionId,
        proposal.sourceExcerpt,
        proposal.narrativeGoal,
        proposal.action,
        JSON.stringify(characters),
        locationByName.get(proposal.location?.trim() ?? "") ?? null,
        proposal.timeLabel,
        proposal.shotSize,
        proposal.cameraAngle,
        proposal.gazeDirection,
        proposal.movement,
        proposal.emotion,
        proposal.lighting,
        proposal.costumes,
        proposal.props,
        JSON.stringify(proposal.dialogue),
        JSON.stringify(input.identitySnapshot ?? {}),
        now,
        now,
      );
      created.push(id);
    });
  });
  return created.map((id) => requirePanel(id));
}

export function updatePanel(
  id: string,
  patch: Partial<Omit<Panel, "id" | "projectId" | "createdAt" | "updatedAt" | "position">> & { reviewReason?: string; needsReview?: boolean },
  reason = "manual",
): Panel {
  const current = requirePanel(id);
  snapshotPanel(current, reason);
  const next: Panel = {
    ...current,
    ...patch,
    characters: patch.characters ?? current.characters,
    dialogue: patch.dialogue ?? current.dialogue,
    referencesUsed: patch.referencesUsed ?? current.referencesUsed,
    updatedAt: nowIso(),
  };
  run(
    `UPDATE panels SET title = ?, source_excerpt = ?, narrative_goal = ?, action = ?, characters = ?, location_id = ?, time_label = ?,
       shot_size = ?, camera_angle = ?, gaze_direction = ?, movement = ?, emotion = ?, lighting = ?, costumes = ?, props = ?,
       dialogue = ?, style_profile_id = ?, references_used = ?, status = ?, needs_review = ?, review_reason = ?, updated_at = ?
     WHERE id = ?`,
    next.title,
    next.sourceExcerpt,
    next.narrativeGoal,
    next.action,
    JSON.stringify(next.characters),
    next.locationId,
    next.timeLabel,
    next.shotSize,
    next.cameraAngle,
    next.gazeDirection,
    next.movement,
    next.emotion,
    next.lighting,
    next.costumes,
    next.props,
    JSON.stringify(next.dialogue),
    next.styleProfileId,
    JSON.stringify(next.referencesUsed),
    next.status,
    next.needsReview ? 1 : 0,
    next.reviewReason,
    next.updatedAt,
    id,
  );
  return requirePanel(id);
}

export function deletePanel(id: string): void {
  run("DELETE FROM panels WHERE id = ?", id);
}

/**
 * تغییر منبع (متن صحنه یا مرجع) پنل را «نیازمند بازبینی» می‌کند.
 * هیچ تولید/هزینه‌ای خودکار آغاز نمی‌شود.
 */
export function markPanelsStale(sceneId: string, reason: string): number {
  const result = run(
    "UPDATE panels SET needs_review = 1, review_reason = ?, updated_at = ? WHERE scene_id = ? AND (needs_review = 0 OR review_reason != ?)",
    reason,
    nowIso(),
    sceneId,
    reason,
  );
  return Number(result.changes);
}

/**
 * تغییر موجودیت‌های مؤثر (نسخهٔ هویت، لباس، مکان، شیء یا واقعیت مرتبط) پنل‌هایی
 * را که آن‌ها را به‌کار برده‌اند «نیازمند بازبینی» می‌کند. تصمیم همیشه با کاربر
 * است؛ تصویری بازتولید نمی‌شود و هزینه‌ای ایجاد نمی‌گردد.
 */
export function markPanelsForEntities(projectId: string, entityIds: string[], reason: string): number {
  if (entityIds.length === 0) return 0;
  const wanted = new Set(entityIds);
  const candidates = rows(
    `SELECT p.id, p.characters, p.location_id, p.scene_id, ss.present_entities, ss.location_id AS state_location
       FROM panels p LEFT JOIN scene_state ss ON ss.scene_id = p.scene_id
      WHERE p.project_id = ?`,
    projectId,
  );
  let marked = 0;
  for (const candidate of candidates) {
    const characters = parseJson<PanelCharacter[]>(candidate.characters, []);
    const present = parseJson<string[]>(candidate.present_entities, []);
    const hit =
      characters.some((c) => c.entityId && wanted.has(c.entityId)) ||
      present.some((id) => wanted.has(id)) ||
      (candidate.location_id && wanted.has(String(candidate.location_id))) ||
      (candidate.state_location && wanted.has(String(candidate.state_location)));
    if (hit) {
      markPanelStale(String(candidate.id), reason);
      marked += 1;
    }
  }
  return marked;
}

/** تغییر سبک پیش‌فرض یا سبک یک پنل، پنل‌های وابسته را نیازمند بازبینی می‌کند. */
export function markPanelsForStyle(projectId: string, styleId: string, reason: string): number {
  const result = run(
    "UPDATE panels SET needs_review = 1, review_reason = ?, updated_at = ? WHERE project_id = ? AND (style_profile_id = ? OR style_profile_id IS NULL)",
    reason,
    nowIso(),
    projectId,
    styleId,
  );
  return Number(result.changes);
}

export function markPanelsForReferences(projectId: string, referenceId: string, entityIds: string[], reason: string): number {
  const wanted = new Set(entityIds);
  const candidates = rows("SELECT id, references_used, characters FROM panels WHERE project_id = ?", projectId);
  let marked = 0;
  for (const candidate of candidates) {
    const used = parseJson<string[]>(candidate.references_used, []);
    const characters = parseJson<PanelCharacter[]>(candidate.characters, []);
    const hit =
      used.includes(referenceId) || characters.some((c) => c.entityId && wanted.has(c.entityId));
    if (hit) {
      markPanelStale(String(candidate.id), reason);
      marked += 1;
    }
  }
  return marked;
}

export function markPanelStale(panelId: string, reason: string): void {
  run("UPDATE panels SET needs_review = 1, review_reason = ?, updated_at = ? WHERE id = ?", reason, nowIso(), panelId);
}

export function setPanelReferences(panelId: string, referenceIds: string[], identitySnapshot?: Record<string, unknown>): Panel {
  const panel = requirePanel(panelId);
  snapshotPanel(panel, "references");
  run(
    "UPDATE panels SET references_used = ?, identity_snapshot = ?, updated_at = ? WHERE id = ?",
    JSON.stringify(referenceIds),
    JSON.stringify(identitySnapshot ?? panel.identitySnapshot),
    nowIso(),
    panelId,
  );
  return requirePanel(panelId);
}

export function reorderPanels(sceneId: string, orderedIds: string[]): void {
  transaction(() => {
    orderedIds.forEach((id, index) => {
      run("UPDATE panels SET position = ?, updated_at = ? WHERE id = ? AND scene_id = ?", index + 1, nowIso(), id, sceneId);
    });
  });
}

export function panelVersions(panelId: string) {
  return rows("SELECT * FROM panel_versions WHERE panel_id = ? ORDER BY version DESC LIMIT 40", panelId).map((r) => ({
    id: String(r.id),
    version: Number(r.version),
    reason: String(r.reason),
    createdAt: String(r.created_at),
    payload: parseJson<Panel>(r.payload, null as unknown as Panel),
  }));
}
