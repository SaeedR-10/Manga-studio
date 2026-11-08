/**
 * راه‌اندازی سرویس‌های پس‌زمینه هنگام بالا آمدن سرور برنامه.
 * کارهایی که اجرای قبلی در میانه رها کرده، «نامشخص» علامت می‌خورند و
 * خودکار دوباره ارسال نمی‌شوند.
 *
 * نکته: شرط «NEXT_RUNTIME === "nodejs"» باید کل import را در بر بگیرد (نه یک
 * return زودهنگام). Next این مقدار را در زمان ساخت جایگذاری می‌کند و تنها در
 * این شکل، ماژول صف — که `node:sqlite` و خزانهٔ ویندوز را می‌خواند — از بستهٔ
 * لبه/مرورگر حذف می‌شود.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { startQueue } = await import("./server/queue");
      const result = startQueue();
      if (result.unknown > 0) {
        console.log(`[ravayat] ${result.unknown} کار ناتمام به وضعیت «نامشخص» منتقل شد.`);
      }
    } catch (error) {
      console.error("[ravayat] راه‌اندازی صف ناموفق بود", error);
    }
  }
}
