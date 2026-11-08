import { z } from "zod";
import { body, fail, guard, json } from "@/server/http";
import { produceSchema } from "@/server/api-helpers";
import { requirePanel, setPanelReferences, updatePanel } from "@/server/repo/panels";
import { acceptTake, decideIssue, rejectTake, takeCount } from "@/server/repo/ai";
import { enqueuePanelEdit, enqueuePanelImage, enqueueReview, planPanelProduction } from "@/server/engine";
import { eventQueueKick } from "@/server/queue";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("plan"), options: produceSchema.default({}) }),
  z.object({ action: z.literal("produce"), options: produceSchema.default({}) }),
  z.object({
    action: z.literal("produce-edit"),
    sourceTakeId: z.string().min(1),
    maskAssetId: z.string().min(1).nullable().optional(),
    editKind: z.enum(["inpaint", "refine"]).default("inpaint"),
    editInstruction: z.string().max(1000).optional(),
    options: produceSchema.default({}),
  }),
  z.object({ action: z.literal("review"), takeId: z.string().optional() }),
  z.object({ action: z.literal("accept-take"), takeId: z.string().min(1) }),
  z.object({ action: z.literal("reject-take"), takeId: z.string().min(1) }),
  z.object({ action: z.literal("decide-issue"), issueId: z.string().min(1), decision: z.enum(["accepted", "rejected", "intentional"]), note: z.string().max(1000).optional() }),
  z.object({ action: z.literal("pin-references"), referenceIds: z.array(z.string().max(80)).max(24) }),
  z.object({ action: z.literal("approve") }),
]);

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guard(req);
    const { id } = await ctx.params;
    const panel = requirePanel(id);
    const input = await body(req, schema);
    if (input.action === "plan") {
      return json({ plan: planPanelProduction(panel.projectId, id, input.options) });
    }
    if (input.action === "produce") {
      // کلیک دوباره همان ورودی، کار تکراری نمی‌سازد (کلید یکتای صف).
      const result = enqueuePanelImage(panel.projectId, id, input.options);
      eventQueueKick();
      return json(
        {
          job: result.job,
          requestId: result.requestId,
          plan: result.plan,
          used: takeCount(id),
          note: "درخواست در صف ثبت شد. اگر تکراری باشد، همان کار قبلی برگردانده می‌شود.",
        },
        { status: 202 },
      );
    }
    if (input.action === "produce-edit") {
      // اصلاح ناحیه‌ای: خروجی مبدأ و ماسک ثبت می‌شوند و اصل تصویر دست‌نخورده می‌ماند.
      const result = enqueuePanelEdit(panel.projectId, id, {
        ...input.options,
        sourceTakeId: input.sourceTakeId,
        maskAssetId: input.maskAssetId ?? null,
        editKind: input.editKind,
        editInstruction: input.editInstruction,
      });
      eventQueueKick();
      return json(
        {
          job: result.job,
          requestId: result.requestId,
          plan: result.plan,
          note: "درخواست اصلاح با خروجی مبدأ و ماسک ثبت شد؛ خروجی تازه به‌عنوان نامزد اضافه می‌شود.",
        },
        { status: 202 },
      );
    }
    if (input.action === "review") {
      const result = enqueueReview(panel.projectId, id, input.takeId);
      eventQueueKick();
      return json({ ...result, note: "بازبینی در پس‌زمینه اجرا می‌شود." }, { status: 202 });
    }
    if (input.action === "accept-take") {
      return json({ take: acceptTake(id, input.takeId) });
    }
    if (input.action === "reject-take") {
      rejectTake(input.takeId);
      return json({ ok: true });
    }
    if (input.action === "decide-issue") {
      decideIssue(input.issueId, input.decision, input.note ?? "");
      return json({ ok: true });
    }
    if (input.action === "pin-references") {
      return json({ panel: setPanelReferences(id, input.referenceIds) });
    }
    return json({ panel: updatePanel(id, { status: "approved", needsReview: false, reviewReason: "" }, "approve") });
  } catch (error) {
    return fail(error);
  }
}
