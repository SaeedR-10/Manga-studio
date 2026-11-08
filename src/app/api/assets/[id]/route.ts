import { fail } from "@/server/http";
import { getAsset, assetResponse } from "@/server/storage";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const asset = getAsset(id);
    if (!asset) return Response.json({ error: { message: "تصویر پیدا نشد." } }, { status: 404 });
    const url = new URL(req.url);
    const variant = url.searchParams.get("variant") === "thumb" ? "thumb" : "full";
    // variant در assetResponse از thumbKey استفاده می‌کند؛ برای سادگی مسیر را دستی انتخاب می‌کنیم
    if (variant === "thumb" && asset.thumbKey) {
      const { assetPath } = await import("@/server/storage");
      const fs = await import("node:fs");
      const abs = assetPath(asset, "thumb");
      if (!fs.existsSync(abs)) return assetResponse(asset, req);
      const data = fs.readFileSync(abs);
      return new Response(new Uint8Array(data), {
        headers: {
          "content-type": "image/webp",
          "cache-control": "private, max-age=31536000, immutable",
        },
      });
    }
    return assetResponse(asset, req);
  } catch (error) {
    return fail(error);
  }
}
