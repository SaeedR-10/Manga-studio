import { z } from "zod";
import { AppError, body, fail, guard, json } from "@/server/http";
import { entityVersionSchema } from "@/server/api-helpers";
import { markPanelsForEntities } from "@/server/repo/panels";
import {
  addEntityVersion,
  approveEntityVersion,
  deleteEntity,
  deleteEntityVersion,
  entityDependencies,
  getEntity,
  listEntityVersions,
  updateEntity,
  versionsAt,
} from "@/server/repo/world";

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  summary: z.string().max(4000).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const postSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("version"), version: entityVersionSchema }),
  z.object({ action: z.literal("approve"), versionId: z.string().min(1) }),
  z.object({ action: z.literal("delete-version"), versionId: z.string().min(1) }),
]);

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const entity = getEntity(id);
    if (!entity) return json({ error: { message: "موجودیت پیدا نشد." } }, { status: 404 });
    const url = new URL(req.url);
    const at = url.searchParams.get("at");
    return json({
      entity,
      versions: listEntityVersions(id),
      at: at ? versionsAt(id, at) : null,
      dependencies: entityDependencies(id),
    });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guard(req);
    const { id } = await ctx.params;
    const input = await body(req, postSchema);
    const entity = getEntity(id);
    if (!entity) throw new AppError("موجودیت پیدا نشد.", 404, "entity_missing");
    if (input.action === "version") {
      const version = addEntityVersion({
        entityId: id,
        label: input.version.label,
        layer: input.version.layer,
        payload: input.version.payload,
        fixedTraits: input.version.fixedTraits,
        validFrom: input.version.validFrom ?? null,
        validTo: input.version.validTo ?? null,
        notes: input.version.notes,
        approved: input.version.approved,
      });
      if (version.approvedAt) {
        markPanelsForEntities(entity.projectId, [id], `نسخهٔ تأییدشدهٔ «${entity.name}» تغییر کرد؛ بازبینی لازم است.`);
      }
      return json({ version }, { status: 201 });
    }
    if (input.action === "approve") {
      const version = approveEntityVersion(input.versionId);
      markPanelsForEntities(entity.projectId, [id], `نسخهٔ هویت/لباس «${entity.name}» تأیید شد؛ بازبینی لازم است.`);
      return json({ version });
    }
    if (input.action === "delete-version") {
      deleteEntityVersion(input.versionId);
      markPanelsForEntities(entity.projectId, [id], `نسخه‌ای از «${entity.name}» حذف شد؛ بازبینی لازم است.`);
      return json({ ok: true });
    }
    return json({ error: { message: "عملیات ناشناخته" } }, { status: 400 });
  } catch (error) {
    return fail(error);
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guard(req);
    const { id } = await ctx.params;
    return json({ entity: updateEntity(id, await body(req, patchSchema)) });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guard(req);
    const { id } = await ctx.params;
    deleteEntity(id);
    return json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
