import { z } from "zod";
import { body, fail, guard, json } from "@/server/http";
import { createScene, listScenes } from "@/server/repo/projects";

const schema = z.object({
  chapterId: z.string().min(1),
  title: z.string().max(200).default(""),
  text: z.string().max(200_000).optional(),
  isFlashback: z.boolean().optional(),
  storyDate: z.string().max(40).nullable().optional(),
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    return json({ scenes: listScenes(id) });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guard(req);
    await ctx.params;
    const input = await body(req, schema);
    return json({ scene: createScene(input) }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
