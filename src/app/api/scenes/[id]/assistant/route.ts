import { z } from "zod";
import { sha256 } from "@/server/db";
import { AppError, body, fail, guard, json } from "@/server/http";
import { getScene, saveSceneText } from "@/server/repo/projects";
import { createEntity, createFact, listEntities } from "@/server/repo/world";
import { getRequest } from "@/server/repo/ai";
import { markPanelsStale } from "@/server/repo/panels";
import { enqueueAssistant } from "@/server/engine";
import { eventQueueKick } from "@/server/queue";
import { extractionSchema, suggestionSchema } from "@/server/validate";

/**
 * دستیار نویسنده/کارگردان.
 *
 * سه مسیر واقعی: استخراج نامزدهای جهان داستان، پیشنهاد ویرایش جمله‌ها و
 * یادداشت کارگردانی. هیچ‌کدام خودکار چیزی را تغییر نمی‌دهند:
 *  - استخراج فقط «پیشنهادی» ثبت می‌کند و هرگز وارد مرجع قطعی نمی‌شود.
 *  - پیشنهاد ویرایش فقط با تأیید صریح و روی همان نسخهٔ متنی اعمال می‌شود که
 *    پیشنهاد از آن ساخته شده است.
 *  - یادداشت کارگردانی فقط خواندنی است.
 */

const postSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("run"), kind: z.enum(["extract", "suggest", "director"]) }),
  z.object({ action: z.literal("apply-extract"), requestId: z.string().min(1), acceptAll: z.boolean().default(true) }),
  z.object({
    action: z.literal("apply-suggest"),
    requestId: z.string().min(1),
    indices: z.array(z.number().int().min(0)).max(50),
  }),
]);

