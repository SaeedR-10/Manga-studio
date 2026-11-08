import { z } from "zod";
import { body, fail, guard, json } from "@/server/http";
import { deleteFact, getFact, setFactStatus, updateFact } from "@/server/repo/world";
import { markPanelsForEntities } from "@/server/repo/panels";

const patchSchema = z.object({
  status: z.enum(["proposed", "confirmed", "rejected", "retired"]).optional(),
  value: z.string().max(4000).optional(),
  attribute: z.string().max(120).optional(),
  scopeStart: z.string().max(40).nullable().optional(),
  scopeEnd: z.string().max(40).nullable().optional(),
  resolutionNote: z.string().max(1000).optional(),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guard(req);
    const { id } = await ctx.params;
    const input = await body(req, patchSchema);
    const existing = getFact(id);
    let fact;
    if (input.status) {
      // پیشنهاد AI فقط با اقدام صریح کاربر به مرجع قطعی می‌رود.
      fact = setFactStatus(id, input.status, input.resolutionNote ?? "");
    } else {
      fact = updateFact(id, input);
    }
    /*
     * تغییر وضعیت یا مقدار یک واقعیت، مجموعهٔ مرجع قطعی را عوض می‌کند؛ پنل‌هایی که
     * به آن موجودیت وابسته‌اند باید صریحاً «نیازمند بازبینی» شوند. هیچ تولیدی
     * خودکار آغاز نمی‌شود.
     */
    const material =
      !existing ||
      existing.status !== fact.status ||
      existing.value !== fact.value ||
      existing.scopeStart !== fact.scopeStart ||
      existing.scopeEnd !== fact.scopeEnd;
    if (material && fact.subjectType === "entity" && fact.subjectId) {
      markPanelsForEntities(fact.projectId, [fact.subjectId], `واقعیت قطعی «${fact.attribute}» تغییر کرد؛ بازبینی لازم است.`);
    }
    return json({ fact });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guard(req);
    const { id } = await ctx.params;
    if (!getFact(id)) return json({ error: { message: "واقعیت پیدا نشد." } }, { status: 404 });
    deleteFact(id);
    return json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
