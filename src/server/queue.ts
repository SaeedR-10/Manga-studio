import { claimNextJob, markInterruptedJobsUnknown, queuedCount, setJobStatus } from "./repo/jobs";
import { reconcileStaleRequests } from "./repo/ai";
import { runJob } from "./engine";

/**
 * کارگزار صف در همان فرایند سرویس‌دهنده.
 *
 * نوشتن، ذخیرهٔ متن و رابط کاربر هرگز منتظر پایان کار AI نمی‌مانند. یک کار در
 * هر لحظه اجرا می‌شود تا هزینه و سهمیه غیرمنتظره ایجاد نشود.
 */

const TICK_MS = 1200;

type QueueGlobal = typeof globalThis & {
  __ravayatQueue?: { timer: NodeJS.Timeout; running: boolean; started: boolean };
};

const g = globalThis as QueueGlobal;

export function startQueue(): { unknown: number } {
  if (g.__ravayatQueue?.started) return { unknown: 0 };
  const unknownJobs = markInterruptedJobsUnknown();
  const stale = reconcileStaleRequests();
  const timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  timer.unref?.();
  g.__ravayatQueue = { timer, running: false, started: true };
  return { unknown: Math.max(unknownJobs, stale) };
}

/** اجرای فوری چرخه (پس از افزودن کار، تا کاربر منتظر تیک بعدی نماند). */
export function eventQueueKick(): void {
  setTimeout(() => {
    void tick();
  }, 30);
}

export async function tick(): Promise<void> {
  if (!g.__ravayatQueue || g.__ravayatQueue.running) return;
  g.__ravayatQueue.running = true;
  try {
    const next = claimNextJob();
    if (!next) return;
    try {
      await runJob(next.job, next.payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : "خطای ناشناخته در کارگزار";
      setJobStatus(next.job.id, "failed", { errorCode: "worker_error", errorMessage: message });
    }
  } finally {
    if (g.__ravayatQueue) g.__ravayatQueue.running = false;
  }
}

export function stopQueue(): void {
  if (!g.__ravayatQueue) return;
  clearInterval(g.__ravayatQueue.timer);
  g.__ravayatQueue = undefined;
}

export function queueState(): { started: boolean; running: boolean; queued: number } {
  return {
    started: Boolean(g.__ravayatQueue?.started),
    running: Boolean(g.__ravayatQueue?.running),
    queued: queuedCount(),
  };
}
