import { describe, expect, it } from "vitest";
import { findMatches, normalizePersian, toMarkdown, wordCount } from "@/lib/persian";
import { diffLines, diffStats } from "@/lib/diff";

describe("جست‌وجوی فارسی", () => {
  it("ی/ي و ک/ك را یکسان می‌یابد", () => {
    expect(normalizePersian("كيک")).toBe(normalizePersian("کیک"));
    const matches = findMatches("کیکِ تازه", "كيک");
    expect(matches.length).toBe(1);
  });

  it("نیم‌فاصله و اعراب مانع یافتن نمی‌شوند", () => {
    expect(findMatches("می‌رود آرام", "می رود").length).toBe(1);
    expect(findMatches("کِتاب", "کتاب").length).toBe(1);
  });

  it("متن اصلی تغییر نمی‌کند؛ فقط بازه برمی‌گردد", () => {
    const original = "آریا به «بازار» رفت.";
    findMatches(original, "بازار");
    expect(original).toContain("«بازار»");
  });

  it("شمارش واژه و Markdown ساده درست است", () => {
    expect(wordCount("یک دو سه")).toBe(3);
    const md = toMarkdown("فصل", [{ title: "صحنه", text: "متن" }]);
    expect(md).toContain("## صحنه");
  });

  it("دیف خطی تغییرات را می‌شمارد", () => {
    const lines = diffLines("الف\nب", "الف\nج");
    expect(diffStats(lines)).toEqual({ added: 1, removed: 1 });
  });
});
