import { z } from "zod";
import { body, fail, guard, json } from "@/server/http";
import { createChapter, listChapters } from "@/server/repo/projects";

const schema = z.object({ title: z.string().max(160).default("") });

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    return json({ chapters: listChapters(id) });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guard(req);
    const { id } = await ctx.params;
    const input = await body(req, schema);
    return json({ chapter: createChapter(id, input.title) }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
