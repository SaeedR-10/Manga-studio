import { newId, nowIso, parseJson, row, rows, run, transaction } from "../db";
import { AppError } from "../http";
import type { AiJobStatus, AiRequest, PanelTake, ReviewReport } from "@/lib/types";
import { estimateImageCost } from "../models";

// ------------------------------------------------------------------ requests

function mapRequest(r: Record<string, unknown>): AiRequest {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    panelId: r.panel_id ? String(r.panel_id) : null,
    role: String(r.role),
    provider: String(r.provider),
    model: String(r.model),
    promptVersion: r.prompt_version == null ? null : Number(r.prompt_version),
    status: String(r.status) as AiJobStatus,
    attempts: Number(r.attempts ?? 0),
    httpStatus: r.http_status == null ? null : Number(r.http_status),
    errorCode: r.error_code ? String(r.error_code) : null,
    errorMessage: r.error_message ? String(r.error_message) : null,
    promptText: String(r.prompt_text ?? ""),
    inputs: parseJson<Record<string, unknown>>(r.inputs, {}),
    costEstimate: parseJson(r.cost_estimate, { usd: null, basis: "نامشخص" }),
    costReported: parseJson(r.cost_reported, {}),
    costComputed: parseJson(r.cost_computed, { usd: null }),
    createdAt: String(r.created_at),
    finishedAt: r.finished_at ? String(r.finished_at) : null,
    parsed: parseJson(r.parsed, null),
  };
}

export function getRequest(id: string): AiRequest | null {
  const found = row("SELECT * FROM ai_requests WHERE id = ?", id);
  return found ? mapRequest(found) : null;
}

export function listRequests(projectId: string, limit = 60): AiRequest[] {
  return rows("SELECT * FROM ai_requests WHERE project_id = ? ORDER BY created_at DESC LIMIT ?", projectId, limit).map(
    mapRequest,
  );
}

export function activeRequestForKey(projectId: string, requestKey: string): AiRequest | null {
  const found = row(
    "SELECT * FROM ai_requests WHERE project_id = ? AND request_key = ? AND status IN ('queued','sending','processing') ORDER BY created_at DESC LIMIT 1",
    projectId,
    requestKey,
  );
  return found ? mapRequest(found) : null;
}

export function createRequest(input: {
  projectId: string;
  panelId?: string | null;
  role: string;
  provider: string;
  model: string;
  promptId?: string | null;
  promptVersion: number | null;
  promptText: string;
  inputs: Record<string, unknown>;
  requestKey: string;
  costEstimate: { usd: number | null; basis: string; source?: string };
  note?: string;
}): AiRequest {
  const existing = activeRequestForKey(input.projectId, input.requestKey);
  if (existing) return existing;
  const id = newId();
  const now = nowIso();
  run(
    `INSERT INTO ai_requests (id, project_id, panel_id, role, provider, model, prompt_id, prompt_version, prompt_text, inputs,
       request_key, status, attempts, cost_estimate, created_at, updated_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)`,
    id,
    input.projectId,
    input.panelId ?? null,
    input.role,
    input.provider,
    input.model,
    input.promptId ?? null,
    input.promptVersion,
    input.promptText,
    JSON.stringify(input.inputs),
    input.requestKey,
    JSON.stringify(input.costEstimate),
    now,
    now,
    input.note ?? "",
  );
  return getRequest(id)!;
}

export function markSending(id: string): void {
  run(
    "UPDATE ai_requests SET status = 'sending', attempts = attempts + 1, sent_at = ?, updated_at = ? WHERE id = ?",
    nowIso(),
    nowIso(),
    id,
  );
}

export function markProcessing(id: string): void {
  run("UPDATE ai_requests SET status = 'processing', updated_at = ? WHERE id = ?", nowIso(), id);
}

