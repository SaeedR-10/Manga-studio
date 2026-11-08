import { describe, expect, it } from "vitest";
import { newId, nowIso, row, run, sha256 } from "@/server/db";
import { createChapter, createProject, createScene, defaultAdaptationId, getScene } from "@/server/repo/projects";
import { createEntity, createFact, getSceneState, listEntityVersions, saveSceneState, upsertKnowledge } from "@/server/repo/world";
import { createReference } from "@/server/repo/refs";
import { saveImage } from "@/server/storage";
import { acceptTake, addTake, createRequest } from "@/server/repo/ai";
import { enqueueAdaptation, enqueuePanelImage, enqueueReview, planPanelProduction } from "@/server/engine";
import { readAsset } from "@/server/storage";
import { loadVerifiedAttachments } from "@/server/attachments";
import { assertAuthorized } from "@/server/http";
import { buildKnowledgeContext } from "@/server/context";

const PNG = (label: string) =>
  Buffer.concat([
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ),
    Buffer.from(label),
  ]);

function makePanel(projectId: string, sceneId: string, characters: Array<{ entityId: string; name: string }>): string {
  const panelId = newId();
  const adaptationId = defaultAdaptationId(projectId);
  run(
    `INSERT INTO panels (id, project_id, adaptation_id, scene_id, position, title, source_scene_version_id, source_excerpt,
       narrative_goal, action, characters, location_id, time_label, shot_size, camera_angle, gaze_direction, movement,
       emotion, lighting, costumes, props, dialogue, style_profile_id, references_used, identity_snapshot, status,
       needs_review, review_reason, current_take_id, image_asset_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 'پنل آزمون', NULL, 'برش', 'هدف', 'کنش', ?, NULL, '', 'medium', 'eye', '', '', '', '', '', '', '[]', NULL, '[]', '{}', 'draft', 0, '', NULL, NULL, ?, ?)`,
    panelId,
    projectId,
    adaptationId,
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
    nowIso(),
    nowIso(),
  );
  return panelId;
}

function projectWithScene(title: string) {
  const project = createProject({ title });
  const chapter = createChapter(project.id, "فصل");
  const scene = createScene({ chapterId: chapter.id, title: "صحنه", text: "متن صحنه برای آزمون." });
  return { project, chapter, scene };
}

describe("ترتیب و اتصال مراجع تصویری", () => {
  it("ترتیب انتخاب کاربر حفظ می‌شود و شمارهٔ تصویر در پرامپت با همان ترتیب یکی است", () => {
    const { project, scene } = projectWithScene("ترتیب مراجع");
    const hero = createEntity({ projectId: project.id, kind: "character", name: "آریا" });
    const rival = createEntity({ projectId: project.id, kind: "character", name: "نیلا" });
    const assetA = saveImage({ buffer: PNG("hero"), filename: "hero.png", kind: "reference" });
    const assetB = saveImage({ buffer: PNG("rival"), filename: "rival.png", kind: "reference" });
    const refHero = createReference({
      projectId: project.id,
      assetId: assetA.id,
      title: "هویت آریا",
      entityIds: [hero.id],
      roles: ["identity"],
      status: "approved",
    });
    const refRival = createReference({
      projectId: project.id,
      assetId: assetB.id,
      title: "هویت نیلا",
      entityIds: [rival.id],
      roles: ["identity"],
      status: "approved",
    });
    const panelId = makePanel(project.id, scene.id, [
      { entityId: hero.id, name: hero.name },
      { entityId: rival.id, name: rival.name },
    ]);

    // ترتیب معکوس شناسه‌ها: اول نیلا، بعد آریا.
    const requested = [refRival.id, refHero.id];
    const plan = planPanelProduction(project.id, panelId, { referenceIds: requested });
    expect(plan.attachments.map((a) => a.referenceId)).toEqual(requested);
    expect(plan.attachments[0].assetSha256).toBe(sha256(readAsset(assetB.id).buffer));
    expect(plan.attachments[1].assetSha256).toBe(sha256(readAsset(assetA.id).buffer));

    const imageLines = plan.prompt.split("\n").filter((line) => line.startsWith("- image "));
    expect(imageLines[0]).toContain("image 1 — هویت نیلا");
    expect(imageLines[1]).toContain("image 2 — هویت آریا");

    // درخواست ذخیره‌شده همان manifest را دارد (منبع واحد برای کارگر/آداپتور).
    const produced = enqueuePanelImage(project.id, panelId, { referenceIds: requested });
    const saved = row("SELECT inputs FROM ai_requests WHERE id = ?", produced.requestId)!;
    const inputs = JSON.parse(String(saved.inputs)) as { attachments: Array<{ index: number; referenceId: string; assetSha256: string }> };
    expect(inputs.attachments.map((a) => a.referenceId)).toEqual(requested);
    expect(inputs.attachments.map((a) => a.index)).toEqual([1, 2]);
    expect(inputs.attachments[0].assetSha256).toBe(plan.attachments[0].assetSha256);
  });

  it("تغییر محتوای فایل مرجع پس از تأیید، به‌جای جابه‌جایی بی‌صدای شماره‌ها خطا می‌دهد", () => {
    const { project, scene } = projectWithScene("تغییر مرجع");
    const hero = createEntity({ projectId: project.id, kind: "character", name: "آریا" });
    const asset = saveImage({ buffer: PNG("v1"), filename: "hero.png", kind: "reference" });
    const ref = createReference({
      projectId: project.id,
      assetId: asset.id,
      title: "هویت آریا",
      entityIds: [hero.id],
      roles: ["identity"],
      status: "approved",
    });
    const panelId = makePanel(project.id, scene.id, [{ entityId: hero.id, name: hero.name }]);
    const plan = planPanelProduction(project.id, panelId);
    expect(plan.attachments).toHaveLength(1);
    // شبیه‌سازی تغییر فایل روی دیسک (نباید بی‌صدا پذیرفته شود).
    run("UPDATE assets SET sha256 = 'tampered' WHERE id = ?", asset.id);
    expect(() => loadVerifiedAttachments(plan.attachments)).toThrow(/تغییر کرده/);
  });
});

