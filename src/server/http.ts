import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = "bad_request",
    public hint?: string,
    /** دادهٔ ساختاریافته برای بازیابی رابط (مثلاً متن فعلی سرور در تعارض ذخیره) */
    public details?: unknown,
  ) {
    super(message);
  }
}

export function json(data: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, {
    ...init,
    headers: { "cache-control": "no-store", ...(init?.headers ?? {}) },
  });
}

export function fail(error: unknown): NextResponse {
  if (error instanceof AppError) {
    return json(
      {
        error: {
          message: error.message,
          code: error.code,
          hint: error.hint ?? null,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      },
      { status: error.status },
    );
  }
  if (error instanceof z.ZodError) {
    return json(
      {
        error: {
          message: "دادهٔ ارسالی معتبر نیست.",
          code: "invalid_input",
          hint: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" · "),
        },
      },
      { status: 400 },
    );
  }
  const message = error instanceof Error ? error.message : "خطای ناشناخته";
  console.error("[api]", message);
  return json(
    { error: { message: "خطای داخلی برنامه رخ داد.", code: "internal", hint: message } },
    { status: 500 },
  );
}

export async function body<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new AppError("بدنهٔ درخواست JSON معتبر نیست.", 400, "invalid_json");
  }
  return schema.parse(raw);
}

/**
 * مرز امنیتی برنامهٔ محلی.
 *
 * ۱) توکن نشست: پوستهٔ دسکتاپ در هر اجرا یک توکن تصادفی می‌سازد، آن را به
 *    سرور می‌دهد و با `webRequest` به همهٔ درخواست‌های پنجره اضافه می‌کند. توکن
 *    هرگز در صفحه، localStorage یا فایل پروژه دیده نمی‌شود. بدون توکن، هیچ
 *    برنامهٔ محلی دیگری (حتی روی همان ماشین) نمی‌تواند API را صدا بزند.
 * ۲) مبدأ دقیق: مبدأ درخواست باید همان مبدأ برنامه (شامل پورت) باشد؛
 *    «هر localhost با هر پورتی» پذیرفته نمی‌شود.
 * ۳) در حالت توسعه (بدون توکن، مثل `next dev`) توکن وجود ندارد؛ در این حالت
 *    تغییرات فقط با Origin دقیقاً منطبق پذیرفته می‌شوند و Origin غایب رد می‌شود.
 *
 * این مرز جای اعتبارسنجی مالکیت داده را نمی‌گیرد؛ مسیرها هم شناسه‌های
 * پروژه/صحنه/پنل را بررسی می‌کنند.
 */

const TOKEN_HEADER = "x-ravayat-session";

export function sessionToken(): string {
  return (process.env.RAVAYAT_SESSION_TOKEN ?? "").trim();
}

export function appOrigin(): string | null {
  const raw = (process.env.RAVAYAT_APP_ORIGIN ?? "").trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

function requestOrigin(req: Request): string | null {
  const host = req.headers.get("host");
  if (!host) return null;
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http";
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return null;
  }
}

function expectedOrigins(req: Request): string[] {
  const list = new Set<string>();
  const configured = appOrigin();
  if (configured) list.add(configured);
  const derived = requestOrigin(req);
  if (derived) list.add(derived);
  return [...list];
}

/**
 * @param req درخواست
 * @param mode "read" برای GET/HEAD، "write" برای تغییر داده.
 */
export function assertAuthorized(req: Request, mode: "read" | "write" = "write"): void {
  const token = sessionToken();
  const origin = req.headers.get("origin");

  if (token) {
    const provided = req.headers.get(TOKEN_HEADER) ?? "";
    if (!provided) {
      throw new AppError(
        "این درخواست توکن نشست برنامه را ندارد.",
        401,
        "missing_session_token",
        "برنامه را از پنجرهٔ دسکتاپ اجرا کنید؛ دسترسی مستقیم از مرورگر یا برنامهٔ دیگر مسدود است.",
      );
    }
    if (!safeEqual(provided, token)) {
      throw new AppError("توکن نشست معتبر نیست.", 401, "bad_session_token");
    }
  }

  if (origin) {
    if (!expectedOrigins(req).includes(origin)) {
      throw new AppError(
        "مبدأ درخواست با مبدأ برنامه یکسان نیست.",
        403,
        "bad_origin",
        "فقط رابط همین برنامه (همان پورت) اجازهٔ دسترسی دارد.",
      );
    }
    return;
  }

  // بدون Origin: در حالت توکن‌دار، توکن کافی است (درخواست‌های خود برنامه).
  if (token) return;

  // حالت توسعه: تغییر داده بدون Origin پذیرفته نمی‌شود تا CSRF محلی ممکن نباشد.
  if (mode === "write") {
    throw new AppError(
      "درخواست تغییر داده باید از مبدأ همین برنامه باشد.",
      403,
      "missing_origin",
      "اگر برنامه را با Electron اجرا می‌کنید، پنجره را دوباره باز کنید.",
    );
  }
}

/** محافظ مسیرهای تغییردهنده. */
export function guard(req: Request): void {
  if (req.method === "GET" || req.method === "HEAD") {
    assertAuthorized(req, "read");
    return;
  }
  assertAuthorized(req, "write");
}

/** محافظ مسیرهای خواندنی (فایل پروژه، خروجی، تنظیمات، تصویر). */
export function guardRead(req: Request): void {
  assertAuthorized(req, "read");
}

/**
 * بررسی مالکیت: منبع باید متعلق به همان پروژهٔ مسیر باشد.
 * پیش از هر خواندن یا نوشتنِ وابسته به شناسه فراخوانی می‌شود.
 */
export function assertSameProject(actualProjectId: string | null | undefined, expectedProjectId: string, label = "منبع"): void {
  if (!actualProjectId || actualProjectId !== expectedProjectId) {
    throw new AppError(`${label} به این پروژه تعلق ندارد.`, 404, "cross_project_access");
  }
}

export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function bool(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}
