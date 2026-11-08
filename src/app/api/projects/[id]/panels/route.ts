import { createHash } from "node:crypto";
import { z } from "zod";
import { body, fail, guard, guardRead, json } from "@/server/http";
import { defaultAdaptationId } from "@/server/repo/projects";
import { createPanels, listPanels, requirePanel, reorderPanels } from "@/server/repo/panels";
import { splitSceneIntoPanels } from "@/server/adaptation";
import { enqueueAdaptation } from "@/server/engine";
import { getRequest } from "@/server/repo/ai";
import { getEntity, getSceneState } from "@/server/repo/world";
import { panelProposalSchema } from "@/server/validate";
import { getScene } from "@/server/repo/projects";
import { assertSameProject, AppError } from "@/server/http";
import { nowIso } from "@/server/db";
import { assertEntitiesOwned } from "@/server/ownership";

const postSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("local-split"),
    sceneId: z.string().min(1),
    target: z.number().int().min(1).max(28).default(12),
    commit: z.boolean().default(false),
  }),
  z.object({ action: z.literal("add-proposals"), sceneId: z.string().min(1), proposals: panelProposalSchema }),
  z.object({
    action: z.literal("use-ai-result"),
    sceneId: z.string().min(1),
    requestId: z.string().min(1),
    /** پذیرش صریح وقتی متن صحنه پس از صف‌شدن تغییر کرده است. */
    acceptChangedSource: z.boolean().default(false),
  }),
  z.object({
    action: z.literal("reorder"),
    sceneId: z.string().min(1),
    orderedIds: z.array(z.string().min(1)).min(1).max(200),
  }),
  z.object({
    action: z.literal("adapt-ai"),
    sceneId: z.string().min(1),
    target: z.number().int().min(1).max(28).optional(),
  }),
]);

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guardRead(req);
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const sceneId = url.searchParams.get("sceneId") ?? undefined;
    if (sceneId) {
      const scene = getScene(sceneId);
      if (!scene) throw new AppError("صحنه پیدا نشد.", 404, "scene_missing");
      assertSameProject(scene.projectId, id, "صحنه");
    }
    return json({ panels: listPanels(id, { sceneId }) });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guard(req);
    const { id } = await ctx.params;
    const input = await body(req, postSchema);
    const scene = getScene(input.sceneId);
    if (!scene) throw new AppError("صحنه پیدا نشد.", 404, "scene_missing");
    assertSameProject(scene.projectId, id, "صحنه");

    if (input.action === "reorder") {
      // ترتیب باید دقیقاً همان مجموعهٔ پنل‌های همین صحنه باشد؛ نه بیشتر، نه کمتر.
      const current = listPanels(id, { sceneId: input.sceneId });
      const currentIds = new Set(current.map((panel) => panel.id));
      if (input.orderedIds.length !== current.length || new Set(input.orderedIds).size !== current.length) {
        throw new AppError("فهرست ترتیب با پنل‌های این صحنه یکی نیست.", 409, "reorder_mismatch");
      }
      for (const panelId of input.orderedIds) {
        const panel = requirePanel(panelId);
        assertSameProject(panel.projectId, id, "پنل");
        if (!currentIds.has(panelId)) throw new AppError("پنل به این صحنه تعلق ندارد.", 409, "reorder_mismatch");
      }
      reorderPanels(input.sceneId, input.orderedIds);
      return json({ panels: listPanels(id, { sceneId: input.sceneId }) });
    }

    if (input.action === "local-split") {
      const state = getSceneState(input.sceneId);
      assertEntitiesOwned(id, [...state.presentEntities, ...(state.locationId ? [state.locationId] : [])]);
      const characters = state.presentEntities
        .map((entityId) => getEntity(entityId))
        .filter((e): e is NonNullable<typeof e> => Boolean(e) && e!.kind === "character")
        .map((e) => ({ id: e.id, name: e.name }));
      const proposals = splitSceneIntoPanels({
        text: scene.text,
        characters,
        locationName: state.locationId ? getEntity(state.locationId)?.name ?? "" : "",
        target: input.target,
        isFlashback: scene.isFlashback,
        storyDate: scene.storyDate,
      });
      if (!input.commit) {
        return json({ proposals, note: "پیشنهاد محلی؛ هنوز ذخیره نشده است." });
      }
      const panels = createPanels({
        projectId: id,
        adaptationId: defaultAdaptationId(id),
        sceneId: input.sceneId,
        sourceSceneVersionId: scene.currentVersionId,
        proposals,
        identitySnapshot: { method: "local-split", note: "بدون AI ساخته شد" },
      });
      return json({ panels }, { status: 201 });
    }

    if (input.action === "add-proposals") {
      const panels = createPanels({
        projectId: id,
        adaptationId: defaultAdaptationId(id),
        sceneId: input.sceneId,
        sourceSceneVersionId: scene.currentVersionId,
        proposals: input.proposals.panels,
        identitySnapshot: { method: "user-edited" },
      });
      return json({ panels }, { status: 201 });
    }

    if (input.action === "use-ai-result") {
      const request = getRequest(input.requestId);
      if (!request || !request.parsed) {
        throw new AppError("نتیجهٔ این درخواست پیدا نشد یا نامعتبر است.", 404, "result_missing");
      }
      assertSameProject(request.projectId, id, "درخواست");
      const requestSceneId = String((request.inputs as Record<string, unknown>).sceneId ?? "");
      if (requestSceneId !== input.sceneId) {
        throw new AppError(
          "این نتیجه برای صحنهٔ دیگری ساخته شده است.",
          409,
          "source_scene_mismatch",
          "پیشنهاد را برای همان صحنه‌ای که فرستاده شده اعمال کنید.",
        );
      }
      const snapshotHash = String((request.inputs as Record<string, unknown>).textHash ?? "");
      const currentHash = createHash("sha256").update(scene.text).digest("hex");
      if (snapshotHash && snapshotHash !== currentHash && !input.acceptChangedSource) {
        throw new AppError(
          "متن صحنه پس از ثبت این درخواست تغییر کرده است.",
          409,
          "source_changed",
          "پیشنهادها بر پایهٔ نسخهٔ قبلی متن‌اند. اگر می‌پذیرید، با تأیید صریح اعمال کنید یا دوباره اقتباس بگیرید.",
        );
      }
      const parsed = panelProposalSchema.safeParse(request.parsed);
      if (!parsed.success) {
        throw new AppError("نتیجهٔ AI با ساختار پنل سازگار نیست.", 400, "invalid_result");
      }
      /*
       * پذیرش دوبارهٔ همان نتیجه، پنل تکراری نمی‌سازد: پنل‌هایی که از این
       * درخواست ساخته شده‌اند برگردانده می‌شوند.
       */
      const existing = listPanels(id, { sceneId: input.sceneId }).filter((panel) => {
        const meta = panel.identitySnapshot as Record<string, unknown> | null;
        return meta?.productionRequestId === request.id;
      });
      if (existing.length) {
        return json(
          {
            panels: existing,
            duplicate: true,
            note: "این نتیجه پیش‌تر به برد افزوده شده است؛ پنل تکراری ساخته نشد.",
          },
          { status: 200 },
        );
      }

      /*
       * منشأ واقعی نتیجه، همان نسخه و هشی است که درخواست بر آن ساخته شد.
       * اگر متن صحنه بعداً عوض شده باشد، این واقعیت جدا ثبت می‌شود و نتیجه
       * به‌عنوان «تولیدشده از تازه‌ترین متن» برچسب نمی‌خورد.
       */
      const snapshotVersionId = String((request.inputs as Record<string, unknown>).sceneVersionId ?? "") || null;
      const sourceTextHash = snapshotHash || currentHash;
      const basedOnOlderRevision = Boolean(snapshotHash) && snapshotHash !== currentHash;
      const panels = createPanels({
        projectId: id,
        adaptationId: defaultAdaptationId(id),
        sceneId: input.sceneId,
        sourceSceneVersionId: snapshotVersionId ?? scene.currentVersionId,
        proposals: parsed.data.panels,
        identitySnapshot: {
          method: "ai",
          model: request.model,
          provider: request.provider,
          requestId: request.id,
          productionRequestId: request.id,
          sourceSceneVersionId: snapshotVersionId,
          sourceTextHash,
          acceptedAgainstTextHash: currentHash,
          basedOnOlderRevision,
          acceptedAt: nowIso(),
        },
      });
      return json(
        {
          panels,
          basedOnOlderRevision,
          note: basedOnOlderRevision
            ? "پنل‌ها از نسخهٔ پیشین متن ساخته شده‌اند و همین به‌عنوان منشأ ثبت شد."
            : "پنل‌ها افزوده شدند.",
        },
        { status: 201 },
      );
    }

    const result = enqueueAdaptation(id, input.sceneId, { panelTarget: input.target });
    return json(
      {
        job: result.job,
        requestId: result.requestId,
        snapshot: result.snapshot,
        note: "درخواست با همان نسخهٔ فعلی متن و وضعیت صحنه در صف ثبت شد؛ نوشتن متوقف نمی‌شود.",
      },
      { status: 202 },
    );
  } catch (error) {
    return fail(error);
  }
}
