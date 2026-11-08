import { z } from "zod";
import { body, fail, guard, guardRead, json } from "@/server/http";
import { deleteStoredDraft, readStoredDraft, writeStoredDraft } from "@/server/drafts";

const putSchema = z.object({
  text: z.string().max(2_000_000),
  baseText: z.string().max(2_000_000).default(""),
  baseUpdatedAt: z.string().max(80).nullable().default(null),
  savedAt: z.string().max(80).optional(),
  error: z.string().max(2000).nullable().optional(),
});

export async function GET(req: Request, ctx: { params: Promise<{ sceneId: string }> }) {
  try {
    guardRead(req);
    const { sceneId } = await ctx.params;
    return json({ draft: readStoredDraft(sceneId) });
  } catch (error) {
    return fail(error);
  }
}

export async function PUT(req: Request, ctx: { params: Promise<{ sceneId: string }> }) {
  try {
    guard(req);
    const { sceneId } = await ctx.params;
    const input = await body(req, putSchema);
    const draft = writeStoredDraft({ sceneId, ...input });
    return json({ draft });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ sceneId: string }> }) {
  try {
    guard(req);
    const { sceneId } = await ctx.params;
    deleteStoredDraft(sceneId);
    return json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
