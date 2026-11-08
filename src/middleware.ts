import { NextRequest, NextResponse } from "next/server";

/**
 * مرز امنیتی واحد برای همهٔ مسیرهای API.
 *
 * - توکن نشست (که پوستهٔ دسکتاپ در هدر هر درخواست می‌گذارد) الزامی است.
 * - مبدأ درخواست باید دقیقاً همان مبدأ برنامه (با همان پورت) باشد؛
 *   «هر localhost با هر پورتی» پذیرفته نمی‌شود.
 * - تنها `/api/status` برای سنجش آمادگی موتور، بدون توکن و با پاسخ حداقلی است.
 *
 * این لایه جای بررسی مالکیت داده در مسیرها را نمی‌گیرد و مکمل آن است.
 */

export const config = { matcher: ["/api/:path*", "/api"] };

const HEALTH_PATH = "/api/status";

async function digest(value: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(value);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

async function safeEqual(a: string, b: string): Promise<boolean> {
  if (!a || !b) return false;
  const [left, right] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

function deny(status: number, code: string, message: string): NextResponse {
  return NextResponse.json(
    { error: { message, code, hint: null } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export default async function middleware(req: NextRequest): Promise<NextResponse> {
  const path = req.nextUrl.pathname;
  if (path === HEALTH_PATH) return NextResponse.next();

  const token = (process.env.RAVAYAT_SESSION_TOKEN ?? "").trim();
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  const configured = (process.env.RAVAYAT_APP_ORIGIN ?? "").trim();
  const expected = new Set<string>();
  if (configured) {
    try {
      expected.add(new URL(configured).origin);
    } catch {
      /* ignore malformed config */
    }
  }
  if (host) expected.add(`${req.nextUrl.protocol}//${host}`);

  if (origin && !expected.has(origin)) {
    return deny(403, "bad_origin", "مبدأ درخواست با مبدأ برنامه یکسان نیست.");
  }

  const method = req.method.toUpperCase();
  const isRead = method === "GET" || method === "HEAD";

  if (token) {
    const provided = req.headers.get("x-ravayat-session") ?? "";
    if (!provided) {
      return deny(
        401,
        "missing_session_token",
        "این درخواست توکن نشست برنامه را ندارد؛ دسترسی مستقیم از مرورگر یا برنامهٔ دیگر مسدود است.",
      );
    }
    if (!(await safeEqual(provided, token))) {
      return deny(401, "bad_session_token", "توکن نشست معتبر نیست.");
    }
    return NextResponse.next();
  }

  // حالت توسعه (بدون توکن): تغییر داده فقط با Origin دقیقاً منطبق.
  if (!isRead && !origin) {
    return deny(403, "missing_origin", "درخواست تغییر داده باید از مبدأ همین برنامه باشد.");
  }
  return NextResponse.next();
}
