import { newId, nowIso, parseJson, row, rows, run } from "../db";
import { AppError } from "../http";
import type { ReferenceAsset } from "@/lib/types";
import type { RefCandidate } from "../refs";

function mapReference(r: Record<string, unknown>): ReferenceAsset {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    assetId: String(r.asset_id),
    title: String(r.title),
    description: String(r.description ?? ""),
    origin: String(r.origin) as ReferenceAsset["origin"],
    licenseNote: String(r.license_note ?? ""),
    status: String(r.status) as ReferenceAsset["status"],
    version: Number(r.version ?? 1),
    supersedesId: r.supersedes_id ? String(r.supersedes_id) : null,
    entityIds: parseJson<string[]>(r.entities, []),
    roles: parseJson<string[]>(r.roles, []),
    tags: parseJson<string[]>(r.tags, []),
    approvedAt: r.approved_at ? String(r.approved_at) : null,
    validFrom: r.valid_from ? String(r.valid_from) : null,
    validTo: r.valid_to ? String(r.valid_to) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    thumbUrl: `/api/assets/${String(r.asset_id)}?variant=thumb`,
  };
}

export function listReferences(projectId: string): ReferenceAsset[] {
  return rows("SELECT * FROM reference_assets WHERE project_id = ? ORDER BY created_at DESC", projectId).map(mapReference);
}

export function getReference(id: string): ReferenceAsset | null {
  const found = row("SELECT * FROM reference_assets WHERE id = ?", id);
  return found ? mapReference(found) : null;
}

export function requireReference(id: string): ReferenceAsset {
  const ref = getReference(id);
  if (!ref) throw new AppError("مرجع پیدا نشد.", 404, "reference_missing");
  return ref;
}

export function createReference(input: {
  projectId: string;
  assetId: string;
  title: string;
  description?: string;
  origin?: ReferenceAsset["origin"];
  licenseNote?: string;
  entityIds?: string[];
  roles?: string[];
  tags?: string[];
  status?: ReferenceAsset["status"];
  validFrom?: string | null;
  validTo?: string | null;
}): ReferenceAsset {
  const id = newId();
  const now = nowIso();
  run(
    `INSERT INTO reference_assets (id, project_id, asset_id, title, description, origin, license_note, status, version, supersedes_id, entities, roles, tags, approved_at, valid_from, valid_to, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.projectId,
    input.assetId,
    input.title.trim() || "مرجع تازه",
    input.description ?? "",
    input.origin ?? "local_upload",
    input.licenseNote ?? "",
    input.status ?? "draft",
    JSON.stringify(input.entityIds ?? []),
    JSON.stringify(input.roles ?? []),
    JSON.stringify(input.tags ?? []),
    input.status === "approved" ? now : null,
    input.validFrom ?? null,
    input.validTo ?? null,
    now,
    now,
  );
  return requireReference(id);
}

export function updateReference(
  id: string,
  patch: Partial<
    Pick<ReferenceAsset, "title" | "description" | "licenseNote" | "status" | "entityIds" | "roles" | "tags" | "validFrom" | "validTo">
  >,
): ReferenceAsset {
  const ref = requireReference(id);
  const now = nowIso();
  const status = patch.status ?? ref.status;
  run(
    `UPDATE reference_assets SET title = ?, description = ?, license_note = ?, status = ?, entities = ?, roles = ?, tags = ?, approved_at = ?,
       valid_from = ?, valid_to = ?, updated_at = ? WHERE id = ?`,
    patch.title?.trim() || ref.title,
    patch.description ?? ref.description,
    patch.licenseNote ?? ref.licenseNote,
    status,
    JSON.stringify(patch.entityIds ?? ref.entityIds),
    JSON.stringify(patch.roles ?? ref.roles),
    JSON.stringify(patch.tags ?? ref.tags),
    status === "approved" ? ref.approvedAt ?? now : ref.approvedAt,
    patch.validFrom === undefined ? ref.validFrom : patch.validFrom,
    patch.validTo === undefined ? ref.validTo : patch.validTo,
    now,
    id,
  );
  return requireReference(id);
}

/**
 * نسخهٔ تازه از یک مرجع تأییدشده. نسخهٔ قبلی دست‌نخورده می‌ماند و
 * خروجی تازه به‌طور خودکار جای آن را نمی‌گیرد.
 */
export function newReferenceVersion(id: string, assetId: string): ReferenceAsset {
  const ref = requireReference(id);
  const newRef = newId();
  const now = nowIso();
  run(
    `INSERT INTO reference_assets (id, project_id, asset_id, title, description, origin, license_note, status, version, supersedes_id, entities, roles, tags, approved_at, valid_from, valid_to, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    newRef,
    ref.projectId,
    assetId,
    `${ref.title} (نسخهٔ ${ref.version + 1})`,
    ref.description,
    "ai_output",
    ref.licenseNote,
    ref.version + 1,
    ref.id,
    JSON.stringify(ref.entityIds),
    JSON.stringify(ref.roles),
    JSON.stringify(ref.tags),
    ref.validFrom,
    ref.validTo,
    now,
    now,
  );
  return requireReference(newRef);
}

export function deleteReference(id: string): void {
  run("DELETE FROM reference_assets WHERE id = ?", id);
}

export function referenceCandidates(projectId: string): RefCandidate[] {
  return listReferences(projectId).map((r) => ({
    id: r.id,
    assetId: r.assetId,
    title: r.title,
    status: r.status,
    roles: r.roles,
    entityIds: r.entityIds,
    version: r.version,
    createdAt: r.createdAt,
    origin: r.origin,
  }));
}

/**
 * مراجع بر پایهٔ شناسه‌ها، با حفظ دقیق ترتیب درخواستی caller.
 * SQL با IN هیچ ترتیبی تضمین نمی‌کند؛ بنابراین نتیجه با نقشهٔ شناسه بازچینی
 * می‌شود. شناسه‌های پیدا‌نشده در نتیجه غایب‌اند تا caller آن‌ها را گزارش کند.
 */
export function referencesByIds(ids: string[]): ReferenceAsset[] {
  if (ids.length === 0) return [];
  const unique = [...new Set(ids)];
  const placeholders = unique.map(() => "?").join(",");
  const found = new Map(
    rows(`SELECT * FROM reference_assets WHERE id IN (${placeholders})`, ...unique)
      .map(mapReference)
      .map((ref) => [ref.id, ref] as const),
  );
  return ids.map((id) => found.get(id)).filter((ref): ref is ReferenceAsset => Boolean(ref));
}
