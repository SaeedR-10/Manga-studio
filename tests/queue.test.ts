import { describe, expect, it } from "vitest";
import { claimNextJob, enqueueJob, getJob, markInterruptedJobsUnknown, setJobStatus } from "@/server/repo/jobs";
import { createProject } from "@/server/repo/projects";
import { row, run } from "@/server/db";

function project() {
  // کارهای باقی‌ماندهٔ آزمون‌های قبلی نباید در انتخاب کار بعدی دخالت کنند.
  run("UPDATE jobs SET status = 'succeeded' WHERE status = 'queued'");
  return createProject({ title: `صف ${Math.random().toString(36).slice(2, 7)}` });
}

describe("صف پایدار", () => {
  it("کلیک دوباره با همان ورودی، کار تکراری نمی‌سازد", () => {
    const p = project();
    const payload = { panelId: "panel-1", requestId: "req-1" };
    const first = enqueueJob({ projectId: p.id, type: "panel_image", payload, dedupeKey: "panel_image:hash-1" });
    const second = enqueueJob({ projectId: p.id, type: "panel_image", payload, dedupeKey: "panel_image:hash-1" });
    expect(second.id).toBe(first.id);
    const count = row("SELECT COUNT(*) AS c FROM jobs WHERE project_id = ?", p.id)?.c;
    expect(Number(count)).toBe(1);
  });

  it("پس از پایان کار، ارسال دوباره مجاز است ولی پیش از آن نه", () => {
    const p = project();
    const first = enqueueJob({ projectId: p.id, type: "image_review", payload: {}, dedupeKey: "r:1" });
    setJobStatus(first.id, "failed", { errorCode: "invalid_response" });
    const second = enqueueJob({ projectId: p.id, type: "image_review", payload: {}, dedupeKey: "r:1" });
    expect(second.id).not.toBe(first.id);
  });

  it("کار نیمه‌تمام پس از قطع برنامه «نامشخص» می‌شود و خودکار ارسال نمی‌شود", () => {
    const p = project();
    const job = enqueueJob({ projectId: p.id, type: "panel_image", payload: {}, dedupeKey: `x:${Date.now()}` });
    const claimed = claimNextJob();
    expect(claimed?.job.id).toBe(job.id);
    expect(getJob(job.id)?.status).toBe("sending");
    markInterruptedJobsUnknown();
    expect(getJob(job.id)?.status).toBe("unknown");
    // کار نامشخص دوباره در صف قرار نمی‌گیرد
    expect(claimNextJob()?.job.id).toBeUndefined();
  });

  it("خطای موقت با تلاش محدود و فاصلهٔ افزایشی دوباره در صف می‌نشیند", () => {
    const p = project();
    const job = enqueueJob({ projectId: p.id, type: "image_review", payload: {}, dedupeKey: `retry:${Date.now()}`, maxAttempts: 2 });
    claimNextJob();
    setJobStatus(job.id, "queued", { errorCode: "rate_limited", retryInMs: 5000 });
    const stored = row("SELECT status, attempts, available_at FROM jobs WHERE id = ?", job.id)!;
    expect(String(stored.status)).toBe("queued");
    expect(Number(stored.attempts)).toBe(1);
    expect(new Date(String(stored.available_at)).getTime()).toBeGreaterThan(Date.now());
    run("UPDATE jobs SET available_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), job.id);
    expect(claimNextJob()?.job.id).toBe(job.id);
  });
});
