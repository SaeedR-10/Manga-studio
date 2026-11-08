import { z } from "zod";
import { body, fail, guard, json } from "@/server/http";
import { layoutUpdateSchema } from "@/server/api-helpers";
import { autoLayout, ensureDoc, placementsFor, replacePlacements, textLayers, updateDoc } from "@/server/repo/layout";
import { listPanels } from "@/server/repo/panels";
import { requireProject } from "@/server/repo/projects";

const postSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("auto-layout"), panelIds: z.array(z.string()).max(400).optional() }),
  z.object({
    action: z.literal("placements"),
    items: z
      .array(
        z.object({
          panelId: z.string().min(1),
          pageIndex: z.number().int().min(0).max(500),
          x: z.number(),
          y: z.number(),
          w: z.number().min(40),
          h: z.number().min(40),
          readingIndex: z.number().int().min(0),
        }),
      )
      .max(400),
  }),
]);

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    requireProject(id);
    const doc = ensureDoc(id);
    return json({ doc, placements: placementsFor(doc.id), layers: textLayers(doc.id), panels: listPanels(id) });
  } catch (error) {
    return fail(error);
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guard(req);
    const { id } = await ctx.params;
    const doc = ensureDoc(id);
    const updated = updateDoc(doc.id, await body(req, layoutUpdateSchema));
    return json({ doc: updated, placements: placementsFor(updated.id), layers: textLayers(updated.id) });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guard(req);
    const { id } = await ctx.params;
    const input = await body(req, postSchema);
    const doc = ensureDoc(id);
    if (input.action === "auto-layout") {
      const panelIds = input.panelIds?.length ? input.panelIds : listPanels(id).map((p) => p.id);
      return json({ placements: autoLayout(doc.id, panelIds) });
    }
    return json({ placements: replacePlacements(doc.id, input.items) });
  } catch (error) {
    return fail(error);
  }
}
