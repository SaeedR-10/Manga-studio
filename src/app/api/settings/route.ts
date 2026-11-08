import { z } from "zod";
import { body, fail, guard, guardRead, json } from "@/server/http";
import { getAllSettings, setSetting } from "@/server/db";
import { CATALOG_VERIFIED_AT, DEFAULT_MODELS, MODELS, findModel, allModels } from "@/server/models";
import { providerSummaries } from "@/server/providers";
import { hasApiKey, secretStoreStatus } from "@/server/secrets";

const patchSchema = z.object({
  text: z.object({ provider: z.string().max(40), model: z.string().max(120) }).partial().optional(),
  image: z.object({ provider: z.string().max(40), model: z.string().max(120) }).partial().optional(),
  uiDirection: z.enum(["rtl", "ltr"]).optional(),
  textDirection: z.enum(["rtl", "ltr"]).optional(),
  panelOrder: z.enum(["rtl", "ltr"]).optional(),
});

const DEFAULTS = {
  textProvider: "openai",
  textModel: DEFAULT_MODELS.text.openai,
  imageProvider: "openai",
  imageModel: DEFAULT_MODELS.image.openai,
  uiDirection: "rtl",
  textDirection: "rtl",
  panelOrder: "rtl",
};

export async function GET(req: Request) {
  try {
    guardRead(req);
    const stored = getAllSettings();
    const settings = { ...DEFAULTS, ...stored };
    return json({
      settings,
      providers: providerSummaries(),
      models: allModels(),
      catalogVerifiedAt: CATALOG_VERIFIED_AT,
      secrets: secretStoreStatus(),
      keys: { openai: hasApiKey("openai"), google: hasApiKey("google") },
      appVersion: process.env.RAVAYAT_DESKTOP_VERSION || "0.1.0",
      dataDir: process.env.RAVAYAT_DATA_DIR || null,
    });
  } catch (error) {
    return fail(error);
  }
}

export async function PATCH(req: Request) {
  try {
    guard(req);
    const input = await body(req, patchSchema);
    const current = { ...DEFAULTS, ...getAllSettings() };
    const next = {
      textProvider: input.text?.provider ?? current.textProvider,
      textModel: input.text?.model ?? current.textModel,
      imageProvider: input.image?.provider ?? current.imageProvider,
      imageModel: input.image?.model ?? current.imageModel,
      uiDirection: input.uiDirection ?? current.uiDirection,
      textDirection: input.textDirection ?? current.textDirection,
      panelOrder: input.panelOrder ?? current.panelOrder,
    };
    const textModel = findModel(next.textProvider, next.textModel);
    if (!textModel || textModel.kind !== "text") {
      return json({ error: { message: "مدل متنی انتخاب‌شده در کاتالوگ نیست.", code: "unknown_model" } }, { status: 400 });
    }
    const imageModel = findModel(next.imageProvider, next.imageModel);
    if (!imageModel || imageModel.kind !== "image") {
      return json({ error: { message: "مدل تصویر انتخاب‌شده در کاتالوگ نیست.", code: "unknown_model" } }, { status: 400 });
    }
    for (const [key, value] of Object.entries(next)) setSetting(key, String(value));
    return json({ settings: next });
  } catch (error) {
    return fail(error);
  }
}