describe("وضعیت صحنه در اقتباس", () => {
  it("درخواست اقتباس، حاضران و مکان صحنه را پاک نمی‌کند و آن‌ها را فریز می‌کند", () => {
    const { project, scene } = projectWithScene("وضعیت صحنه");
    const hero = createEntity({ projectId: project.id, kind: "character", name: "آریا" });
    const place = createEntity({ projectId: project.id, kind: "location", name: "بازار" });
    saveSceneState({ sceneId: scene.id, presentEntities: [hero.id], locationId: place.id });

    const result = enqueueAdaptation(project.id, scene.id, { panelTarget: 6 });
    const state = getSceneState(scene.id);
    expect(state.presentEntities).toEqual([hero.id]);
    expect(state.locationId).toBe(place.id);
    const inputs = JSON.parse(String(row("SELECT inputs FROM ai_requests WHERE id = ?", result.requestId)!.inputs)) as Record<string, unknown>;
    expect(inputs.presentEntities).toEqual([hero.id]);
    expect(inputs.locationId).toBe(place.id);
    expect(inputs.sceneText).toBe(scene.text);
  });
});

describe("سقف‌ها و بودجه", () => {
  it("سقف تولید هر پنل، درخواست در جریان را هم می‌شمارد و صف‌کردن سریع آن را دور نمی‌زند", () => {
    const { project, scene } = projectWithScene("سقف تولید");
    run(
      "UPDATE projects SET settings = ? WHERE id = ?",
      JSON.stringify({ ...project.settings, caps: { generationsPerPanel: 1, reviewsPerPanel: 1, chapterBudgetUsd: null } }),
      project.id,
    );
    const panelId = makePanel(project.id, scene.id, []);
    const first = enqueuePanelImage(project.id, panelId);
    expect(first.requestId).toBeTruthy();
    expect(() => enqueuePanelImage(project.id, panelId)).toThrow(/سقف/);

    // حتی با تغییر متن پرامپت (کلید متفاوت) باز هم پذیرش رد می‌شود.
    expect(() => enqueuePanelImage(project.id, panelId, { constraints: "متن تازه" })).toThrow(/سقف/);
  });

  it("بودجهٔ فصل شامل همهٔ صحنه‌هاست و درخواست تازه را رد می‌کند", () => {
    const { project, chapter } = projectWithScene("بودجه");
    const scene2 = createScene({ chapterId: chapter.id, title: "صحنهٔ دوم", text: "متن" });
    run(
      "UPDATE projects SET settings = ? WHERE id = ?",
      JSON.stringify({
        ...project.settings,
        image: { provider: "google", model: "gemini-nano-banana-2.1" },
        caps: { generationsPerPanel: 5, reviewsPerPanel: 1, chapterBudgetUsd: 0.0001 },
      }),
      project.id,
    );
    const panel2 = makePanel(project.id, scene2.id, []);
    expect(() => enqueuePanelImage(project.id, panel2)).toThrow(/بودجه/);
  });

  it("سقف بازبینی، بازبینی در جریان را هم می‌شمارد", () => {
    const { project, scene } = projectWithScene("سقف بازبینی");
    const panelId = makePanel(project.id, scene.id, []);
    const asset = saveImage({ buffer: PNG("panel"), filename: "panel.png", kind: "panel" });
    const req = createRequest({
      projectId: project.id,
      panelId,
      role: "prompt_writer",
      provider: "openai",
      model: "gpt-6.1-sol",
      promptVersion: 1,
      promptText: "x",
      inputs: {},
      requestKey: "review-cap-seed",
      costEstimate: { usd: null, basis: "آزمون" },
    });
    const take = addTake({ panelId, requestId: req.id, assetId: asset.id, variant: 0 });
    acceptTake(panelId, take.id);
    enqueueReview(project.id, panelId);
    expect(() => enqueueReview(project.id, panelId)).toThrow(/سقف/);
  });
});

