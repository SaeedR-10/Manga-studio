import { z } from "zod";
import { AppError, body, fail, guard, json } from "@/server/http";
import { requirePanel } from "@/server/repo/panels";
import { getAsset, saveImage } from "@/server/storage";
import { row } from "@/server/db";

/**
 * بارگذاری ماسک اصلاح ناحیه‌ای.
 *
 * ماسک باید PNG/WebP و هم‌اندازهٔ خروجی مبدأ باشد؛ در غیر این صورت اصلاح
 * رد می‌شود. این فایل به خروجی اصلی دست نمی‌زند.
 */

const schema = z.object({
  dataUrl: z.string().min(32),
  filename: z.string().min(1).max(200).default("mask.png"),
  sourceTakeId: z.string().min(1),
});

function decode(dataUrl: string): { buffer: Buffer; mime: string } {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) throw new AppError("دادهٔ تصویر نامعتبر است.", 400, "invalid_image_data");
  return { buffer: Buffer.from(match[2], "base64"), mime: match[1] };
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guard(req);
    const { id } = await ctx.params;
    const panel = requirePanel(id);
    const input = await body(req, schema);
    const decoded = decode(input.dataUrl);
    const take = row("SELECT * FROM image_takes WHERE id = ? AND panel_id = ?", input.sourceTakeId, id);
    if (!take) throw new AppError("خروجی مبدأ پیدا نشد.", 404, "take_missing");
    const source = getAsset(String(take.asset_id));
    if (!source) throw new AppError("فایل خروجی مبدأ پیدا نشد.", 404, "asset_missing");
    if (!["image/png", "image/webp"].includes(decoded.mime)) {
      throw new AppError("ماسک باید PNG یا WebP باشد.", 400, "invalid_mask", "JPEG شفافیت ندارد و به‌عنوان ماسک پذیرفته نمی‌شود.");
    }
    const asset = saveImage({ buffer: decoded.buffer, filename: input.filename, mime: decoded.mime, kind: "reference" });
    if (source.width && source.height && asset.width && asset.height) {
      if (source.width !== asset.width || source.height !== asset.height) {
        throw new AppError(
          `ابعاد ماسک (${asset.width}×${asset.height}) با خروجی مبدأ (${source.width}×${source.height}) یکسان نیست.`,
          400,
          "mask_size_mismatch",
          "ماسک را با همان ابعاد تصویر مبدأ ذخیره کنید.",
        );
      }
    }
    return json({ asset: { id: asset.id, width: asset.width, height: asset.height, mime: asset.mime }, panelId: panel.id }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
