import { body, fail, guard, json } from "@/server/http";
import { projectCreateSchema } from "@/server/api-helpers";
import { createProject, listProjectSummaries } from "@/server/repo/projects";

export async function GET() {
  try {
    return json({ projects: listProjectSummaries() });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: Request) {
  try {
    guard(req);
    const input = await body(req, projectCreateSchema);
    const project = createProject(input);
    return json({ project }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