export function completeRequest(
  id: string,
  input: {
    raw: unknown;
    parsed: unknown;
    providerRequestId?: string | null;
    httpStatus?: number | null;
    costReported?: Record<string, unknown>;
    costComputed?: { usd: number | null; basis?: string };
    validationErrors?: string[];
  },
): void {
  run(
    `UPDATE ai_requests SET status = 'succeeded', http_status = ?, provider_request_id = ?, raw_response = ?, parsed = ?,
       validation_errors = ?, cost_reported = ?, cost_computed = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
    input.httpStatus ?? null,
    input.providerRequestId ?? null,
    JSON.stringify(input.raw ?? null).slice(0, 400_000),
    JSON.stringify(input.parsed ?? null),
    JSON.stringify(input.validationErrors ?? []),
    JSON.stringify(input.costReported ?? {}),
    JSON.stringify(input.costComputed ?? { usd: null }),
    nowIso(),
    nowIso(),
    id,
  );
}

export function failRequest(
  id: string,
  input: { status: "failed" | "unknown" | "cancelled"; code: string; message: string; httpStatus?: number | null },
): void {
  run(
    "UPDATE ai_requests SET status = ?, error_code = ?, error_message = ?, http_status = ?, finished_at = ?, updated_at = ? WHERE id = ?",
    input.status,
    input.code,
    input.message.slice(0, 2000),
    input.httpStatus ?? null,
    input.status === "unknown" ? null : nowIso(),
    nowIso(),
    id,
  );
}

export function recordAttempt(input: {
  requestId: string;
  attempt: number;
  status: string;
  httpStatus?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  durationMs?: number | null;
}): void {
  run(
    `INSERT INTO ai_attempts (id, request_id, attempt, status, http_status, error_code, error_message, tokens_in, tokens_out, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId(),
    input.requestId,
    input.attempt,
    input.status,
    input.httpStatus ?? null,
    input.errorCode ?? null,
    input.errorMessage ?? null,
    input.tokensIn ?? null,
    input.tokensOut ?? null,
    input.durationMs ?? null,
    nowIso(),
  );
}

/** درخواست‌هایی که پس از قطع برنامه در وضعیت مبهم مانده‌اند. */
export function reconcileStaleRequests(): number {
  const result = run(
    "UPDATE ai_requests SET status = 'unknown', note = COALESCE(NULLIF(note,''), 'برنامه پیش از دریافت پاسخ بسته شد؛ وضعیت در سرویس قابل استعلام نیست.'), updated_at = ? WHERE status IN ('sending','processing')",
    nowIso(),
  );
  return Number(result.changes);
}

// --------------------------------------------------------------------- takes

function mapTake(r: Record<string, unknown>): PanelTake {
  return {
    id: String(r.id),
    panelId: String(r.panel_id),
    requestId: String(r.request_id),
    assetId: String(r.asset_id),
    variant: Number(r.variant ?? 0),
    status: String(r.status) as PanelTake["status"],
    seed: r.seed ? String(r.seed) : null,
    createdAt: String(r.created_at),
    acceptedAt: r.accepted_at ? String(r.accepted_at) : null,
    imageUrl: `/api/assets/${String(r.asset_id)}`,
    sourceTakeId: r.source_take_id ? String(r.source_take_id) : null,
    maskAssetId: r.mask_asset_id ? String(r.mask_asset_id) : null,
    editKind: r.edit_kind ? String(r.edit_kind) : null,
  };
}

export function addTake(input: {
  panelId: string;
  requestId: string;
  assetId: string;
  variant: number;
  seed?: string | null;
  meta?: Record<string, unknown>;
  /** برای ویرایش: خروجی و ماسک مبدأ تا نسخهٔ اصلاح‌شده کامل قابل ردیابی باشد */
  sourceTakeId?: string | null;
  maskAssetId?: string | null;
  editKind?: string | null;
}): PanelTake {
  const id = newId();
  run(
    `INSERT INTO image_takes (id, panel_id, request_id, asset_id, variant, status, seed, meta, created_at, source_take_id, mask_asset_id, edit_kind)
     VALUES (?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?)`,
    id,
    input.panelId,
    input.requestId,
    input.assetId,
    input.variant,
    input.seed ?? null,
    JSON.stringify(input.meta ?? {}),
    nowIso(),
    input.sourceTakeId ?? null,
    input.maskAssetId ?? null,
    input.editKind ?? null,
  );
  return mapTake(row("SELECT * FROM image_takes WHERE id = ?", id)!);
}

export function listTakes(panelId: string): PanelTake[] {
  return rows("SELECT * FROM image_takes WHERE panel_id = ? ORDER BY created_at DESC", panelId).map(mapTake);
}

export function takeCount(panelId: string): number {
  return Number(row("SELECT COUNT(*) AS c FROM image_takes WHERE panel_id = ?", panelId)?.c ?? 0);
}

export function acceptTake(panelId: string, takeId: string): PanelTake {
  const take = row("SELECT * FROM image_takes WHERE id = ? AND panel_id = ?", takeId, panelId);
  if (!take) throw new AppError("خروجی انتخاب‌شده پیدا نشد.", 404, "take_missing");
  transaction(() => {
    run(
      "UPDATE image_takes SET status = 'superseded' WHERE panel_id = ? AND status = 'accepted' AND id != ?",
      panelId,
      takeId,
    );
    run("UPDATE image_takes SET status = 'accepted', accepted_at = ? WHERE id = ?", nowIso(), takeId);
    run(
      "UPDATE panels SET current_take_id = ?, image_asset_id = ?, status = 'generated', needs_review = 0, review_reason = '', updated_at = ? WHERE id = ?",
      takeId,
      String(take.asset_id),
      nowIso(),
      panelId,
    );
  });
  return mapTake(row("SELECT * FROM image_takes WHERE id = ?", takeId)!);
}

export function rejectTake(takeId: string): void {
  run("UPDATE image_takes SET status = 'rejected' WHERE id = ?", takeId);
}

// ------------------------------------------------------------------- reviews

export function createReview(input: {
  panelId: string;
  requestId: string | null;
  imageAssetId: string | null;
  summary: string;
  issues: Array<{
    kind: string;
    severity: "low" | "medium" | "high";
    description: string;
    referenceTitle?: string;
    evidence?: string;
    confidence?: string;
    suggestion?: string;
    evaluable?: boolean;
  }>;
  /** مراجع همان درخواست؛ عنوانی که مدل گفته به شناسهٔ واقعی مرجع نگاشت می‌شود */
  references?: Array<{ id: string; title: string }>;
}): string {
  const resolveRef = (title: string | undefined): string | null => {
    if (!title || !input.references?.length) return null;
    const exact = input.references.find((r) => r.title === title);
    if (exact) return exact.id;
    const loose = input.references.find((r) => title.includes(r.title) || r.title.includes(title));
    return loose?.id ?? null;
  };
  const id = newId();
  transaction(() => {
    run(
      `INSERT INTO review_reports (id, panel_id, request_id, image_asset_id, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      input.panelId,
      input.requestId,
      input.imageAssetId,
      input.summary,
      nowIso(),
    );
    for (const issue of input.issues) {
      run(
        `INSERT INTO review_issues (id, report_id, kind, severity, description, reference_id, evidence, confidence, suggestion, evaluable, decision, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        newId(),
        id,
        issue.kind,
        issue.severity,
        issue.description,
        resolveRef(issue.referenceTitle),
        issue.evidence ?? "",
        issue.confidence ?? "medium",
        issue.suggestion ?? "",
        issue.evaluable === false ? 0 : 1,
        nowIso(),
      );
    }
    run("UPDATE panels SET status = 'reviewed', updated_at = ? WHERE id = ?", nowIso(), input.panelId);
  });
  return id;
}

export function listReviews(panelId: string): ReviewReport[] {
  const reports = rows("SELECT * FROM review_reports WHERE panel_id = ? ORDER BY created_at DESC", panelId).map((r) => ({
    id: String(r.id),
    panelId: String(r.panel_id),
    summary: String(r.summary ?? ""),
    createdAt: String(r.created_at),
    issues: rows("SELECT * FROM review_issues WHERE report_id = ? ORDER BY severity DESC, created_at", String(r.id)).map((i) => ({
      id: String(i.id),
      kind: String(i.kind),
      severity: String(i.severity) as "low" | "medium" | "high",
      description: String(i.description),
      referenceId: i.reference_id ? String(i.reference_id) : null,
      evidence: String(i.evidence ?? ""),
      confidence: String(i.confidence ?? "medium"),
      suggestion: String(i.suggestion ?? ""),
      evaluable: Number(i.evaluable) === 1,
      decision: String(i.decision) as "pending" | "accepted" | "rejected" | "intentional",
      decisionNote: String(i.decision_note ?? ""),
    })),
  }));
  return reports;
}

export function decideIssue(issueId: string, decision: "accepted" | "rejected" | "intentional", note = ""): void {
  const found = row("SELECT id FROM review_issues WHERE id = ?", issueId);
  if (!found) throw new AppError("ایراد پیدا نشد.", 404, "issue_missing");
  run(
    "UPDATE review_issues SET decision = ?, decision_note = ?, decided_at = ? WHERE id = ?",
    decision,
    note,
    nowIso(),
    issueId,
  );
}

export function imageCostEstimate(model: string, size: string) {
  return estimateImageCost(model, size);
}
