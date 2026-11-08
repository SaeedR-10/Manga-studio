import { describe, expect, it } from "vitest";
import { unlinkSync, writeFileSync } from "node:fs";
import { newId, row, run } from "@/server/db";
import { createChapter, createProject, createScene, defaultAdaptationId, getScene } from "@/server/repo/projects";
import {
  addEntityVersion,
  approveEntityVersion,
  createEntity,
  createFact,
  listEntityVersions,
  saveSceneState,
  upsertKnowledge,
} from "@/server/repo/world";
import { createReference } from "@/server/repo/refs";
import { assetPath, getAsset, saveImage } from "@/server/storage";
import { enqueuePanelImage, planPanelProduction } from "@/server/engine";
import { loadVerifiedAttachments } from "@/server/attachments";
import { buildKnowledgeContext } from "@/server/context";
import { SceneSaveCoordinator } from "@/lib/sceneSave";
import { clearDraft } from "@/lib/drafts";

const PNG = (label: string) =>
  Buffer.concat([
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ),
    Buffer.from(label),
  ]);

function projectWithScene(title: string, text = "متن صحنه برای آزمون.", storyDate: string | null = "2020-05-01") {
  const project = createProject({ title });
  const chapter = createChapter(project.id, "فصل");
  const scene = createScene({ chapterId: chapter.id, title: "صحنه", text });
  run("UPDATE scenes SET story_date = ?, updated_at = ? WHERE id = ?", storyDate, new Date().toISOString(), scene.id);
  return { project, chapter, scene: getScene(scene.id)! };
}

function makePanel(projectId: string, sceneId: string, characters: Array<{ entityId: string; name: string }>): string {
  const panelId = newId();
  run(
    `INSERT INTO panels (id, project_id, adaptation_id, scene_id, position, title, source_scene_version_id, source_excerpt,
       narrative_goal, action, characters, location_id, time_label, shot_size, camera_angle, gaze_direction, movement,
       emotion, lighting, costumes, props, dialogue, style_profile_id, references_used, identity_snapshot, status,
       needs_review, review_reason, current_take_id, image_asset_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 'پنل آزمون', NULL, 'برش', 'هدف', 'کنش', ?, NULL, '', 'medium', 'eye', '', '', '', '', '', '', '[]', NULL, '[]', '{}', 'draft', 0, '', NULL, NULL, ?, ?)`,
    panelId,
    projectId,
    defaultAdaptationId(projectId),
    sceneId,
    JSON.stringify(
      characters.map((c) => ({
        entityId: c.entityId,
        name: c.name,
        position: "کنار دیگری",
        gaze: "به سمت مقابل",
        emotion: "آرام",
        clothing: "",
        identityNote: "",
      })),
    ),
    new Date().toISOString(),
    new Date().toISOString(),
  );
  return panelId;
}

function approvedReferenceFor(projectId: string, entityId: string, title: string) {
  const asset = saveImage({ buffer: PNG(title), filename: `${title}.png`, kind: "reference" });
  return createReference({
    projectId,
    assetId: asset.id,
    title,
    status: "approved",
    entityIds: [entityId],
    roles: ["identity"],
  });
}

describe("پیوست‌ها: بایت واقعی روی دیسک سنجیده می‌شود", () => {
  it("تغییر فایل پس از ساخت پیش‌نمایش، بدون تغییر هش پایگاه‌داده رد می‌شود", () => {
    const { project, scene } = projectWithScene("بایت پیوست");
    const hero = createEntity({ projectId: project.id, kind: "character", name: "آریا" });
    const ref = approvedReferenceFor(project.id, hero.id, "هویت آریا");
    saveSceneState({ sceneId: scene.id, presentEntities: [hero.id], locationId: null });
    const panelId = makePanel(project.id, scene.id, [{ entityId: hero.id, name: hero.name }]);

    const plan = planPanelProduction(project.id, panelId);
    expect(plan.attachments.length).toBeGreaterThan(0);
    const first = loadVerifiedAttachments(plan.attachments);
    expect(first[0].buffer.length).toBeGreaterThan(0);

    const asset = getAsset(ref.assetId)!;
    writeFileSync(assetPath(asset), PNG("tampered-after-approval"));
    expect(() => loadVerifiedAttachments(plan.attachments)).toThrow(/تغییر کرده/);
  });

  it("فایل گم‌شده پیش از ارسال گزارش می‌شود، نه بی‌صدا حذف", () => {
    const { project, scene } = projectWithScene("پیوست گم‌شده");
    const hero = createEntity({ projectId: project.id, kind: "character", name: "آریا" });
    const ref = approvedReferenceFor(project.id, hero.id, "مرجع گم‌شونده");
    saveSceneState({ sceneId: scene.id, presentEntities: [hero.id], locationId: null });
    const panelId = makePanel(project.id, scene.id, [{ entityId: hero.id, name: hero.name }]);
    const plan = planPanelProduction(project.id, panelId);
    const asset = getAsset(ref.assetId)!;
    unlinkSync(assetPath(asset));
    expect(() => loadVerifiedAttachments(plan.attachments)).toThrow(/گم|موجود نیست/);
  });
});