function requireRequestForScene(projectId: string, sceneId: string, requestId: string) {
  const request = getRequest(requestId);
  if (!request) throw new AppError("درخواست پیدا نشد.", 404, "request_missing");
  if (request.projectId !== projectId) throw new AppError("درخواست به این پروژه تعلق ندارد.", 404, "cross_project_access");
  const requestSceneId = String((request.inputs as Record<string, unknown>).sceneId ?? "");
  if (requestSceneId !== sceneId) {
    throw new AppError("این نتیجه برای صحنهٔ دیگری ساخته شده است.", 409, "source_scene_mismatch");
  }
  if (request.status !== "succeeded") {
    throw new AppError("این درخواست هنوز نتیجهٔ موفق ندارد.", 409, "request_not_ready", "وضعیت درخواست را در فهرست کارها ببینید.");
  }
  return request;
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const scene = getScene(id);
    if (!scene) throw new AppError("صحنه پیدا نشد.", 404, "scene_missing");
    const url = new URL(req.url);
    const requestId = url.searchParams.get("requestId");
    if (!requestId) return json({ result: null });
    const request = requireRequestForScene(scene.projectId, id, requestId);
    return json({
      result: {
        requestId: request.id,
        role: request.role,
        status: request.status,
        model: request.model,
        provider: request.provider,
        parsed: request.parsed,
        note: (request.inputs as Record<string, unknown>).textHash === sha256(scene.text) ? "" : "متن صحنه پس از این نتیجه تغییر کرده است.",
        sourceHash: (request.inputs as Record<string, unknown>).textHash ?? null,
        currentHash: sha256(scene.text),
      },
    });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guard(req);
    const { id } = await ctx.params;
    const scene = getScene(id);
    if (!scene) throw new AppError("صحنه پیدا نشد.", 404, "scene_missing");
    const input = await body(req, postSchema);

    if (input.action === "run") {
      const result = enqueueAssistant(scene.projectId, id, input.kind);
      eventQueueKick();
      return json(
        {
          job: result.job,
          requestId: result.requestId,
          note:
            input.kind === "extract"
              ? "استخراج در پس‌زمینه اجرا می‌شود؛ نتیجه پیش از ثبت، پیشنهادی است."
              : input.kind === "suggest"
                ? "پیشنهادهای ویرایش در پس‌زمینه ساخته می‌شوند؛ متن اصلی تا تأیید شما تغییر نمی‌کند."
                : "یادداشت کارگردانی در پس‌زمینه ساخته می‌شود.",
        },
        { status: 202 },
      );
    }

    if (input.action === "apply-extract") {
      const request = requireRequestForScene(scene.projectId, id, input.requestId);
      const parsed = extractionSchema.safeParse(request.parsed);
      if (!parsed.success) throw new AppError("نتیجهٔ استخراج ساختار معتبر ندارد.", 400, "invalid_result");
      const existing = listEntities(scene.projectId);
      let createdEntities = 0;
      let createdFacts = 0;
      const subjectIdFor = (name: string, kind: "character" | "location" | "object") => {
        const found = existing.find((e) => e.name === name && e.kind === kind);
        if (found) return found.id;
        const entity = createEntity({
          projectId: scene.projectId,
          kind,
          name,
          summary: "",
          details: { source: "ai_extraction", requestId: request.id, status: "proposed" },
        });
        existing.push(entity);
        createdEntities += 1;
        return entity.id;
      };
      const groups: Array<["character" | "location" | "object", Array<{ name: string; description: string; evidence: string }>]> = [
        ["character", parsed.data.characters],
        ["location", parsed.data.locations],
        ["object", parsed.data.objects],
      ];
      for (const [kind, items] of groups) {
        for (const item of items) {
          const subjectId = subjectIdFor(item.name, kind);
          createFact({
            projectId: scene.projectId,
            subjectType: "entity",
            subjectId,
            attribute: kind === "character" ? "توضیح" : "شرح",
            value: item.description || item.evidence || item.name,
            sourceType: "ai_extraction",
            sourceRef: request.id,
            // پیشنهاد AI تنها با تأیید کاربر وارد مرجع قطعی می‌شود.
            status: "proposed",
            createdBy: "assistant",
          });
          createdFacts += 1;
        }
      }
      for (const fact of parsed.data.facts) {
        const subject = existing.find((e) => e.name === fact.subjectName);
        createFact({
          projectId: scene.projectId,
          subjectType: subject ? "entity" : "project",
          subjectId: subject?.id ?? "",
          attribute: fact.attribute,
          value: fact.value,
          sourceType: "ai_extraction",
          sourceRef: request.id,
          status: "proposed",
          createdBy: "assistant",
        });
        createdFacts += 1;
      }
      return json({
        createdEntities,
        createdFacts,
        note: "همهٔ موارد به‌صورت «پیشنهادی» ثبت شدند و تا تأیید شما در مرجع قطعی نیستند.",
      });
    }

    if (input.action === "apply-suggest") {
      const request = requireRequestForScene(scene.projectId, id, input.requestId);
      const parsed = suggestionSchema.safeParse(request.parsed);
      if (!parsed.success) throw new AppError("نتیجهٔ ویرایش ساختار معتبر ندارد.", 400, "invalid_result");
      const sourceHash = String((request.inputs as Record<string, unknown>).textHash ?? "");
      if (sourceHash && sourceHash !== sha256(scene.text)) {
        throw new AppError(
          "متن صحنه پس از ساخت این پیشنهادها تغییر کرده است.",
          409,
          "source_changed",
          "برای جلوگیری از بازنویسی نوشته‌های تازه، پیشنهادها را دوباره بگیرید.",
        );
      }
      const picked = input.indices
        .map((index) => parsed.data.suggestions[index])
        .filter((item): item is { original: string; replacement: string; reason: string } => Boolean(item));
      if (picked.length === 0) throw new AppError("هیچ پیشنهادی انتخاب نشده است.", 400, "nothing_selected");
      let next = scene.text;
      const missing: string[] = [];
      for (const item of picked) {
        if (!next.includes(item.original)) {
          missing.push(item.original.slice(0, 60));
          continue;
        }
        next = next.replace(item.original, item.replacement);
      }
      if (missing.length) {
        throw new AppError(
          `این جمله‌ها در متن فعلی پیدا نشد: ${missing.join(" · ")}`,
          409,
          "suggestion_stale",
          "پیشنهادهای قدیمی را کنار بگذارید و متن را دوباره بررسی کنید.",
        );
      }
      const saved = saveSceneText({ sceneId: id, text: next, reason: "ai", meta: { requestId: request.id, applied: picked.length } });
      markPanelsStale(id, "متن صحنه با پیشنهاد ویرایش تغییر کرد؛ بازبینی لازم است.");
      return json({
        scene: saved.scene,
        applied: picked.length,
        note: `${picked.length} پیشنهاد اعمال شد. نسخهٔ قبلی متن در تاریخچه مانده است.`,
      });
    }

    return json({ error: { message: "عملیات ناشناخته" } }, { status: 400 });
  } catch (error) {
    return fail(error);
  }
}
