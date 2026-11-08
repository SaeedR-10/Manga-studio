import fs from "node:fs";
import { Readable } from "node:stream";
import { fail, guardRead } from "@/server/http";
import { exportFile } from "@/server/export";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guardRead(req);
    const { id } = await ctx.params;
    const file = exportFile(id);
    if (!fs.existsSync(file.abs)) {
      return Response.json({ error: { message: "فایل خروجی روی دیسک پیدا نشد." } }, { status: 404 });
    }
    const ascii = file.filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
    return new Response(Readable.toWeb(fs.createReadStream(file.abs)) as unknown as BodyInit, {
      headers: {
        "content-type": file.kind === "pdf" ? "application/pdf" : (file.kind === "package" || file.kind === "manual_handoff") ? "application/zip" : file.kind.includes("png") ? "image/png" : "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return fail(error);
  }
}
