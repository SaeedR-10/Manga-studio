import { describe, expect, it } from "vitest";
import {
  buildCanonView,
  factsForCharacter,
  resolveFact,
  resolveVersion,
  type FactLike,
  type KnowledgeLike,
  type VersionLike,
} from "@/server/canon";

function fact(partial: Partial<FactLike> & { id: string; attribute: string; value: string }): FactLike {
  return {
    subjectId: "aria",
    status: "confirmed",
    sourceType: "user_decision",
    sourceRef: "",
    scopeStart: null,
    scopeEnd: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("منطق زمانی مرجع قطعی", () => {
  const wound = fact({
    id: "wound",
    attribute: "زخم",
    value: "زخم بخیه‌خورده بازوی راست",
    scopeStart: "2026-02-20",
  });

  it("در فلش‌بک پیش از ایجاد زخم، زخم معتبر نیست", () => {
    const result = resolveFact([wound], { subjectId: "aria", attribute: "زخم", at: "2026-01-12" });
    expect(result.status).toBe("unknown");
    expect(result.chosen).toBeNull();
  });

  it("پس از تاریخ ایجاد، همان زخم معتبر است", () => {
    const result = resolveFact([wound], { subjectId: "aria", attribute: "زخم", at: "2026-03-02" });
    expect(result.status).toBe("resolved");
    expect(result.chosen?.value).toContain("بازوی راست");
  });

  it("پیشنهاد تأییدنشده هرگز انتخاب نمی‌شود", () => {
    const proposed = fact({ id: "p", attribute: "راز", value: "برادرش زنده است", status: "proposed" });
    const result = resolveFact([proposed], { subjectId: "aria", attribute: "راز", at: null });
    expect(result.status).toBe("unknown");
    expect(result.reason).toContain("تأییدنشده");
  });

  it("تعارض میان دو واقعیت تأییدشده هم‌زمان گزارش می‌شود، نه اینکه یکی بی‌صدا انتخاب شود", () => {
    const a = fact({ id: "a", attribute: "چشم", value: "خاکستری" });
    const b = fact({ id: "b", attribute: "چشم", value: "سبز" });
    const result = resolveFact([a, b], { subjectId: "aria", attribute: "چشم", at: null });
    expect(result.status).toBe("conflict");
    expect(result.chosen).toBeNull();
    expect(result.conflicts).toHaveLength(2);
  });

  it("بازهٔ لباس: هر زمان نسخهٔ خودش را می‌گیرد", () => {
    const versions: VersionLike[] = [
      {
        id: "v1",
        entityId: "aria",
        layer: "clothing",
        label: "پالتو",
        payload: { clothing: "پالتوی خاکی" },
        validFrom: "2025-06-01",
        validTo: "2026-02-19",
        approvedAt: "2025-06-02T00:00:00.000Z",
      },
      {
        id: "v2",
        entityId: "aria",
        layer: "clothing",
        label: "پیراهن و باند",
        payload: { clothing: "پیراهن آستین‌کوتاه" },
        validFrom: "2026-02-20",
        validTo: null,
        approvedAt: "2026-02-21T00:00:00.000Z",
      },
    ];
    expect(resolveVersion(versions, { entityId: "aria", layer: "clothing", at: "2026-01-12" }).chosen?.id).toBe("v1");
    expect(resolveVersion(versions, { entityId: "aria", layer: "clothing", at: "2026-03-02" }).chosen?.id).toBe("v2");
  });

  it("نسخهٔ تأییدنشده معتبر شمرده نمی‌شود", () => {
    const versions: VersionLike[] = [
      {
        id: "draft",
        entityId: "aria",
        layer: "clothing",
        label: "پیش‌نویس",
        payload: {},
        validFrom: null,
        validTo: null,
        approvedAt: null,
      },
    ];
    expect(resolveVersion(versions, { entityId: "aria", layer: "clothing", at: null }).status).toBe("unknown");
  });

  it("دانستهٔ شخصیت پیش از صحنهٔ افشا در دسترس نیست", () => {
    const secret = fact({ id: "secret", attribute: "راز", value: "برادرش زنده است" });
    const knowledge: KnowledgeLike[] = [
      { characterId: "nila", factId: "secret", knowledge: "knows", revealScenePosition: 1002 },
    ];
    expect(factsForCharacter([secret], knowledge, { characterId: "nila", scenePosition: 1001 })).toHaveLength(0);
    expect(factsForCharacter([secret], knowledge, { characterId: "nila", scenePosition: 1002 })).toHaveLength(1);
    expect(factsForCharacter([secret], knowledge, { characterId: "aria", scenePosition: 2000 })).toHaveLength(0);
  });

  it("نمای صحنه، تعارض و نامشخص‌ها را جدا نشان می‌دهد", () => {
    const view = buildCanonView(
      [
        fact({ id: "1", attribute: "زخم", value: "بازوی راست", scopeStart: "2026-02-20" }),
        fact({ id: "2", attribute: "چشم", value: "خاکستری" }),
        fact({ id: "3", attribute: "چشم", value: "سبز" }),
      ],
      { subjectIds: ["aria"], at: "2026-01-12" },
    );
    expect(view.conflicts).toHaveLength(1);
    expect(view.resolved.find((r) => r.attribute === "چشم")?.status).toBe("conflict");
    expect(view.unknown.some((u) => u.attribute === "زخم")).toBe(true);
  });
});
