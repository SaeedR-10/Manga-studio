import { fail, json } from "@/server/http";
import { listJobs } from "@/server/repo/jobs";
import { listRequests, listTakes } from "@/server/repo/ai";
import { queueState } from "@/server/queue";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const jobs = listJobs(id);
    const requests = listRequests(id, 30);
    const takes = listTakes
      ? requests
          .filter((r) => r.role === "prompt_writer" && r.panelId)
          .slice(0, 12)
          .map((r) => ({ requestId: r.id, takes: listTakes(r.panelId!) }))
      : [];
    return json({ jobs, requests, takesByRequest: takes, queue: queueState() });
  } catch (error) {
    return fail(error);
  }
}
