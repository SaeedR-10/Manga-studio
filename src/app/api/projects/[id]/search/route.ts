import { fail, json } from "@/server/http";
import { searchProject } from "@/server/repo/projects";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const query = url.searchParams.get("q") ?? "";
    return json({ hits: searchProject(id, query), query });
  } catch (error) {
    return fail(error);
  }
}
