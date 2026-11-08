import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import JSZip from "jszip";
import { createChapter, createProject, createScene, defaultAdaptationId, saveSceneText } from "@/server/repo/projects";
import { createPanels, getPanel } from "@/server/repo/panels";
import { createReference } from "@/server/repo/refs";
import { completeRequest, listTakes } from "@/server/repo/ai";
import { saveImage } from "@/server/storage";
import { panelProposalSchema } from "@/server/validate";
import { prepareManualImages, importManualImage } from "@/server/manual-images";
import { exportFile } from "@/server/export";
import { getSetting, row, setSetting } from "@/server/db";
import { enqueuePanelImage, enqueueAdaptation } from "@/server/engine";
import { assertAutomaticImages } from "@/server/image-workflow";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
function fixture() {
  const p = createProject({ title: "manual test" }); const c = createChapter(p.id, "chapter"); const s = createScene({ chapterId: c.id, title: "scene", text: "متن" });
  const panel = createPanels({ projectId: p.id, adaptationId: defaultAdaptationId(p.id), sceneId: s.id, sourceSceneVersionId: null, proposals: panelProposalSchema.parse({ panels: [{ action: "کنش" }] }).panels })[0];
  return { p, s, panel };
}
afterEach(() => { setSetting("imageWorkflow", "api"); setSetting("analysisSource", "project"); setSetting("chatgptModel", ""); vi.unstubAllGlobals(); });
describe("manual image workflow", () => {
  it("blocks automatic image admission before any network request", () => {
    const { p, panel } = fixture(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); setSetting("imageWorkflow", "manual_chatgpt");
    expect(() => enqueuePanelImage(p.id, panel.id)).toThrow(/دستی/); expect(fetch).not.toHaveBeenCalled();
    setSetting("imageWorkflow", "api"); expect(() => assertAutomaticImages()).not.toThrow();
  });
  it("exports an ordered prompt/reference package without calling any provider", async () => {
    const { p, panel } = fixture(); const asset = saveImage({ buffer: png, filename: "ref.png", kind: "reference" });
    const ref = createReference({ projectId: p.id, assetId: asset.id, title: "مرجع", roles: ["identity"], status: "approved" });
    const { run } = await import("@/server/db"); run("UPDATE panels SET references_used=? WHERE id=?", JSON.stringify([ref.id]), panel.id);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const result = await prepareManualImages(panel.id); const id = result.url.split("/").at(-1)!;
    const zip = await JSZip.loadAsync(fs.readFileSync(exportFile(id).abs));
    expect(zip.file("prompt.txt")).not.toBeNull(); expect(zip.file("references/image-01.png")).not.toBeNull(); expect(fetch).not.toHaveBeenCalled();
    const imported = importManualImage(panel.id, result.handoffId, png, "result.png", false);
    expect(listTakes(panel.id)).toHaveLength(1); expect(getPanel(panel.id)?.imageAssetId).toBeNull(); expect(getPanel(panel.id)?.needsReview).toBe(true);
    const second = importManualImage(panel.id, result.handoffId, png, "result.png", false); expect(second.duplicate).toBe(true); expect(second.takeId).toBe(imported.takeId);
  });
  it("requires acknowledgement for changed source and rejects another panel's handoff", async () => {
    const { panel, s } = fixture(); const handoff = await prepareManualImages(panel.id);
    saveSceneText({ sceneId: s.id, text: "متن تازه", reason: "manual" });
    expect(() => importManualImage(panel.id, handoff.handoffId, png, "result.png", false)).toThrow(/تغییر/);
    expect(() => importManualImage(panel.id, handoff.handoffId, png, "result.png", true)).not.toThrow();
    const other = fixture(); expect(() => importManualImage(other.panel.id, handoff.handoffId, png, "result.png", true)).toThrow(/همین پنل/);
  });
  it("routes analysis to the chosen subscription without paid API fallback", () => {
    const { p, s } = fixture();
    setSetting("chatgptModels", JSON.stringify([{ id: "only-on-account", label: "Account model" }])); setSetting("analysisSource", "chatgpt"); setSetting("chatgptModel", "only-on-account");
    const result = enqueueAdaptation(p.id, s.id);
    const request = row("SELECT provider,model FROM ai_requests WHERE id=?", result.requestId);
    expect(request).toMatchObject({ provider: "chatgpt", model: "only-on-account" });
  });
});
