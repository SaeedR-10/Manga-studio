export interface ApiError {
  message: string;
  code?: string;
  hint?: string | null;
  /** دادهٔ ساختاریافته برای بازیابی (مثلاً متن فعلی سرور در تعارض ذخیره) */
  details?: unknown;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public info: ApiError,
  ) {
    super(info.message);
  }
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json: payload, ...rest } = init ?? {};
  const res = await fetch(path, {
    ...rest,
    headers: {
      ...(payload ? { "content-type": "application/json" } : {}),
      ...(rest.headers ?? {}),
    },
    body: payload !== undefined ? JSON.stringify(payload) : rest.body,
    cache: "no-store",
  });
  const contentType = res.headers.get("content-type") ?? "";
  const data = contentType.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) {
    const info: ApiError =
      typeof data === "object" && data && "error" in data
        ? (data as { error: ApiError }).error
        : { message: typeof data === "string" ? data : "خطای ناشناخته" };
    throw new HttpError(res.status, info);
  }
  return data as T;
}

export function errorText(error: unknown): { message: string; hint: string | null } {
  if (error instanceof HttpError) return { message: error.info.message, hint: error.info.hint ?? null };
  if (error instanceof Error) return { message: error.message, hint: null };
  return { message: "خطای ناشناخته", hint: null };
}

export function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "نامشخص";
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("fa-IR", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

export const SHOT_LABELS: Record<string, string> = {
  wide: "نمای دور",
  medium: "نمای متوسط",
  close: "کلوزآپ",
  extreme_close: "کلوزآپ بسیار نزدیک",
  over_shoulder: "از پشت شانه",
  detail: "جزئیات",
};

export const ANGLE_LABELS: Record<string, string> = {
  eye: "هم‌تراز چشم",
  low: "از پایین",
  high: "از بالا",
  birds_eye: "پرنده",
  dutch: "کج",
};

export const STATUS_LABELS: Record<string, string> = {
  queued: "در صف",
  sending: "در حال ارسال",
  processing: "در حال پردازش",
  succeeded: "تکمیل",
  failed: "ناموفق",
  cancelled: "لغوشده",
  unknown: "وضعیت نامشخص",
  draft: "پیش‌نویس",
  ready: "آماده",
  generated: "تصویر تولید شد",
  reviewed: "بازبینی‌شده",
  approved: "تأییدشده",
  needs_review: "نیازمند بازبینی",
  proposed: "پیشنهادی",
  confirmed: "تأییدشده",
  rejected: "ردشده",
  retired: "کنارگذاشته",
  pending: "بی‌تصمیم",
  accepted: "پذیرفته",
  intentional: "تغییر عمدی",
};

export function statusClass(status: string): string {
  if (["confirmed", "succeeded", "approved", "accepted", "reviewed", "generated", "ready"].includes(status)) return "ok";
  if (["failed", "rejected", "conflict"].includes(status)) return "bad";
  if (["unknown", "needs_review", "proposed", "pending", "queued", "sending", "processing", "draft"].includes(status)) return "warn";
  return "muted";
}
