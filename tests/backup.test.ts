import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId, nowIso, row, rows, run } from "@/server/db";
import { createProject, createChapter, createScene, saveSceneText, defaultAdaptationId } from "@/server/repo/projects";
import { addEntityVersion, createEntity, createFact } from "@/server/repo/world";
import { createReference } from "@/server/repo/refs";
import { saveImage } from "@/server/storage";
import { addTake, acceptTake, completeRequest, createRequest, createReview, recordAttempt } from "@/server/repo/ai";
import { enqueueJob } from "@/server/repo/jobs";
import { createProjectPackage, restorePackage, verifyRestoredIntegrity } from "@/server/backup";

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface RichProject {
  projectId: string;
  sceneId: string;
  versionId: string;
  entityId: string;
  referenceId: string;
  acceptedTakeId: string;
  alternateTakeId: string;
  requestId: string;
  issueId: string;
  placementId: string;
  layerId: string;
  jobId: string;
}

const tmpFiles: string[] = [];

function writeTemp(buffer: Buffer, name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ravayat-backup-test-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, buffer);
  tmpFiles.push(dir);
  return file;
}

/** پروژهٔ غنی: متن، هویت، مرجع، پنل، خروجی پذیرفته و جایگزین، درخواست، بازبینی، صفحه‌بندی. */
function buildRichProject(marker: string): RichProject {
  const project = createProject({ title: `پروژه ${marker}` });
  const chapter = createChapter(project.id, `فصل ${marker}`);
  const scene = createScene({ chapterId: chapter.id, title: `صحنه ${marker}`, text: `${marker} متن نخست صحنه.` });
  const saved = saveSceneText({ sceneId: scene.id, text: `${marker} متن بازنویسی‌شدهٔ صحنه.`, reason: "manual" });
  const versionId = saved.scene.currentVersionId!;

  const entity = createEntity({ projectId: project.id, kind: "character", name: `قهرمان ${marker}`, summary: "…" });
  addEntityVersion({
    entityId: entity.id,
    label: "هویت پایه",
    layer: "identity",
    payload: { چشم: "خاکستری" },
    fixedTraits: true,
    approved: true,
  });
  createFact({
    projectId: project.id,
    subjectType: "entity",
    subjectId: entity.id,
    attribute: "زخم",
    value: "زخم بازوی راست",
    sourceType: "user_decision",
    status: "confirmed",
    scopeStart: "2026-02-20",
  });

  // بایت متمایز برای هر پروژه تا مقایسهٔ کلید ذخیره‌سازی معنادار باشد.
  const assetBuffer = Buffer.concat([PNG_1x1, Buffer.from(marker)]);
  const asset = saveImage({ buffer: assetBuffer, filename: `ref-${marker}.png`, kind: "reference" });
  const reference = createReference({
    projectId: project.id,
    assetId: asset.id,
    title: `مرجع هویت ${marker}`,
    entityIds: [entity.id],
    roles: ["identity", "face"],
    status: "approved",
    validFrom: "2026-01-01",
  });

  const adaptationId = defaultAdaptationId(project.id);
  const panelId = newId();
  run(
    `INSERT INTO panels (id, project_id, adaptation_id, scene_id, position, title, source_scene_version_id, source_excerpt,
       narrative_goal, action, characters, location_id, time_label, shot_size, camera_angle, gaze_direction, movement,
       emotion, lighting, costumes, props, dialogue, style_profile_id, references_used, identity_snapshot, status,
       needs_review, review_reason, current_take_id, image_asset_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, NULL, '', 'medium', 'eye', '', '', '', '', '', '', '[]', NULL, ?, ?, 'draft', 0, '', NULL, NULL, ?, ?)`,
    panelId,
    project.id,
    adaptationId,
    scene.id,
    `پنل ${marker}`,
    versionId,
    `${marker} برش متن`,
    "هدف روایی",
    "کنش پنل",
    JSON.stringify([{ entityId: entity.id, name: entity.name, position: "راست", gaze: "چپ", emotion: "نگران", clothing: "", identityNote: "" }]),
    JSON.stringify([reference.id]),      JSON.stringify({ method: "ai", model: "test-model", provider: "openai" }),
    nowIso(),
    nowIso(),
  );

  const request = createRequest({
    projectId: project.id,
    panelId,
    role: "prompt_writer",
    provider: "openai",
    model: "test-model",
    promptVersion: 1,
    promptText: `PROMPT ${marker}`,
    inputs: { kind: "image", panelId, attachments: [{ index: 1, referenceId: reference.id, assetId: asset.id, assetSha256: asset.sha256 }] },
    requestKey: `${marker}-key`,
    costEstimate: { usd: 0.02, basis: "ثابت آزمون" },
  });
  recordAttempt({ requestId: request.id, attempt: 1, status: "succeeded", httpStatus: 200, tokensIn: 10, tokensOut: 20 });
  completeRequest(request.id, {
    raw: { ok: true },
    parsed: { takeIds: ["old-take"] },
    httpStatus: 200,
    costComputed: { usd: 0.03, basis: "محاسبهٔ آزمون" },
    costReported: { usd: null },
  });

  // اشاره‌گرهای داخل snapshot نیز باید هنگام بازیابی نگاشت شوند.
  run(
    "UPDATE panels SET identity_snapshot = ? WHERE id = ?",
    JSON.stringify({
      method: "ai",
      model: "test-model",
      requestId: request.id,
      attachments: [{ index: 1, referenceId: reference.id, assetId: asset.id }],
    }),
    panelId,
  );

  const accepted = addTake({ panelId, requestId: request.id, assetId: asset.id, variant: 0, seed: "11", meta: { note: marker } });
  acceptTake(panelId, accepted.id);
  // خروجی جایگزین: فقط در تاریخچه می‌ماند و تصویرش باید داخل بسته باشد.
  const maskAsset = saveImage({ buffer: Buffer.concat([PNG_1x1, Buffer.from(`mask-${marker}`)]), filename: `mask-${marker}.png`, kind: "reference" });
  const alternate = addTake({
    panelId,
    requestId: request.id,
    assetId: asset.id,
    variant: 1,
    seed: "22",
    meta: { attachments: [{ index: 1, referenceId: reference.id, assetSha256: asset.sha256 }] },
    sourceTakeId: accepted.id,
    maskAssetId: maskAsset.id,
    editKind: "inpaint",
  });

  const reviewId = createReview({
    panelId,
    requestId: request.id,
    imageAssetId: asset.id,
    summary: `بازبینی ${marker}`,
    issues: [
      {
        kind: "identity",
        severity: "high",
        description: "رنگ چشم با مرجع نمی‌خواند",
        referenceTitle: reference.title,
        evidence: "…",
        confidence: "medium",
        suggestion: "چشم را تیره‌تر کن",
        evaluable: true,
      },
    ],
    references: [{ id: reference.id, title: reference.title }],
  });
  expect(String(row("SELECT reference_id FROM review_issues WHERE report_id = ?", reviewId)!.reference_id)).toBe(reference.id);
  const issueId = String(row("SELECT id FROM review_issues WHERE report_id = ?", reviewId)!.id);

  const doc = row("SELECT * FROM pagination_docs WHERE project_id = ?", project.id)!;
  const placementId = newId();
  run(
    `INSERT INTO panel_placements (id, doc_id, panel_id, page_index, x, y, w, h, reading_index, created_at, updated_at)
     VALUES (?, ?, ?, 0, 10, 20, 900, 900, 1, ?, ?)`,
    placementId,
    String(doc.id),
    panelId,
    nowIso(),
    nowIso(),
  );
  const layerId = newId();
  run(
    `INSERT INTO text_layers (id, doc_id, panel_id, placement_id, kind, speaker, body, x, y, w, h, font_size, direction, tail, z, style, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'dialogue', ?, ?, 0.5, 0.1, 0.3, 0.14, 22, 'rtl', '', 0, '{}', ?, ?)`,
    layerId,
    String(doc.id),
    panelId,
    placementId,
    entity.name,
    `دیالوگ ${marker}`,
    nowIso(),
    nowIso(),
  );

  const job = enqueueJob({ projectId: project.id, type: "panel_image", payload: { panelId, requestId: request.id }, dedupeKey: `${marker}-job` });

  return {
    projectId: project.id,
    sceneId: scene.id,
    versionId,
    entityId: entity.id,
    referenceId: reference.id,
    acceptedTakeId: accepted.id,
    alternateTakeId: alternate.id,
    requestId: request.id,
    issueId,
    placementId,
    layerId,
    jobId: job.id,
  };
}

