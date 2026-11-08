import { z } from "zod";
import { body, fail, guard, json } from "@/server/http";
import { cancelJob, getJob } from "@/server/repo/jobs";

const schema = z.object({ action: z.literal("cancel") });

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const job = getJob(id);
    if (!job) return json({ error: { message: "کار پیدا نشد." } }, { status: 404 });
    return json({ job });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guard(req);
    const { id } = await ctx.params;
    await body(req, schema);
    return json({ job: cancelJob(id), note: "لغو فقط محلی است؛ لغو پردازش سمت سرویس تضمین نمی‌شود." });
  } catch (error) {
    return fail(error);
  }
}
