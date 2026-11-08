import { z } from "zod";
import { AppError, body, fail, guard, json } from "@/server/http";
import {
  listSceneVersions,
  requireScene,
  saveSceneText,
  updateSceneMeta,
  deleteScene,
  getScene,
  listScenes,
} from "@/server/repo/projects";
import { markPanelsStale } from "@/server/repo/panels";

const patchSchema = z.object({
  text: z.string().max(2_000_000).optional(),
  reason: z.enum(["manual", "autosave", "restore", "ai"]).default("autosave"),
  /** نسخهٔ مبنا: اگر سرور از آن جلوتر رفته باشد، نوشتن بی‌صدا اعمال نمی‌شود. */
  expectedUpdatedAt: z.string().max(80).nullable().optional(),
  /** بازنویسی صریح پس از دیدن تعارض (تصمیم کاربر) */
  force: z.boolean().default(false),
  title: z.string().max(200).optional(),
  objective: z.string().max(2000).optional(),
  storyDate: z.string().max(40).nullable().optional(),
  isFlashback: z.boolean().optional(),
  status: z.enum(["draft", "writing", "complete"]).optional(),
});

const postSchema = z.object({ action: z.literal("restore"), versionId: z.string().min(1) });

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const scene = requireScene(id);
    return json({ scene, versions: listSceneVersions(id) });
  } catch (error) {
    return fail(error);
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guard(req);
    const { id } = await ctx.params;
    const patch = await body(req, patchSchema);
    const scene = requireScene(id);
    let result = scene;
    let versionCreated = false;
    if (patch.text !== undefined && patch.text !== scene.text) {
      if (patch.expectedUpdatedAt && !patch.force && patch.expectedUpdatedAt !== scene.updatedAt) {
        throw new AppError(
          "این صحنه پس از شروع ویرایش شما تغییر کرده است.",
          409,
          "stale_write",
          "متن تازه‌تر روی سرور هست. تفاوت را ببینید و انتخاب کنید؛ هیچ‌چیز بی‌صدا بازنویسی نمی‌شود.",
          { serverText: scene.text, serverUpdatedAt: scene.updatedAt },
        );
      }
      const saved = saveSceneText({ sceneId: id, text: patch.text, reason: patch.reason });
      result = saved.scene;
      versionCreated = Boolean(saved.version);
    }
    const metaKeys = ["title", "objective", "storyDate", "isFlashback", "status"] as const;
    let metaChanged = false;
    if (metaKeys.some((k) => patch[k] !== undefined)) {
      result = updateSceneMeta(id, {
        title: patch.title,
        objective: patch.objective,
        storyDate: patch.storyDate,
        isFlashback: patch.isFlashback,
        status: patch.status,
      });
      metaChanged =
        (patch.storyDate !== undefined && patch.storyDate !== scene.storyDate) ||
        (patch.isFlashback !== undefined && patch.isFlashback !== scene.isFlashback);
    }
    /*
     * هر تغییر مؤثر روی منبع، پنل‌های وابسته را «نیازمند بازبینی» می‌کند؛ نه فقط
     * وقتی نسخهٔ تاریخچه ساخته می‌شود. ذخیرهٔ خودکار متن را بدون نسخه عوض می‌کند،
     * و تغییر تاریخ/فلش‌بک هم مجموعهٔ مرجع قطعی معتبر را عوض می‌کند.
     * هیچ تصویری خودکار بازتولید نمی‌شود و هزینه‌ای ایجاد نمی‌گردد.
     */
    if (result.text !== scene.text) {
      markPanelsStale(id, "متن صحنه تغییر کرد؛ پنل‌های وابسته نیازمند بازبینی‌اند.");
    }
    if (metaChanged) {
      markPanelsStale(id, "تاریخ یا وضعیت فلش‌بک صحنه تغییر کرد؛ مرجع معتبر زمانی و پنل‌ها نیازمند بازبینی‌اند.");
    }
    return json({ scene: result, versionCreated, panelsMarked: result.text !== scene.text || metaChanged });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guard(req);
    const { id } = await ctx.params;
    const input = await body(req, postSchema);
    if (input.action === "restore") {
      const versions = listSceneVersions(id, 200);
      const target = versions.find((v) => v.id === input.versionId);
      if (!target) return json({ error: { message: "نسخه پیدا نشد." } }, { status: 404 });
      const saved = saveSceneText({ sceneId: id, text: target.text, reason: "restore" });
      markPanelsStale(id, `متن صحنه به نسخهٔ ${target.version} بازگردانده شد.`);
      return json({ scene: saved.scene, restored: target.version });
    }
    return json({ error: { message: "عملیات ناشناخته" } }, { status: 400 });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guard(req);
    const { id } = await ctx.params;
    const scene = getScene(id);
    if (!scene) return json({ error: { message: "صحنه پیدا نشد." } }, { status: 404 });
    deleteScene(id);
    return json({ scenes: listScenes(scene.projectId) });
  } catch (error) {
    return fail(error);
  }
}
