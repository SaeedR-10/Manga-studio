import { newId, nowIso, parseJson, row, rows, run } from "../db";
import { AppError } from "../http";
import type { AiJobStatus, Job } from "@/lib/types";

/**
 * صف پایدار کارها.
 *
 * وضعیت‌ها واقعی‌اند: queued → sending → processing → succeeded/failed/unknown.
 * قطع برنامه، کار «ارسال‌شده» را خودکار دوباره نمی‌فرستد؛ در بازگشایی،
 * sending/processing به unknown تبدیل می‌شوند و تصمیم ارسال دوباره (و هزینهٔ
 * تازهٔ آن) با کاربر است. کلید یکتا از ارسال تکراری جلوگیری می‌کند.
 */

function mapJob(r: Record<string, unknown>): Job {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    type: String(r.type),
    status: String(r.status) as AiJobStatus,
    attempts: Number(r.attempts ?? 0),
    maxAttempts: Number(r.max_attempts ?? 2),
    errorCode: r.error_code ? String(r.error_code) : null,
    errorMessage: r.error_message ? String(r.error_message) : null,
    requestId: r.request_id ? String(r.request_id) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function enqueueJob(input: {
  projectId: string;
  type: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
  requestId?: string | null;
  maxAttempts?: number;
}): Job {
  const existing = row(
    "SELECT * FROM jobs WHERE dedupe_key = ? AND status IN ('queued','sending','processing')",
    input.dedupeKey,
  );
  if (existing) return mapJob(existing);
  const id = newId();
  const now = nowIso();
  try {
    run(
      `INSERT INTO jobs (id, project_id, type, status, payload, dedupe_key, attempts, max_attempts, available_at, locked_until, request_id, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', ?, ?, 0, ?, ?, NULL, ?, ?, ?)`,
      id,
      input.projectId,
      input.type,
      JSON.stringify(input.payload),
      input.dedupeKey,
      input.maxAttempts ?? 2,
      now,
      input.requestId ?? null,
      now,
      now,
    );
  } catch {
    const raced = row("SELECT * FROM jobs WHERE dedupe_key = ? AND status IN ('queued','sending','processing')", input.dedupeKey);
    if (raced) return mapJob(raced);
    throw new AppError("کار در صف ثبت نشد.", 500, "job_enqueue_failed");
  }
  return mapJob(row("SELECT * FROM jobs WHERE id = ?", id)!);
}

export function listJobs(projectId: string, limit = 40): Job[] {
  return rows("SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?", projectId, limit).map(mapJob);
}

export function getJob(id: string): Job | null {
  const found = row("SELECT * FROM jobs WHERE id = ?", id);
  return found ? mapJob(found) : null;
}

export function claimNextJob(): { job: Job; payload: Record<string, unknown> } | null {
  const next = row(
    "SELECT * FROM jobs WHERE status = 'queued' AND available_at <= ? ORDER BY created_at LIMIT 1",
    nowIso(),
  );
  if (!next) return null;
  const id = String(next.id);
  const claimed = run(
    "UPDATE jobs SET status = 'sending', started_at = ?, updated_at = ?, locked_until = ? WHERE id = ? AND status = 'queued'",
    nowIso(),
    nowIso(),
    new Date(Date.now() + 5 * 60_000).toISOString(),
    id,
  );
  if (Number(claimed.changes) === 0) return null;
  const job = mapJob(row("SELECT * FROM jobs WHERE id = ?", id)!);
  return { job, payload: parseJson<Record<string, unknown>>(next.payload, {}) };
}

export function setJobStatus(
  id: string,
  status: AiJobStatus,
  input: { errorCode?: string | null; errorMessage?: string | null; retryInMs?: number } = {},
): void {
  const attempts = Number(row("SELECT attempts FROM jobs WHERE id = ?", id)?.attempts ?? 0);
  run(
    `UPDATE jobs SET status = ?, error_code = ?, error_message = ?, attempts = ?, available_at = ?, updated_at = ?,
       finished_at = ? WHERE id = ?`,
    status,
    input.errorCode ?? null,
    input.errorMessage ?? null,
    status === "queued" ? attempts + 1 : attempts,
    new Date(Date.now() + (input.retryInMs ?? 0)).toISOString(),
    nowIso(),
    status === "succeeded" || status === "failed" || status === "cancelled" ? nowIso() : null,
    id,
  );
}

export function cancelJob(id: string): Job {
  const job = getJob(id);
  if (!job) throw new AppError("کار پیدا نشد.", 404, "job_missing");
  if (job.status === "succeeded" || job.status === "failed") {
    throw new AppError("این کار پایان یافته و لغو آن معنا ندارد.", 400, "job_finished");
  }
  // لغو فقط محلی است؛ لغو پردازش سمت سرویس تضمین نمی‌شود.
  run(
    "UPDATE jobs SET status = 'cancelled', error_code = 'cancelled_local', error_message = 'لغو محلی شد؛ ممکن است سرویس همچنان پردازش کند.', finished_at = ?, updated_at = ? WHERE id = ?",
    nowIso(),
    nowIso(),
    id,
  );
  run("UPDATE ai_requests SET status = 'cancelled', error_message = 'لغو محلی شد.', finished_at = ?, updated_at = ? WHERE id = ?", nowIso(), nowIso(), job.requestId);
  return getJob(id)!;
}

/** کارهایی که اجرای برنامه در میانه رها کرده است. */
export function markInterruptedJobsUnknown(): number {
  const result = run(
    `UPDATE jobs SET status = 'unknown', error_code = 'interrupted',
       error_message = 'برنامه در میانهٔ کار بسته شد؛ وضعیت در سرویس قابل استعلام نیست.',
       updated_at = ? WHERE status IN ('sending','processing')`,
    nowIso(),
  );
  return Number(result.changes);
}

export function queuedCount(): number {
  return Number(row("SELECT COUNT(*) AS c FROM jobs WHERE status = 'queued'")?.c ?? 0);
}
