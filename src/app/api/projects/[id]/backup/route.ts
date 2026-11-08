import { fail, guard, json } from "@/server/http";
import { backupSnapshot, listBackups, createProjectPackage } from "@/server/backup";
import { requireProject } from "@/server/repo/projects";

/** پشتیبان SQLite یکپارچه (VACUUM INTO) در پوشهٔ backups. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    requireProject(id);
    return json({ backups: listBackups(id) });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guard(req);
    const { id } = await ctx.params;
    requireProject(id);
    const result = backupSnapshot(id, "پشتیبان دستی");
    const pkg = await createProjectPackage(id);
    return json(
      {
        backup: result,
        packageBytes: pkg.buffer.byteLength,
        note: "پشتیبان پایگاه داده ذخیره شد؛ برای انتقال کامل پروژه از خروجی «بستهٔ پروژه» استفاده کنید.",
      },
      { status: 201 },
    );
  } catch (error) {
    return fail(error);
  }
}
