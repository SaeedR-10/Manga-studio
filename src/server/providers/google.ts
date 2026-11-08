import {
  Provider,
  ProviderCapabilities,
  ImageRequest,
  ImageResult,
  TextRequest,
  TextResult,
  ProviderError,
  classifyHttpError,
  errorMessage,
  fetchWithTimeout,
  readJsonResponse,
} from "./types";

/**
 * اتصال Google Gemini.
 *
 * بر پایهٔ مستندات رسمی بازبینی‌شده در ۲۰۲۶-۱۰-۳۰:
 *  - تحلیل متن/تصویر: POST /v1beta/models/{model}:generateContent
 *    (تصاویر با inline_data، JSON با responseMimeType)
 *  - تولید و ویرایش تصویر: POST /v1beta/interactions
 *    با response_format { type:"image", aspect_ratio, image_size } و
 *    حداکثر ۱۴ تصویر مرجع. ماسک/seed پشتیبانی مستند ندارد و ادعا نمی‌شود.
 *
 * شناسهٔ مدل از کاتالوگ می‌آید؛ در این فایل مدلی هارد‌کد نیست.
 */

const BASE = () => (process.env.RAVAYAT_GOOGLE_BASE_URL || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");

const CAPABILITIES: ProviderCapabilities = {
  text: true,
  vision: true,
  imageGeneration: true,
  imageEdit: true,
  maxReferenceImages: 14,
  mask: false,
  transparent: false,
  seed: false,
  structuredJson: "prompt_only",
};

function headers(apiKey: string): Record<string, string> {
  return { "x-goog-api-key": apiKey, "content-type": "application/json" };
}

export const googleProvider: Provider = {
  id: "google",
  label: "Google Gemini",
  capabilities: () => CAPABILITIES,

  async analyze(req: TextRequest, apiKey: string): Promise<TextResult> {
    const parts: Array<Record<string, unknown>> = [{ text: req.user }];
    for (const image of req.images ?? []) {
      parts.push({ inline_data: { mime_type: image.mime, data: image.base64 } });
    }
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts }],
      generationConfig: {
        maxOutputTokens: req.maxOutputTokens ?? 2048,
        ...(req.jsonSchema ? { responseMimeType: "application/json" } : {}),
      },
    };

    const send = async () => {
      const res = await fetchWithTimeout(
        `${BASE()}/models/${encodeURIComponent(req.model)}:generateContent`,
        { method: "POST", headers: headers(apiKey), body: JSON.stringify(body), signal: req.signal },
        180_000,
      );
      return { res, payload: await readJsonResponse(res) };
    };

    let { res, payload } = await send();
    if (!res.ok && req.jsonSchema && res.status === 400) {
      const raw = JSON.stringify(payload);
      if (/responseMimeType|generationConfig|Unknown name/i.test(raw)) {
        delete (body.generationConfig as Record<string, unknown>).responseMimeType;
        ({ res, payload } = await send());
      }
    }
    if (!res.ok) {
      const info = errorMessage(payload);
      throw classifyHttpError(res.status, info.message, info.code);
    }

    const data = payload as Record<string, unknown>;
    const feedback = (data.promptFeedback ?? {}) as Record<string, unknown>;
    if (feedback.blockReason) {
      throw new ProviderError(
        `درخواست به‌دلیل سیاست محتوا مسدود شد (${String(feedback.blockReason)}).`,
        res.status,
        "content_blocked",
        false,
        false,
        "متن یا تصویر ارسالی را بازبینی کنید.",
      );
    }
    const candidates = Array.isArray(data.candidates) ? (data.candidates as Array<Record<string, unknown>>) : [];
    const first = candidates[0];
    const content = (first?.content ?? {}) as Record<string, unknown>;
    const responseParts = Array.isArray(content.parts) ? (content.parts as Array<Record<string, unknown>>) : [];
    const text = responseParts
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("\n")
      .trim();
    if (!text) {
      const reason = first?.finishReason ? String(first.finishReason) : "پاسخ خالی";
      throw new ProviderError(`مدل متنی برنگرداند (${reason}).`, res.status, "empty_response", true, false);
    }
    const usage = (data.usageMetadata ?? {}) as Record<string, unknown>;
    return {
      text,
      tokensIn: numberOrNull(usage.promptTokenCount),
      tokensOut: numberOrNull(usage.candidatesTokenCount),
      providerRequestId: typeof data.responseId === "string" ? data.responseId : null,
      raw: data,
      reportedCostUsd: null,
    };
  },

  async generateImage(req: ImageRequest, apiKey: string): Promise<ImageResult> {
    const input: Array<Record<string, unknown>> = [{ type: "text", text: req.prompt }];
    for (const image of req.images ?? []) {
      input.push({ type: "image", mime_type: image.mime, data: image.base64 });
    }
    const body: Record<string, unknown> = {
      model: req.model,
      input,
      response_format: {
        type: "image",
        mime_type: req.outputFormat === "jpeg" ? "image/jpeg" : "image/png",
        ...(req.aspectRatio ? { aspect_ratio: req.aspectRatio } : {}),
        ...(req.imageSize ? { image_size: req.imageSize } : {}),
      },
    };
    const res = await fetchWithTimeout(
      `${BASE()}/interactions`,
      { method: "POST", headers: headers(apiKey), body: JSON.stringify(body) },
      300_000,
    );
    const payload = await readJsonResponse(res);
    if (!res.ok) {
      const info = errorMessage(payload);
      throw classifyHttpError(res.status, info.message, info.code);
    }
    const data = payload as Record<string, unknown>;
    const images = extractImages(data);
    if (images.length === 0) {
      const code = typeof (data.error as Record<string, unknown> | undefined)?.code === "string"
        ? String((data.error as Record<string, unknown>).code)
        : "no_image";
      throw new ProviderError(
        code === "no_image" ? "مدل نتوانست تصویری بسازد." : "سرویس تصویری برنگرداند.",
        res.status,
        code,
        code !== "no_image",
        false,
      );
    }
    return {
      images,
      providerRequestId: typeof data.id === "string" ? data.id : null,
      raw: data,
      reportedCostUsd: null,
      imageOutputTokens: null,
      seed: null,
    };
  },
};

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * استخراج تصویر از پاسخ Interactions. مستندات `output_image` را معرفی می‌کند؛
 * چون پاسخ می‌تواند چندمرحله‌ای باشد، در صورت نبود آن یک پیمایش محافظه‌کارانه
 * روی هر شیء دارای data و mime_type تصویری انجام می‌شود.
 */
function extractImages(data: Record<string, unknown>): Array<{ base64: string; mime: string }> {
  const out: Array<{ base64: string; mime: string }> = [];
  const direct = data.output_image as Record<string, unknown> | undefined;
  if (direct && typeof direct.data === "string" && direct.data.length > 100) {
    out.push({ base64: direct.data, mime: String(direct.mime_type ?? "image/png") });
    return out;
  }
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || depth > 8 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    const mime = obj.mime_type ?? obj.mimeType ?? obj.media_type;
    if (typeof mime === "string" && mime.startsWith("image/") && typeof obj.data === "string" && obj.data.length > 100) {
      out.push({ base64: obj.data, mime });
      return;
    }
    for (const value of Object.values(obj)) walk(value, depth + 1);
  };
  walk(data, 0);
  return out;
}
