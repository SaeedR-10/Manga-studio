import { z } from "zod";
import { body, fail, guard, json } from "@/server/http";
import { saveImage, setThumbKey } from "@/server/storage";
import { createReference, listReferences } from "@/server/repo/refs";
import { markPanelsForReferences } from "@/server/repo/panels";

const schema = z.object({
  dataUrl: z.string().min(32),
  thumbDataUrl: z.string().optional(),
  filename: z.string().min(1).max(200),
  title: z.string().min(1).max(160),
  description: z.string().max(4000).optional(),
  licenseNote: z.string().max(2000).optional(),
  entityIds: z.array(z.string().max(80)).max(20).default([]),
  roles: z.array(z.string().max(40)).max(12).default([]),
  tags: z.array(z.string().max(60)).max(20).default([]),
  origin: z.enum(["local_upload", "ai_output", "imported"]).default("local_upload"),
  status: z.enum(["draft", "approved"]).default("draft"),
});

function decode(dataUrl: string): Buffer {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) throw new Error("دادهٔ تصویر نامعتبر است.");
  return Buffer.from(match[2], "base64");
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    return json({ references: listReferences(id) });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guard(req);
    const { id } = await ctx.params;
    const input = await body(req, schema);
    const buffer = decode(input.dataUrl);
    const asset = saveImage({ buffer, filename: input.filename, kind: "reference" });
    if (input.thumbDataUrl) {
      try {
        const thumb = saveImage({ buffer: decode(input.thumbDataUrl), filename: `${input.filename}.thumb.webp`, mime: "image/webp", kind: "thumb" });
        setThumbKey(asset.id, thumb.storageKey);
      } catch {
        // بندانگشتی اختیاری است؛ اصل فایل حفظ می‌شود.
      }
    }
    const reference = createReference({
      projectId: id,
      assetId: asset.id,
      title: input.title,
      description: input.description,
      licenseNote: input.licenseNote,
      origin: input.origin,
      entityIds: input.entityIds,
      roles: input.roles,
      tags: input.tags,
      status: input.status,
    });
    const panelsMarked =
      input.status === "approved"
        ? markPanelsForReferences(
            id,
            reference.id,
            input.entityIds,
            "مرجع تأییدشدهٔ موجودیت‌های این پنل اضافه شد؛ بازبینی لازم است.",
          )
        : 0;
    return json({ reference, asset, panelsMarked }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
