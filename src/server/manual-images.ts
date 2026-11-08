import JSZip from "jszip";
import { newId, nowIso, row, sha256, run, transaction } from "./db";
import { AppError } from "./http";
import { planPanelProduction, type ProduceOptions } from "./engine";
import { requirePanel } from "./repo/panels";
import { createRequest, getRequest, completeRequest, addTake } from "./repo/ai";
import { getScene } from "./repo/projects";
import { loadVerifiedAttachments } from "./attachments";
import { imageSize, saveImage, writeExport } from "./storage";
import type { AttachmentEntry } from "./attachments";

export async function prepareManualImages(panelId: string, options: ProduceOptions = {}) {
  const panel = requirePanel(panelId); const scene = getScene(panel.sceneId);
  const plan = planPanelProduction(panel.projectId, panel.id, options);
  if (options.expectedRequestKey && options.expectedRequestKey !== plan.requestKey) throw new AppError("پیش‌نمایش تغییر کرده است؛ آن را دوباره بررسی کنید.", 409, "plan_outdated");
  if (plan.blocking.length) throw new AppError(plan.blocking.join("؛ "), 409, "plan_blocked");
  const attachments = loadVerifiedAttachments(plan.attachments);
  const zip = new JSZip();
  zip.file("prompt.txt", plan.prompt);
  zip.file("README.txt", "این بسته را خودتان در ChatGPT بارگذاری کنید. برنامه چیزی را خودکار به ChatGPT نمی‌فرستد. خروجی را دانلود و به همین پنل وارد کنید. تصاویر نمونه یا خروجی‌های تازه، خودکار مرجع تأییدشده نیستند.");
  for (const { entry, asset, buffer } of attachments) zip.file(`references/image-${String(entry.index).padStart(2, "0")}.${asset.mime === "image/jpeg" ? "jpg" : asset.mime === "image/webp" ? "webp" : "png"}`, buffer);
  const captured = { panelId, sourceSceneId: panel.sceneId, sourceVersionId: panel.sourceSceneVersionId, textHash: sha256(scene?.text ?? ""), panelHash: manualPanelHash(panelId), attachments: plan.attachments };
  zip.file("manifest.json", JSON.stringify(captured, null, 2));
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  const filename = `panel-${panel.position}-chatgpt-handoff.zip`; const { key } = writeExport(panel.projectId, filename, buffer);
  const request = createRequest({ projectId: panel.projectId, panelId, role: "manual_handoff", provider: "manual_chatgpt", model: "manual-transfer", promptVersion: 1, promptText: plan.prompt, inputs: captured, requestKey: newId(), costEstimate: { usd: null, basis: "انتقال دستی؛ برنامه درخواست تولید ارسال نمی‌کند" } });
  completeRequest(request.id, { raw: null, parsed: { prepared: true }, costComputed: { usd: null, basis: "بدون فراخوانی سرویس در برنامه" } });
  const exportId = newId(); run("INSERT INTO exports (id, project_id, kind, asset_id, filename, meta, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?)", exportId, panel.projectId, "manual_handoff", filename, JSON.stringify({ key }), nowIso());
  return { handoffId: request.id, url: `/api/exports/${exportId}`, prompt: plan.prompt, referenceCount: attachments.length };
}
function manualPanelHash(panelId: string) {
  const p = requirePanel(panelId);
  return sha256(JSON.stringify([p.action,p.characters,p.locationId,p.styleProfileId,p.lighting,p.props,p.shotSize,p.cameraAngle,p.dialogue]));
}
export function importManualImage(panelId: string, handoffId: string, buffer: Buffer, filename: string, acknowledgeChanged: boolean) {
  const dimensions = imageSize(buffer);
  if (!dimensions || !["image/png", "image/jpeg", "image/webp"].includes(dimensions.mime)) throw new AppError("فایل باید یک تصویر معتبر PNG، JPEG یا WebP باشد.", 400, "invalid_image");
  const panel = requirePanel(panelId); const handoff = getRequest(handoffId);
  if (!handoff || handoff.role !== "manual_handoff" || handoff.panelId !== panelId || handoff.projectId !== panel.projectId) throw new AppError("بستهٔ مرجع باید متعلق به همین پنل باشد.", 404, "handoff_missing");
  const scene = getScene(panel.sceneId);
  const changed = handoff.inputs.textHash !== sha256(scene?.text ?? "") || handoff.inputs.panelHash !== manualPanelHash(panelId);
  if (changed && !acknowledgeChanged) throw new AppError("متن یا طرح پنل پس از آماده‌سازی بسته تغییر کرده است؛ برای واردکردن خروجی قدیمی تأیید صریح لازم است.", 409, "manual_source_changed");
  const hash = sha256(buffer);
  const existing = row("SELECT t.id FROM image_takes t JOIN assets a ON a.id=t.asset_id WHERE t.request_id=? AND a.sha256=?", handoffId, hash);
  if (existing) return { takeId: String(existing.id), duplicate: true };
  const asset = saveImage({ buffer, filename, kind: "panel" });
  return transaction(() => {
    const take = addTake({ panelId, requestId: handoffId, assetId: asset.id, variant: 0, meta: { origin: "manual_chatgpt", basedOnChangedSource: changed } });
    // Import is a candidate, never automatic identity-reference approval or final panel approval.
    run("UPDATE panels SET references_used=?, identity_snapshot=?, needs_review=1, review_reason=?, updated_at=? WHERE id=?", JSON.stringify((handoff.inputs.attachments as AttachmentEntry[]).map(a => a.referenceId)), JSON.stringify({ ...handoff.inputs, handoffId }), "تصویر واردشده نیازمند انتخاب و بازبینی است.", nowIso(), panelId);
    return { takeId: take.id, duplicate: false };
  });
}
