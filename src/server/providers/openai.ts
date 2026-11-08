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
 * اتصال OpenAI.
 *
 * مسیرها و شکل بدنه بر پایهٔ مستندات رسمی بازبینی‌شده در ۲۰۲۶-۱۰-۳۰:
 *  - تولید تصویر: POST /v1/images/generations
 *  - ویرایش/مرجع: POST /v1/images/edits  (آرایهٔ images، حداکثر ۱۶ مورد، mask)
 *  - تحلیل متن/تصویر: POST /v1/responses با input_image (data URL)
 *
 * مدل gpt-image-1 در ۲۳ اکتبر ۲۰۲۶ بازنشسته شد؛ هیچ شناسهٔ مدلی در این فایل
 * پیش‌فرض نیست و مدل از کاتالوگ/تنظیمات می‌آید.
 */

const BASE = () => (process.env.RAVAYAT_OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");

const CAPABILITIES: ProviderCapabilities = {
  text: true,
  vision: true,
  imageGeneration: true,
  imageEdit: true,
  maxReferenceImages: 16,
  mask: true,
  transparent: true,
  seed: false,
  structuredJson: "json_schema",
};

function headers(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
}

export const openaiProvider: Provider = {
  id: "openai",
  label: "OpenAI",
  capabilities: () => CAPABILITIES,

  async analyze(req: TextRequest, apiKey: string): Promise<TextResult> {
    const content: Array<Record<string, unknown>> = [{ type: "input_text", text: req.user }];
    for (const image of req.images ?? []) {
      content.push({
        type: "input_image",
        image_url: `data:${image.mime};base64,${image.base64}`,
        detail: "auto",
      });
    }
    const body: Record<string, unknown> = {
      model: req.model,
      instructions: req.system,
      input: [{ role: "user", content }],
      max_output_tokens: req.maxOutputTokens ?? 2048,
    };
    if (req.jsonSchema) {
      body.text = {
        format: { type: "json_schema", name: req.jsonSchema.name, schema: req.jsonSchema.schema, strict: true },
      };
    }

    let res = await fetchWithTimeout(`${BASE()}/responses`, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify(body),
      signal: req.signal,
    }, 180_000);

    let payload = await readJsonResponse(res);

    // اگر مدل/سرویس سازگار، قالب ساختاریافته را نپذیرفت، یک بار بدون آن تلاش می‌شود.
    if (!res.ok && req.jsonSchema && res.status === 400) {
      const raw = JSON.stringify(payload);
      if (/json_schema|response_format|text\.format|format/i.test(raw)) {
        delete body.text;
        res = await fetchWithTimeout(`${BASE()}/responses`, {
          method: "POST",
          headers: headers(apiKey),
          body: JSON.stringify(body),
          signal: req.signal,
        }, 180_000);
        payload = await readJsonResponse(res);
      }
    }

    if (!res.ok) {
      const info = errorMessage(payload);
      throw classifyHttpError(res.status, info.message, info.code);
    }

    const data = payload as Record<string, unknown>;
    const text = extractResponseText(data);
    if (!text) throw new ProviderError("پاسخ متنی از مدل دریافت نشد.", res.status, "empty_response", true, false);
    const usage = (data.usage ?? {}) as Record<string, unknown>;
    return {
      text,
      tokensIn: numberOrNull(usage.input_tokens),
      tokensOut: numberOrNull(usage.output_tokens),
      providerRequestId: typeof data.id === "string" ? data.id : null,
      raw: data,
      reportedCostUsd: null,
    };
  },

  async generateImage(req: ImageRequest, apiKey: string): Promise<ImageResult> {
    const hasRefs = Boolean(req.images?.length);
    const url = hasRefs ? `${BASE()}/images/edits` : `${BASE()}/images/generations`;
    const body: Record<string, unknown> = {
      model: req.model,
      prompt: req.prompt,
      n: Math.min(Math.max(req.n ?? 1, 1), 10),
      output_format: req.outputFormat ?? "png",
    };
    if (req.size) body.size = req.size;
    if (req.background && req.background !== "auto") body.background = req.background;
    if (hasRefs) {
      body.images = req.images!.map((img) => ({ image_url: `data:${img.mime};base64,${img.base64}` }));
      if (req.mask) body.mask = { image_url: `data:${req.mask.mime};base64,${req.mask.base64}` };
    }

    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify(body),
      signal: req.signal,
    }, 300_000);
    const payload = await readJsonResponse(res);
    if (!res.ok) {
      const info = errorMessage(payload);
      throw classifyHttpError(res.status, info.message, info.code);
    }
    const data = payload as Record<string, unknown>;
    const list = Array.isArray(data.data) ? (data.data as Array<Record<string, unknown>>) : [];
    const images = list
      .map((item) => ({
        base64: typeof item.b64_json === "string" ? item.b64_json : "",
        mime: `image/${req.outputFormat ?? "png"}`,
      }))
      .filter((img) => img.base64.length > 0);
    if (images.length === 0) {
      throw new ProviderError("سرویس تصویری برنگرداند.", res.status, "no_image", true, false);
    }
    const usage = (data.usage ?? {}) as Record<string, unknown>;
    const outputTokens = numberOrNull(usage.output_tokens);
    return {
      images,
      providerRequestId: null,
      raw: data,
      reportedCostUsd: null,
      imageOutputTokens: outputTokens,
      seed: null,
    };
  },
};

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function extractResponseText(data: Record<string, unknown>): string {
  if (typeof data.output_text === "string") return data.output_text;
  const output = Array.isArray(data.output) ? (data.output as Array<Record<string, unknown>>) : [];
  const chunks: string[] = [];
  for (const item of output) {
    if (item.type !== "message") continue;
    const content = Array.isArray(item.content) ? (item.content as Array<Record<string, unknown>>) : [];
    for (const part of content) {
      if (part.type === "output_text" && typeof part.text === "string") chunks.push(part.text);
      if (part.type === "refusal" && typeof part.refusal === "string") {
        throw new ProviderError(`مدل درخواست را رد کرد: ${part.refusal}`, null, "refusal", false, false);
      }
    }
  }
  return chunks.join("\n").trim();
}
