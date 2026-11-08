import fs from "node:fs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { createProjectPackage, restorePackage } from "@/server/backup";
import { createChapter, createProject, createScene, listScenes, requireProject, saveSceneText } from "@/server/repo/projects";
import { createEntity, createFact, listFacts } from "@/server/repo/world";
import { createReference, listReferences } from "@/server/repo/refs";
import { saveImage } from "@/server/storage";
import { getDb, rows } from "@/server/db";
import { exportMarkdown, exportFile } from "@/server/export";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function seedProject(title: string) {
  const project = createProject({ title });
  const chapter = createChapter(project.id, "فصل یک");
  const scene = createScene({ chapterId: chapter.id, title: "صحنهٔ یک" });
  saveSceneText({ sceneId: scene.id, text: "آریا به بازار برگشت. «دیر آمدی.»", reason: "manual" });
  const entity = createEntity({ projectId: project.id, kind: "character", name: "آریا", summary: "قهرمان" });
  createFact({
    projectId: project.id,
    subjectId: entity.id,
    attribute: "چشم",
    value: "خاکستری",
    sourceType: "user_decision",
    status: "confirmed",
  });
  const asset = saveImage({ buffer: TINY_PNG, filename: "ref.png", kind: "reference" });
  createReference({
    projectId: project.id,
    assetId: asset.id,
    title: "مرجع آریا",
    roles: ["identity"],
    entityIds: [entity.id],
    status: "approved",
    origin: "local_upload",
  });
  return { project, entity, asset };
}

describe("پشتیبان و بازیابی", () => {
  it("بستهٔ پروژه متن، تصویر و کلیدها را درست جدا می‌کند", async () => {
    const { project, asset } = seedProject("بستهٔ آزمون");
    const { buffer, manifest } = await createProjectPackage(project.id);
    expect(manifest.secretsIncluded).toBe(false);
    expect(manifest.projectId).toBe(project.id);
    expect(manifest.assets.length).toBeGreaterThan(0);
    const zip = await JSZip.loadAsync(buffer);
    const files = Object.keys(zip.files);
    expect(files).toContain("studio.db");
    expect(files.some((f) => f.includes("api-key"))).toBe(false);
    expect(files.some((f) => f.includes(asset.storageKey))).toBe(true);
    expect(files.some((f) => f.endsWith("manifest.json"))).toBe(true);
  });

  it("بازیابی در پروژهٔ تازه، متن و ارتباط تصویر را حفظ می‌کند", async () => {
    const { project, entity } = seedProject("پروژهٔ مبدأ");
    const { buffer } = await createProjectPackage(project.id);
    const result = await restorePackage(buffer);
    expect(result.projectId).not.toBe(project.id);

    const restored = requireProject(result.projectId);
    const scenes = listScenes(restored.id);
    expect(scenes[0].text).toContain("آریا به بازار برگشت");
    const facts = listFacts(restored.id);
    expect(facts[0].attribute).toBe("چشم");
    const restoredEntity = rows("SELECT * FROM entities WHERE project_id = ?", restored.id)[0];
    expect(restoredEntity).toBeTruthy();
    expect(facts[0].subjectId).toBe(String(restoredEntity.id));
    expect(facts[0].subjectId).not.toBe(entity.id);
    const refs = listReferences(restored.id);
    expect(refs).toHaveLength(1);
    const assetRow = getDb().prepare("SELECT * FROM assets WHERE id = ?").get(refs[0].assetId) as { storage_key: string };
    const abs = `${process.env.RAVAYAT_DATA_DIR}/${assetRow.storage_key}`;
    expect(fs.existsSync(abs)).toBe(true);
  });

  it("مسیر خطرناک داخل بسته رد می‌شود", async () => {
    const zip = new JSZip();
    zip.file("manifest.json", JSON.stringify({ app: "ravayat-studio", schemaVersion: 1, exportedAt: "", projectId: "x", projectTitle: "x", assets: [], secretsIncluded: false, notes: "" }));
    zip.file("studio.db", Buffer.from("not-a-db"));
    zip.file("files/../../evil.txt", "boom");
    zip.file("../evil.txt", "boom");
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    await expect(restorePackage(buffer)).rejects.toThrow(/مسیر/);
  });

  it("خروجی Markdown با BOM و متن فارسی ذخیره می‌شود", () => {
    const { project } = seedProject("خروجی متن");
    const record = exportMarkdown(project.id);
    const file = exportFile(record.id);
    const data = fs.readFileSync(file.abs);
    expect(data[0]).toBe(0xef);
    expect(data[1]).toBe(0xbb);
    expect(data[2]).toBe(0xbf);
    expect(data.toString("utf8")).toContain("آریا به بازار برگشت");
  });
});
