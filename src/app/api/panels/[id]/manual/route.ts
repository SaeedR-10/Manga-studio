import { z } from "zod";
import { body, fail, guard, json } from "@/server/http";
import { importManualImage, prepareManualImages } from "@/server/manual-images";
import { produceSchema } from "@/server/api-helpers";
export const runtime = "nodejs";
const schema = z.discriminatedUnion("action", [z.object({ action: z.literal("prepare"), options: produceSchema.optional() }), z.object({ action: z.literal("import"), handoffId: z.string().min(1), filename: z.string().max(180), dataUrl: z.string().max(30_000_000), acknowledgeChanged: z.boolean().default(false) })]);
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guard(req); const { id } = await ctx.params; const input = await body(req, schema);
    if (input.action === "prepare") return json(await prepareManualImages(id, input.options));
    const parsed = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(input.dataUrl);
    if (!parsed) return json({ error: { message: "فقط تصویر PNG، JPEG یا WebP وارد کنید." } }, { status: 400 });
    return json(importManualImage(id, input.handoffId, Buffer.from(parsed[1], "base64"), input.filename, input.acknowledgeChanged));
  } catch (e) { return fail(e); }
}
