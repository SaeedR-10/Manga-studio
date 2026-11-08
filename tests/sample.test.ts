import { describe, expect, it } from "vitest";
import { createSampleProject } from "@/server/sample";
import { listScenes } from "@/server/repo/projects";
import { listPanels } from "@/server/repo/panels";
import { canonEntriesAt, listEntities, listFacts } from "@/server/repo/world";
import { listReferences } from "@/server/repo/refs";
import { row } from "@/server/db";

describe("پروژهٔ نمونهٔ فارسی", () => {
  const sample = createSampleProject();
  const scenes = listScenes(sample.projectId);
  const panels = listPanels(sample.projectId);
  const entities = listEntities(sample.projectId);

  it("دو شخصیت، یک مکان و یک شیء دارد", () => {
    expect(entities.filter((e) => e.kind === "character")).toHaveLength(2);
    expect(entities.filter((e) => e.kind === "location")).toHaveLength(1);
    expect(entities.filter((e) => e.kind === "object")).toHaveLength(1);
  });

  it("صحنهٔ ۱۲ پنلی با گفت‌وگو و حرکت می‌سازد", () => {
    expect(panels).toHaveLength(12);
    expect(panels.some((p) => p.dialogue.length > 0)).toBe(true);
    expect(panels.some((p) => p.action.length > 20)).toBe(true);
    expect(panels.every((p) => p.sourceSceneVersionId)).toBe(true);
  });

  it("فلش‌بک پیش از ایجاد زخم، زخم را نشان نمی‌دهد", () => {
    const flashback = scenes.find((s) => s.isFlashback)!;
    expect(flashback.storyDate).toBe("2026-01-12");
    const aria = entities.find((e) => e.name === "آریا")!;
    const canon = canonEntriesAt(sample.projectId, { storyDate: flashback.storyDate, entityIds: [aria.id] });
    expect(canon.entries.some((e) => e.attribute === "زخم" && e.value)).toBe(false);
    const present = canonEntriesAt(sample.projectId, { storyDate: "2026-03-02", entityIds: [aria.id] });
    expect(present.entries.some((e) => e.attribute === "زخم" && e.value?.includes("بازوی راست"))).toBe(true);
  });

  it("راز پیشنهادی AI در مرجع قطعی نیست", () => {
    const facts = listFacts(sample.projectId);
    const secret = facts.find((f) => f.attribute === "راز")!;
    expect(secret.status).toBe("proposed");
    expect(secret.createdBy).toBe("ai");
  });

  it("هیچ درخواست AI پولی ارسال نمی‌کند و مرجع جای‌نگهدار برچسب دارد", () => {
    expect(Number(row("SELECT COUNT(*) AS c FROM ai_requests WHERE project_id = ?", sample.projectId)?.c)).toBe(0);
    const refs = listReferences(sample.projectId);
    expect(refs).toHaveLength(1);
    expect(refs[0].title).toContain("جای‌نگهدار");
    expect(refs[0].status).toBe("draft");
  });
});
