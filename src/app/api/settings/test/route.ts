import { z } from "zod";
import { body, fail, guard, json } from "@/server/http";
import { estimateImageCost, findModel } from "@/server/models";
import { getProvider } from "@/server/providers";
import { getApiKey } from "@/server/secrets";
import { AppError } from "@/server/http";

const schema = z.object({
  provider: z.enum(["openai", "google"]),
  kind: z.enum(["text", "image"]).default("text"),
  model: z.string().min(1).max(120),
  confirmImageCost: z.boolean().default(false),
});

/**
 * آزمون اتصال.
 * آزمون متنی یک درخواست کوچک و ارزان است. آزمون تصویری هزینه دارد، بنابراین
 * فقط با تأیید صریح کاربر و با نمایش برآورد اجرا می‌شود؛ پیش از آن برآورد
 * برگردانده می‌شود.
 */
export async function POST(req: Request) {
  try {
    guard(req);
    const input = await body(req, schema);
    const key = getApiKey(input.provider);
    if (!key) {
      return json(
        { error: { message: "کلید این ارائه‌دهنده تنظیم نشده است.", code: "no_key", hint: "در تنظیمات اتصال‌ها کلید را وارد کنید." } },
        { status: 400 },
      );
    }
    const model = findModel(input.provider, input.model);
    if (!model) throw new AppError("مدل در کاتالوگ نیست.", 400, "unknown_model");

    if (input.kind === "image") {
      const estimate = estimateImageCost(input.model, input.provider === "google" ? "1K" : "1024x1024");
      if (!input.confirmImageCost) {
        return json({
          needsConfirmation: true,
          estimate,
          message:
            "آزمون تصویری یک تصویر واقعی می‌سازد و ممکن است هزینه داشته باشد. برای اجرا، تأیید صریح لازم است.",
        });
      }
      const provider = getProvider(input.provider);
      const started = Date.now();
      const result = await provider.generateImage({
        model: input.model,
        prompt: "A simple gray square on white background, minimal, no text.",
        size: input.provider === "google" ? undefined : "1024x1024",
        imageSize: input.provider === "google" ? "1K" : undefined,
        aspectRatio: input.provider === "google" ? "1:1" : undefined,
        n: 1,
      }, key);
      return json({
        ok: true,
        kind: "image",
        latencyMs: Date.now() - started,
        images: result.images.length,
        estimate,
        note: "تصویر آزمون ذخیره نشد و به پنلی متصل نیست. هزینهٔ واقعی در صورتحساب ارائه‌دهنده دیده می‌شود.",
      });
    }

    const provider = getProvider(input.provider);
    const started = Date.now();
    const result = await provider.analyze({
      model: input.model,
      system: "You are a connection test. Reply with compact JSON only.",
      user: 'Return exactly {"ok":true} and nothing else.',
      maxOutputTokens: 32,
    }, key);
    return json({
      ok: true,
      kind: "text",
      latencyMs: Date.now() - started,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      sample: result.text.slice(0, 120),
      note: "این آزمون فقط اتصال و اعتبار کلید را می‌سنجد، نه کیفیت تولید.",
    });
  } catch (error) {
    return fail(error);
  }
}
