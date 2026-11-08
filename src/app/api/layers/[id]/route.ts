import { z } from "zod";
import { body, fail, guard, json } from "@/server/http";
import { deleteTextLayer, updateTextLayer } from "@/server/repo/layout";

const patchSchema = z.object({
  body: z.string().max(4000).optional(),
  speaker: z.string().max(120).optional(),
  kind: z.enum(["dialogue", "narration", "thought", "sfx", "caption"]).optional(),
  x: z.number().min(0).max(1).optional(),
  y: z.number().min(0).max(1).optional(),
  w: z.number().min(0.02).max(1).optional(),
  h: z.number().min(0.02).max(1).optional(),
  fontSize: z.number().min(8).max(120).optional(),
  direction: z.enum(["rtl", "ltr"]).optional(),
  tail: z.string().max(20).optional(),
  z: z.number().min(0).max(999).optional(),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guard(req);
    const { id } = await ctx.params;
    return json({ layer: updateTextLayer(id, await body(req, patchSchema)) });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guard(req);
    const { id } = await ctx.params;
    deleteTextLayer(id);
    return json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
