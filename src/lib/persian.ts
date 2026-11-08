/**
 * جست‌وجوی فارسی.
 *
 * ی/ي و ک/ك یکسان می‌شوند، اعراب و کشیده حذف می‌شوند و نیم‌فاصله برای
 * مقایسه به فاصله تبدیل می‌شود. این نرمال‌سازی فقط برای «یافتن» است؛ متن
 * اصلی هرگز تغییر داده نمی‌شود.
 */

const DIACRITICS = /[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;

export function normalizePersian(input: string): string {
  return input
    .replace(/\u064A/g, "\u06CC") // ي -> ی
    .replace(/\u0643/g, "\u06A9") // ك -> ک
    .replace(/\u0629/g, "\u0647") // ة -> ه
    .replace(/\u200C/g, " ") // نیم‌فاصله
    .replace(DIACRITICS, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export interface MatchRange {
  start: number;
  end: number;
}

/**
 * پیدا کردن تطابق‌ها در متن اصلی با نگاشت شاخص‌های نرمال‌شده.
 * اگر نرمال‌سازی طول متن را تغییر دهد، بازهٔ تقریبی برگردانده می‌شود تا
 * هایلایت تقریبی باشد و متن دست‌کاری نشود.
 */
export function findMatches(original: string, query: string): MatchRange[] {
  const q = normalizePersian(query);
  if (!q) return [];
  const normalized = normalizePersian(original);
  // نگاشت شاخص نرمال‌شده به شاخص اصلی فقط وقتی امن است که طول‌ها یکی باشند.
  const sameLength = normalized.length === original.length;
  const results: MatchRange[] = [];
  let index = normalized.indexOf(q);
  while (index !== -1) {
    results.push({ start: index, end: index + q.length });
    index = normalized.indexOf(q, index + Math.max(1, q.length));
    if (results.length > 500) break;
  }
  if (!sameLength) {
    return results.map((r) => ({
      start: Math.min(r.start, original.length),
      end: Math.min(r.end, original.length),
    }));
  }
  return results;
}

export function wordCount(text: string): number {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return 0;
  return trimmed.split(" ").length;
}

/** تبدیل Markdown ساده برای خروجی متن فصل‌ها؛ بدون تغییر متن نویسنده. */
export function toMarkdown(title: string, scenes: Array<{ title: string; text: string }>): string {
  const parts = [`# ${title}`, ""];
  for (const scene of scenes) {
    parts.push(`## ${scene.title}`, "", scene.text.trim(), "");
  }
  return parts.join("\n");
}
