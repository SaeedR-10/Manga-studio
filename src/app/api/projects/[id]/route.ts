import { body, fail, guard, json } from "@/server/http";
import { projectUpdateSchema } from "@/server/api-helpers";
import { deleteProject, listChapters, listScenes, requireProject, updateProject } from "@/server/repo/projects";
import { listEntities, listFacts, listStyles } from "@/server/repo/world";
import { listReferences } from "@/server/repo/refs";
import { listPanels } from "@/server/repo/panels";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const project = requireProject(id);
    return json({
      project,
      chapters: listChapters(id),
      scenes: listScenes(id),
      entities: listEntities(id),
      facts: listFacts(id),
      styles: listStyles(id),
      references: listReferences(id),
      panelCount: listPanels(id).length,
    });
  } catch (error) {
    return fail(error);
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guard(req);
    const { id } = await ctx.params;
    const patch = await body(req, projectUpdateSchema);
    return json({ project: updateProject(id, patch) });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guard(req);
    const { id } = await ctx.params;
    requireProject(id);
    deleteProject(id);
    return json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
