import { z } from "zod";
import { body, fail, guard, json } from "@/server/http";
import {
  exportMarkdown,
  exportPackage,
  exportPagePng,
  exportPanelPng,
  exportPanelScript,
  exportPdfFromPages,
  listExports,
} from "@/server/export";

const schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("markdown") }),
  z.object({ kind: z.literal("script") }),
  z.object({ kind: z.literal("package") }),
  z.object({ kind: z.literal("panel"), panelId: z.string().min(1), dataUrl: z.string().min(64) }),
  z.object({ kind: z.literal("page"), pageIndex: z.number().int().min(0), dataUrl: z.string().min(64) }),
  z.object({
    kind: z.literal("pdf"),
    pages: z
      .array(z.object({ base64: z.string().min(64), width: z.number().min(1), height: z.number().min(1) }))
      .min(1)
      .max(60),
  }),
]);

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    return json({ exports: listExports(id) });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guard(req);
    const { id } = await ctx.params;
    const input = await body(req, schema);
    if (input.kind === "markdown") return json({ export: exportMarkdown(id) }, { status: 201 });
    if (input.kind === "script") return json({ export: exportPanelScript(id) }, { status: 201 });
    if (input.kind === "package") return json({ export: await exportPackage(id) }, { status: 201 });
    if (input.kind === "panel") return json({ export: exportPanelPng(id, input.panelId, input.dataUrl) }, { status: 201 });
    if (input.kind === "page") return json({ export: exportPagePng(id, input.pageIndex, input.dataUrl) }, { status: 201 });
    return json({ export: await exportPdfFromPages(id, input.pages) }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
