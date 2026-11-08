import { describe, expect, it } from "vitest";
import { selectReferences, type RefCandidate } from "@/server/refs";

function ref(partial: Partial<RefCandidate> & { id: string }): RefCandidate {
  return {
    assetId: `asset-${partial.id}`,
    title: partial.id,
    status: "approved",
    roles: ["identity"],
    entityIds: ["aria"],
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    origin: "local_upload",
    ...partial,
  };
}

describe("انتخاب مراجع", () => {
  it("فقط مراجع تأییدشده انتخاب می‌شوند", () => {
    const result = selectReferences({
      candidates: [ref({ id: "ok" }), ref({ id: "draft", status: "draft" })],
      entityIds: ["aria"],
      limit: 4,
    });
    expect(result.selected.map((r) => r.id)).toEqual(["ok"]);
    expect(result.dropped[0].reason).toContain("تأییدنشده");
  });

  it("سقف مدل رعایت می‌شود و موارد حذف‌شده با دلیل گزارش می‌شوند", () => {
    const candidates = Array.from({ length: 6 }, (_, i) => ref({ id: `r${i}`, roles: ["identity"] }));
    const result = selectReferences({ candidates, entityIds: ["aria"], limit: 3 });
    expect(result.selected).toHaveLength(3);
    expect(result.dropped).toHaveLength(3);
    expect(result.dropped.every((d) => d.reason.includes("سقف"))).toBe(true);
  });

  it("مرجع نامرتبط با صحنه ارسال نمی‌شود", () => {
    const result = selectReferences({
      candidates: [ref({ id: "other", entityIds: ["nila"] })],
      entityIds: ["aria"],
      limit: 4,
    });
    expect(result.selected).toHaveLength(0);
    expect(result.dropped[0].reason).toContain("مربوط نیست");
  });

  it("انتخاب صریح کاربر بر سقف اولویت دارد و تعارض آن اعلام می‌شود", () => {
    const result = selectReferences({
      candidates: [ref({ id: "a" }), ref({ id: "b" })],
      entityIds: ["aria"],
      limit: 1,
      pinnedIds: ["a", "b"],
    });
    expect(result.selected).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes("سقف"))).toBe(true);
  });

  it("نبود مرجع چهره/هویت برای شخصیت هشدار می‌دهد", () => {
    const result = selectReferences({
      candidates: [ref({ id: "loc", roles: ["location"], entityIds: ["market"] })],
      entityIds: ["aria"],
      limit: 4,
      styleRefId: "loc",
    });
    expect(result.warnings.some((w) => w.includes("هویت") || w.includes("چهره"))).toBe(true);
  });
});