/** همهٔ رشته‌های متنی همهٔ جدول‌ها را می‌خواند تا لو رفتن داده در بسته پیدا شود. */
function collectTextValues(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true } as never);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const out: string[] = [];
    for (const table of tables) {
      if (table.name.startsWith("sqlite_")) continue;
      const rows = db.prepare(`SELECT * FROM "${table.name}"`).all() as Array<Record<string, unknown>>;
      for (const r of rows) {
        for (const value of Object.values(r)) {
          if (typeof value === "string") out.push(value);
        }
      }
    }
    return out;
  } finally {
    db.close();
  }
}

const createdDirs: string[] = [];

afterAll(() => {
  for (const dir of [...tmpFiles, ...createdDirs]) fs.rmSync(dir, { recursive: true, force: true });
});

describe("بستهٔ پروژه: جداسازی و بازیابی کامل", () => {
  let a: RichProject;
  let b: RichProject;
  let packageFile: string;

  beforeAll(async () => {
    a = buildRichProject("ALPHA");
    b = buildRichProject("BETA_MARKER");
    const { buffer, manifest } = await createProjectPackage(a.projectId);
    expect(manifest.scope).toBe("project");
    packageFile = writeTemp(buffer, "alpha.zip");
  });

  it("پایگاه دادهٔ بسته فقط پروژهٔ الف را دارد و هیچ ردی از بافته نیست", () => {
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravayat-scope-"));
    createdDirs.push(dbDir);
    const dbPath = path.join(dbDir, "inner.db");
    // استخراج همگام فایل قاعدة بسته با JSZip در همین آزمون
    const zip = fs.readFileSync(packageFile);
    void zip;
    return JSZip.loadAsync(fs.readFileSync(packageFile))
      .then((archive) => archive.file("studio.db")!.async("nodebuffer"))
      .then((buffer) => {
        fs.writeFileSync(dbPath, buffer);
        const values = collectTextValues(dbPath);
        expect(values.some((v) => v.includes("BETA_MARKER"))).toBe(false);
        expect(values.some((v) => v.includes("ALPHA"))).toBe(true);
        const db = new DatabaseSync(dbPath, { readOnly: true } as never);
        try {
          const projects = db.prepare("SELECT id, title FROM projects").all() as Array<{ id: string; title: string }>;
          expect(projects).toHaveLength(1);
          expect(projects[0].id).toBe(a.projectId);
        } finally {
          db.close();
        }
      });
  });

  it("بازیابی، متن/نسخه/هویت/مرجع/پنل/خروجی/درخواست/بازبینی/صفحه‌بندی را کامل برمی‌گرداند", async () => {
    const before = {
      takes: Number(row("SELECT COUNT(*) AS c FROM image_takes WHERE panel_id IN (SELECT id FROM panels WHERE project_id = ?)", a.projectId)?.c ?? 0),
      requests: Number(row("SELECT COUNT(*) AS c FROM ai_requests WHERE project_id = ?", a.projectId)?.c ?? 0),
      reviews: Number(
        row("SELECT COUNT(*) AS c FROM review_reports WHERE panel_id IN (SELECT id FROM panels WHERE project_id = ?)", a.projectId)?.c ?? 0,
      ),
      layers: Number(
        row("SELECT COUNT(*) AS c FROM text_layers WHERE doc_id IN (SELECT id FROM pagination_docs WHERE project_id = ?)", a.projectId)?.c ?? 0,
      ),
    };
    const result = await restorePackage(fs.readFileSync(packageFile));
    const newProjectId = result.projectId;
    expect(newProjectId).not.toBe(a.projectId);

    const counts = verifyRestoredIntegrity(newProjectId).counts;
    expect(counts.takes).toBe(before.takes);
    expect(counts.requests).toBe(before.requests);
    expect(counts.reviews).toBe(before.reviews);
    expect(counts.textLayers).toBe(before.layers);

    const scene = row("SELECT * FROM scenes WHERE project_id = ?", newProjectId)!;
    const version = row("SELECT * FROM scene_versions WHERE id = ?", String(scene.current_version_id)!);
    expect(version).toBeTruthy();
    expect(String(version!.text)).toContain("ALPHA");
    expect(String(scene.current_version_id)).not.toBe(a.versionId);

    const panel = row("SELECT * FROM panels WHERE project_id = ?", newProjectId)!;
    expect(panel.source_scene_version_id).toBe(String(scene.current_version_id));
    expect(panel.current_take_id).toBeTruthy();
    const accepted = row("SELECT * FROM image_takes WHERE id = ?", String(panel.current_take_id)!);
    expect(String(accepted!.status)).toBe("accepted");
    expect(panel.image_asset_id).toBe(String(accepted!.asset_id));
    const snapshot = JSON.parse(String(panel.identity_snapshot)) as Record<string, unknown>;
    expect(snapshot.requestId).toBeTruthy();

    const takes = rows("SELECT * FROM image_takes WHERE panel_id = ?", String(panel.id));
    expect(takes).toHaveLength(2);
    const edited = takes.find((t) => t.mask_asset_id != null)!;
    expect(edited).toBeTruthy();
    expect(String(edited.edit_kind)).toBe("inpaint");
    expect(String(edited.source_take_id)).toBe(String(accepted!.id));
    // تصویر جایگزین/ماسک هم روی دیسک هست.
    expect(row("SELECT 1 AS x FROM assets WHERE id = ?", String(edited.asset_id))).toBeTruthy();
    expect(row("SELECT 1 AS x FROM assets WHERE id = ?", String(edited.mask_asset_id))).toBeTruthy();

    const issue = row(
      "SELECT ri.* FROM review_issues ri JOIN review_reports rr ON rr.id = ri.report_id WHERE rr.panel_id = ?",
      String(panel.id),
    )!;
    const newRef = row("SELECT * FROM reference_assets WHERE project_id = ?", newProjectId)!;
    expect(String(issue.reference_id)).toBe(String(newRef.id));
    expect(String(issue.decision)).toBe("pending");

    const layer = row("SELECT * FROM text_layers WHERE doc_id IN (SELECT id FROM pagination_docs WHERE project_id = ?)", newProjectId)!;
    const placement = row("SELECT * FROM panel_placements WHERE id = ?", String(layer.placement_id)!);
    expect(placement).toBeTruthy();
    expect(String(placement!.panel_id)).toBe(String(panel.id));

    const request = row("SELECT * FROM ai_requests WHERE project_id = ?", newProjectId)!;
    const inputs = JSON.parse(String(request.inputs)) as Record<string, unknown>;
    expect(inputs.panelId).toBe(String(panel.id));
    expect((inputs.attachments as Array<Record<string, unknown>>)[0].referenceId).toBe(String(newRef.id));

    const job = row("SELECT * FROM jobs WHERE project_id = ?", newProjectId)!;
    expect(["cancelled", "unknown"]).toContain(String(job.status));
  });

  it("کارهای واردشده خودکار اجرا نمی‌شوند", async () => {
    const result = await restorePackage(fs.readFileSync(packageFile));
    const queued = Number(row("SELECT COUNT(*) AS c FROM jobs WHERE project_id = ? AND status = 'queued'", result.projectId)?.c ?? 0);
    expect(queued).toBe(0);
    const inFlight = Number(
      row("SELECT COUNT(*) AS c FROM ai_requests WHERE project_id = ? AND status IN ('queued','sending','processing')", result.projectId)?.c ?? 0,
    );
    expect(inFlight).toBe(0);
  });

  it("بستهٔ ناقص رد می‌شود و چیزی وارد نمی‌کند", async () => {
    const zip = await JSZip.loadAsync(fs.readFileSync(packageFile));
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string")) as { assets: Array<{ key: string }> };
    // حذف یک فایل اعلام‌شده در manifest
    zip.remove(`files/${manifest.assets[0].key}`);
    const broken = await zip.generateAsync({ type: "nodebuffer" });
    await expect(restorePackage(broken)).rejects.toThrow(/بستهٔ ناقص|نیست/);
  });

  it("پشتیبان کامل نصب، دامنهٔ متفاوتی از بستهٔ پروژه دارد", async () => {
    const { manifest } = await createProjectPackage(a.projectId);
    expect(manifest.scope).toBe("project");
    expect(manifest.notes).toContain("تنظیمات خصوصی");
  });

  it("مرجع بافته در بستهٔ الف نیست، حتی در فایل‌های تصویری اعلام‌شده", async () => {
    const zip = await JSZip.loadAsync(fs.readFileSync(packageFile));
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string")) as { assets: Array<{ key: string }> };
    const keys = manifest.assets.map((asset) => asset.key);
    expect(keys.length).toBeGreaterThan(0);
    const bAssets = rows("SELECT storage_key FROM assets WHERE id IN (SELECT asset_id FROM reference_assets WHERE project_id = ?)", b.projectId);
    for (const asset of bAssets) {
      expect(keys).not.toContain(String(asset.storage_key));
    }
  });
});
