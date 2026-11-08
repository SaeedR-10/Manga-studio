import { z } from "zod";
import { body, fail, guard, json } from "@/server/http";
import { deleteReference, newReferenceVersion, requireReference, updateReference } from "@/server/repo/refs";
import { markPanelsForReferences } from "@/server/repo/panels";

const patchSchema = z.object({
  title: z.string().max(160).optional(),
  description: z.string().max(4000).optional(),
  licenseNote: z.string().max(2000).optional(),
  status: z.enum(["draft", "approved", "rejected", "archived"]).optional(),
  entityIds: z.array(z.string().max(80)).max(20).optional(),
  roles: z.array(z.string().max(40)).max(12).optional(),
  tags: z.array(z.string().max(60)).max(20).optional(),
});

const postSchema = z.object({ action: z.literal("new-version"), assetId: z.string().min(1) });

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guard(req);
    const { id } = await ctx.params;
    const existing = requireReference(id);
    const reference = updateReference(id, await body(req, patchSchema));
    /*
     * هر تغییر مؤثر در مجموعهٔ مراجع (تأیید، لغو تأیید، تغییر نقش یا اتصال به
     * موجودیت) پنل‌های وابسته را نیازمند بازبینی می‌کند؛ نه فقط تأیید نخست.
     */
    const material =
      existing.status !== reference.status ||
      existing.roles.join("|") !== reference.roles.join("|") ||
      existing.entityIds.join("|") !== reference.entityIds.join("|") ||
      existing.validFrom !== reference.validFrom ||
      existing.validTo !== reference.validTo;
    let panelsMarked = 0;
    if (material) {
      panelsMarked = markPanelsForReferences(
        reference.projectId,
        id,
        reference.entityIds,
        `مرجع «${reference.title}» تغییر کرد (${reference.status})؛ بازبینی لازم است.`,
      );
    }
    return json({ reference, panelsMarked });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guard(req);
    const { id } = await ctx.params;
    const input = await body(req, postSchema);
    // نسخهٔ تازه به‌صورت «پیش‌نویس» ساخته می‌شود؛ نسخهٔ تأییدشده جایگزین نمی‌شود.
    return json({ reference: newReferenceVersion(id, input.assetId) }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guard(req);
    const { id } = await ctx.params;
    requireReference(id);
    deleteReference(id);
    return json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
