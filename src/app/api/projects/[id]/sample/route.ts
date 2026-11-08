import { fail, guard, json } from "@/server/http";
import { requireProject } from "@/server/repo/projects";
import { createSampleProject } from "@/server/sample";

/** ساخت پروژهٔ نمونهٔ کامل مستقل از پروژهٔ فعلی؛ هیچ درخواست AI ارسال نمی‌شود. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guard(req);
    await ctx.params;
    const result = createSampleProject();
    return json({ ...result, note: "نمونه با تقسیم‌بندی محلی ساخته شد؛ هیچ درخواست پولی ارسال نشد." }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    requireProject(id);
    return json({ available: true });
  } catch (error) {
    return fail(error);
  }
}