describe("دانش شخصیت فقط از واقعیت تأییدشده و معتبر در زمان صحنه", () => {
  it("پیشنهاد تأییدنشده و واقعیت آینده وارد دانش نمی‌شوند", () => {
    const { project, scene } = projectWithScene("دانش زمان‌دار", "صحنهٔ اکنون.", "2020-05-01");
    const hero = createEntity({ projectId: project.id, kind: "character", name: "آریا" });

    const proposed = createFact({
      projectId: project.id,
      subjectId: hero.id,
      attribute: "راز پیشنهادی",
      value: "برادرش زنده است",
      sourceType: "ai_suggestion",
      status: "proposed",
      createdBy: "ai",
    });
    const future = createFact({
      projectId: project.id,
      subjectId: hero.id,
      attribute: "زخم آینده",
      value: "زخم شانه",
      sourceType: "user_decision",
      status: "confirmed",
      scopeStart: "2030-01-01",
      scopeEnd: null,
      createdBy: "user",
    });
    const current = createFact({
      projectId: project.id,
      subjectId: hero.id,
      attribute: "چشم",
      value: "خاکستری",
      sourceType: "user_decision",
      status: "confirmed",
      createdBy: "user",
    });
    for (const fact of [proposed, future, current]) {
      upsertKnowledge({ projectId: project.id, characterId: hero.id, factId: fact.id, knowledge: "knows" });
    }

    const knowledge = buildKnowledgeContext(project.id, scene.id, [hero.id]);
    const knows = knowledge[0].knows.map((item) => item.attribute);
    expect(knows).toContain("چشم");
    expect(knows).not.toContain("راز پیشنهادی");
    expect(knows).not.toContain("زخم آینده");

    // پرامپت نهایی اقتباس هم همین را می‌گوید.
    saveSceneState({ sceneId: scene.id, presentEntities: [hero.id], locationId: null });
    const queued = enqueuePanelImage(project.id, makePanel(project.id, scene.id, [{ entityId: hero.id, name: hero.name }]));
    const inputs = JSON.parse(String(row("SELECT inputs FROM ai_requests WHERE id = ?", queued.requestId)!.inputs)) as {
      knowledge: Array<{ name: string; knows: string[]; suspects: string[]; withheld: string[] }>;
    };
    const promptKnowledge = inputs.knowledge.flatMap((item) => item.knows).join(" | ");
    expect(promptKnowledge).toContain("چشم");
    expect(promptKnowledge).not.toContain("راز پیشنهادی");
    expect(promptKnowledge).not.toContain("زخم آینده");
  });

  it("فلش‌بک با تاریخ خودش سنجیده می‌شود و «گمان» با «می‌داند» یکی نمی‌شود", () => {
    const { project, scene } = projectWithScene("فلش‌بک", "گذشته.", "2015-03-01");
    run("UPDATE scenes SET is_flashback = 1 WHERE id = ?", scene.id);
    const hero = createEntity({ projectId: project.id, kind: "character", name: "آریا" });
    const wound = createFact({
      projectId: project.id,
      subjectId: hero.id,
      attribute: "زخم",
      value: "زخم بازو",
      sourceType: "user_decision",
      status: "confirmed",
      scopeStart: "2015-01-01",
      createdBy: "user",
    });
    const hidden = createFact({
      projectId: project.id,
      subjectId: hero.id,
      attribute: "هویت پدر",
      value: "سردار",
      sourceType: "user_decision",
      status: "confirmed",
      createdBy: "user",
    });
    upsertKnowledge({ projectId: project.id, characterId: hero.id, factId: wound.id, knowledge: "knows" });
    upsertKnowledge({ projectId: project.id, characterId: hero.id, factId: hidden.id, knowledge: "suspects" });

    const knowledge = buildKnowledgeContext(project.id, scene.id, [hero.id]);
    expect(knowledge[0].knows.map((k) => k.attribute)).toContain("زخم");
    const suspects = knowledge[0].suspects.map((s) => s.attribute);
    expect(suspects).toContain("هویت پدر");
    expect(knowledge[0].knows.map((k) => k.attribute)).not.toContain("هویت پدر");
  });
});

