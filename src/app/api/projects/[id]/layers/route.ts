import { z } from "zod";
import { body, fail, guard, json } from "@/server/http";
import { createTextLayer, ensureDoc, textLayers } from "@/server/repo/layout";

const schema = z.object({
  panelId: z.string().nullable().optional(),
  kind: z.enum(["dialogue", "narration", "thought", "sfx", "caption"]),
  speaker: z.string().max(120).optional(),
  body: z.string().min(1).max(4000),
  x: z.number().min(0).max(1).optional(),
  y: z.number().min(0).max(1).optional(),
  w: z.number().min(0.02).max(1).optional(),
  h: z.number().min(0.02).max(1).optional(),
  fontSize: z.number().min(8).max(120).optional(),
  direction: z.enum(["rtl", "ltr"]).optional(),
  tail: z.string().max(20).optional(),
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const doc = ensureDoc(id);
    return json({ layers: textLayers(doc.id) });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guard(req);
    const { id } = await ctx.params;
    const doc = ensureDoc(id);
    const input = await body(req, schema);
    return json({ layer: createTextLayer(doc.id, input) }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
