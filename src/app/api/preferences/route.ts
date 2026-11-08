import { z } from "zod";
import { body, fail, guard, guardRead, json } from "@/server/http";
import { readPreferences, writePreferences } from "@/server/preferences";

const patchSchema = z.object({
  language: z.enum(["fa", "en"]).optional(),
  theme: z.enum(["system", "light", "dark"]).optional(),
  navCollapsed: z.boolean().optional(),
  navWidth: z.number().optional(),
  inspectorWidth: z.number().optional(),
  editorFontSize: z.number().optional(),
  editorLineHeight: z.number().optional(),
  readingWidth: z.number().optional(),
});

export async function GET(req: Request) {
  try {
    guardRead(req);
    return json({ preferences: readPreferences() });
  } catch (error) {
    return fail(error);
  }
}

export async function PUT(req: Request) {
  try {
    guard(req);
    const patch = await body(req, patchSchema);
    return json({ preferences: writePreferences(patch) });
  } catch (error) {
    return fail(error);
  }
}