describe("تعارض نسخه‌های هویتی", () => {
  it("تعارض در طرح دیده می‌شود و تا پذیرش صریح، تولید متوقف است", () => {
    const { project, scene } = projectWithScene("تعارض هویت", "صحنهٔ تعارض.", "2020-05-01");
    const hero = createEntity({ projectId: project.id, kind: "character", name: "آریا" });
    const a = addEntityVersion({ entityId: hero.id, label: "چهرهٔ الف", layer: "identity", payload: { face: "کشیده" }, approved: true });
    const b = addEntityVersion({ entityId: hero.id, label: "چهرهٔ ب", layer: "identity", payload: { face: "گرد" }, approved: true });
    approveEntityVersion(a.id);
    approveEntityVersion(b.id);
    saveSceneState({ sceneId: scene.id, presentEntities: [hero.id], locationId: null });
    const panelId = makePanel(project.id, scene.id, [{ entityId: hero.id, name: hero.name }]);

    const plan = planPanelProduction(project.id, panelId);
    expect(plan.identityConflicts.length).toBeGreaterThan(0);
    expect(plan.identityConflicts[0].candidates.length).toBeGreaterThanOrEqual(2);
    expect(() => enqueuePanelImage(project.id, panelId)).toThrow(/هویتی/);

    const queued = enqueuePanelImage(project.id, panelId, {
      acknowledgeIdentityConflicts: true,
      expectedRequestKey: plan.requestKey,
    });
    expect(queued.requestId).toBeTruthy();
    const snapshot = listEntityVersions(hero.id).length;
    expect(snapshot).toBe(2);
  });
});

describe("مقصد ذخیره هنگام تعویض سریع صحنه", () => {
  it("کار صف‌شده همان صحنه و همان نسخهٔ مبنا را می‌نویسد، حتی اگر callback دیرتر اجرا شود", async () => {
    clearDraft("scene-A");
    clearDraft("scene-B");
    const calls: Array<{ sceneId: string; text: string; baseUpdatedAt: string | null }> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = new SceneSaveCoordinator(async (text, _reason, target) => {
      calls.push({ sceneId: target.sceneId, text, baseUpdatedAt: target.baseUpdatedAt });
      await gate;
      return { text };
    });
    first.open("scene-A", "متن A", "2026-01-01T00:00:00.000Z");
    first.setText("متن تازهٔ A");
    const pending = first.flush("manual");

    // پیش از اجرای callback، صحنه و callback جاری عوض می‌شوند (شبیه‌سازی رندر مجدد).
    const second = new SceneSaveCoordinator(async (text, _reason, target) => {
      calls.push({ sceneId: target.sceneId, text, baseUpdatedAt: target.baseUpdatedAt });
      return { text };
    });
    second.open("scene-B", "متن B", "2026-01-01T00:00:01.000Z");
    second.setText("متن تازهٔ B");
    expect(second.snapshot().sceneId).toBe("scene-B");

    release();
    await pending;

    expect(calls[0].sceneId).toBe("scene-A");
    expect(calls[0].text).toBe("متن تازهٔ A");
    expect(calls[0].baseUpdatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(calls.every((call) => call.sceneId === "scene-A")).toBe(true);
  });

  it("پاسخ دیررس ذخیرهٔ صحنهٔ دیگر، متن جاری را بازنویسی نمی‌کند", async () => {
    clearDraft("scene-A");
    clearDraft("scene-B");
    const slow = new SceneSaveCoordinator(async (text) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { text };
    });
    slow.open("scene-A", "A", null);
    slow.setText("A تازه");
    const pending = slow.flush("manual");

    const active = new SceneSaveCoordinator(async (text) => ({ text }));
    active.open("scene-B", "B", null);
    active.setText("B تازه");
    await pending;
    await active.flush("manual");
    expect(active.snapshot().text).toBe("B تازه");
    expect(active.snapshot().ack).toBe("B تازه");
  });
});

describe("پیش‌نمایش و فریز طرح ارسالی", () => {
  it("گزینه‌های اندازه و محدودیت، کلید طرح را عوض می‌کنند و کلید کهنه رد می‌شود", () => {
    const { project, scene } = projectWithScene("فریز طرح");
    const hero = createEntity({ projectId: project.id, kind: "character", name: "آریا" });
    saveSceneState({ sceneId: scene.id, presentEntities: [hero.id], locationId: null });
    const panelId = makePanel(project.id, scene.id, [{ entityId: hero.id, name: hero.name }]);

    const base = planPanelProduction(project.id, panelId);
    const larger = planPanelProduction(project.id, panelId, { size: "1024x1024" });
    const constrained = planPanelProduction(project.id, panelId, { constraints: "هیچ زخم تازه‌ای اضافه نشود" });
    expect(larger.size).toBe("1024x1024");
    expect(constrained.prompt).toContain("هیچ زخم تازه‌ای اضافه نشود");
    expect(constrained.requestKey).not.toBe(base.requestKey);
    expect(larger.requestKey).not.toBe(base.requestKey);

    expect(() => enqueuePanelImage(project.id, panelId, { expectedRequestKey: "stale-key" })).toThrow(/پیش‌نمایش/);
  });
});