describe("مرز محلی", () => {
  const original = { token: process.env.RAVAYAT_SESSION_TOKEN, origin: process.env.RAVAYAT_APP_ORIGIN };

  function setEnv(token: string, origin: string) {
    if (token) process.env.RAVAYAT_SESSION_TOKEN = token;
    else delete process.env.RAVAYAT_SESSION_TOKEN;
    if (origin) process.env.RAVAYAT_APP_ORIGIN = origin;
    else delete process.env.RAVAYAT_APP_ORIGIN;
  }

  it("مبدأ با پورت متفاوت رد می‌شود و مبدأ دقیق پذیرفته می‌شود", () => {
    setEnv("token-123456", "http://127.0.0.1:3310");
    try {
      const wrongPort = new Request("http://127.0.0.1:3310/api/projects", {
        method: "POST",
        headers: { origin: "http://127.0.0.1:9999", "x-ravayat-session": "token-123456" },
      });
      expect(() => assertAuthorized(wrongPort, "write")).toThrow(/مبدأ/);
      const right = new Request("http://127.0.0.1:3310/api/projects", {
        method: "POST",
        headers: { origin: "http://127.0.0.1:3310", "x-ravayat-session": "token-123456" },
      });
      expect(() => assertAuthorized(right, "write")).not.toThrow();
    } finally {
      setEnv(original.token ?? "", original.origin ?? "");
    }
  });

  it("بدون توکن نشست، درخواست رد می‌شود؛ در حالت توسعه، نوشتن بدون Origin رد می‌شود", () => {
    setEnv("token-abcdef", "http://127.0.0.1:3310");
    try {
      const noToken = new Request("http://127.0.0.1:3310/api/projects", {
        method: "POST",
        headers: { origin: "http://127.0.0.1:3310" },
      });
      expect(() => assertAuthorized(noToken, "write")).toThrow(/توکن/);
    } finally {
      setEnv("", "http://127.0.0.1:3310");
    }
    try {
      const devWrite = new Request("http://127.0.0.1:3310/api/projects", { method: "POST" });
      expect(() => assertAuthorized(devWrite, "write")).toThrow(/مبدأ/);
      const devRead = new Request("http://127.0.0.1:3310/api/projects", { method: "GET" });
      expect(() => assertAuthorized(devRead, "read")).not.toThrow();
    } finally {
      setEnv(original.token ?? "", original.origin ?? "");
    }
  });
});

describe("دانش شخصیت در اقتباس", () => {
  it("پیش از صحنهٔ افشا، راز در پرامپت اقتباس به‌عنوان «بی‌خبر» می‌آید و پس از آن «می‌داند»", () => {
    const project = createProject({ title: "دانش" });
    const chapter = createChapter(project.id, "فصل");
    const before = createScene({ chapterId: chapter.id, title: "پیش از افشا", text: "صحنهٔ نخست." });
    const after = createScene({ chapterId: chapter.id, title: "پس از افشا", text: "صحنهٔ دوم." });
    const hero = createEntity({ projectId: project.id, kind: "character", name: "آریا" });
    const secret = createFact({
      projectId: project.id,
      subjectType: "entity",
      subjectId: hero.id,
      attribute: "راز خانوادگی",
      value: "برادرش زنده است",
      sourceType: "user_decision",
      status: "confirmed",
    });
    upsertKnowledge({ projectId: project.id, characterId: hero.id, factId: secret.id, knowledge: "knows", revealSceneId: after.id });

    const early = buildKnowledgeContext(project.id, before.id, [hero.id]);
    expect(early[0].knows).toHaveLength(0);
    expect(early[0].withheld.map((w) => w.attribute)).toContain("راز خانوادگی");
    const late = buildKnowledgeContext(project.id, after.id, [hero.id]);
    expect(late[0].knows.map((k) => k.attribute)).toContain("راز خانوادگی");

    saveSceneState({ sceneId: before.id, presentEntities: [hero.id], locationId: null });
    const queued = enqueueAdaptation(project.id, before.id, { panelTarget: 4 });
    const inputs = JSON.parse(String(row("SELECT inputs FROM ai_requests WHERE id = ?", queued.requestId)!.inputs)) as {
      promptUser: string;
      knowledge: Array<{ name: string; withheld: string[] }>;
    };
    expect(inputs.knowledge[0].withheld).toContain("راز خانوادگی");
    // دستور صریح: این شخصیت در این صحنه نباید به راز اشاره کند (فقط نام ویژگی، نه ادعای دانستن).
    expect(inputs.promptUser).toContain("بی‌خبر");
    const knowledgeBlock = inputs.promptUser.split("character_knowledge")[1] ?? "";
    expect(knowledgeBlock).toContain("راز خانوادگی");
    expect(knowledgeBlock).not.toContain("می‌داند: راز خانوادگی");
    expect(getScene(before.id)?.text).toBe("صحنهٔ نخست.");
    expect(listEntityVersions(hero.id)).toHaveLength(0);
  });
});
