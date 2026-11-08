import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openaiProvider } from "@/server/providers/openai";
import { googleProvider } from "@/server/providers/google";
import { ProviderError } from "@/server/providers/types";

/**
 * آزمون قرارداد آداپتورها با HTTP ساختگی.
 *
 * این آزمون‌ها هزینه‌ای ایجاد نمی‌کنند و کلید واقعی نمی‌خوانند؛ فقط بدنه/هدرها،
 * ترتیب تصاویر، ماسک و تفسیر پاسخ بررسی می‌شود. آزمون زنده با کلید کاربر،
 * دستهٔ جداگانه‌ای است.
 */

type Call = { url: string; init: RequestInit };

const calls: Call[] = [];
let responder: (call: Call) => Response;

beforeEach(() => {
  calls.length = 0;
  responder = () => new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return responder(call);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function bodyOf(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

describe("OpenAI: تحلیل متن/تصویر", () => {
  it("به /responses می‌رود، کلید در هدر است و ترتیب تصاویر حفظ می‌شود", async () => {
    responder = () =>
      jsonResponse({
        id: "resp_1",
        output_text: "{\"ok\":true}",
        usage: { input_tokens: 12, output_tokens: 34 },
      });
    const result = await openaiProvider.analyze(
      {
        model: "gpt-6.1-sol",
        system: "SYSTEM",
        user: "USER",
        images: [
          { mime: "image/png", base64: "AAA" },
          { mime: "image/png", base64: "BBB" },
        ],
        maxOutputTokens: 100,
      },
      "dummy-key",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.openai.com/v1/responses");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer dummy-key");
    const body = bodyOf(calls[0]);
    expect(body.model).toBe("gpt-6.1-sol");
    expect(body.max_output_tokens).toBe(100);
    const input = body.input as Array<{ content: Array<Record<string, unknown>> }>;
    const images = input[0].content.filter((part) => part.type === "input_image");
    expect(images.map((part) => String(part.image_url))).toEqual([
      "data:image/png;base64,AAA",
      "data:image/png;base64,BBB",
    ]);
    expect(result.text).toBe("{\"ok\":true}");
    expect(result.tokensIn).toBe(12);
    expect(result.tokensOut).toBe(34);
    expect(result.providerRequestId).toBe("resp_1");
  });

  it("امتناع مدل (refusal) به خطای قابل‌اقدام تبدیل می‌شود", async () => {
    responder = () =>
      jsonResponse({
        output: [{ type: "message", content: [{ type: "refusal", refusal: "نمی‌توانم این را بسازم" }] }],
      });
    await expect(
      openaiProvider.analyze({ model: "gpt-6.1-sol", system: "s", user: "u" }, "dummy-key"),
    ).rejects.toMatchObject({ code: "refusal", retryable: false });
  });

  it("سهمیه (429) قابل‌تلاش دوباره است ولی ۵۰۰ نتیجهٔ نامشخص می‌دهد", async () => {
    responder = () => jsonResponse({ error: { message: "rate limited", code: "rate_limit" } }, 429);
    await expect(openaiProvider.analyze({ model: "m", system: "s", user: "u" }, "k")).rejects.toMatchObject({
      httpStatus: 429,
      retryable: true,
      unknownOutcome: false,
    });
    responder = () => jsonResponse({ error: { message: "boom" } }, 500);
    await expect(openaiProvider.analyze({ model: "m", system: "s", user: "u" }, "k")).rejects.toMatchObject({
      httpStatus: 500,
      unknownOutcome: true,
    });
  });

  it("خطای شبکه، نتیجهٔ نامشخص است تا ارسال دوبارهٔ خودکار هزینه نسازد", async () => {
    vi.stubGlobal("fetch", async () => {
      throw Object.assign(new Error("offline"), { name: "TypeError" });
    });
    const error = await openaiProvider.analyze({ model: "m", system: "s", user: "u" }, "k").catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.unknownOutcome).toBe(true);
    expect(error.retryable).toBe(true);
  });
});

describe("OpenAI: تولید و ویرایش تصویر", () => {
  it("با مراجع به /images/edits می‌رود و ترتیب تصاویر و ماسک را می‌فرستد", async () => {
    responder = () =>
      jsonResponse({ data: [{ b64_json: Buffer.from("out").toString("base64") }], usage: { output_tokens: 900 } });
    const result = await openaiProvider.generateImage(
      {
        model: "gpt-image-2.5-flare",
        prompt: "PROMPT",
        images: [
          { mime: "image/png", base64: "FIRST" },
          { mime: "image/png", base64: "SECOND" },
        ],
        mask: { mime: "image/png", base64: "MASK" },
        size: "1024x1536",
      },
      "dummy-key",
    );
    expect(calls[0].url).toBe("https://api.openai.com/v1/images/edits");
    const body = bodyOf(calls[0]);
    expect(body.size).toBe("1024x1536");
    const images = body.images as Array<{ image_url: string }>;
    expect(images.map((image) => image.image_url)).toEqual([
      "data:image/png;base64,FIRST",
      "data:image/png;base64,SECOND",
    ]);
    expect((body.mask as { image_url: string }).image_url).toBe("data:image/png;base64,MASK");
    expect(result.images[0].base64).toBe(Buffer.from("out").toString("base64"));
    expect(result.imageOutputTokens).toBe(900);
  });

  it("بدون مرجع به /images/generations می‌رود و پاسخ خالی خطا می‌دهد", async () => {
    responder = () => jsonResponse({ data: [] });
    await expect(
      openaiProvider.generateImage({ model: "gpt-image-2.5-flare", prompt: "p" }, "k"),
    ).rejects.toMatchObject({ code: "no_image" });
    expect(calls[0].url).toBe("https://api.openai.com/v1/images/generations");
  });
});

describe("Google: قرارداد", () => {
  it("متن را با generateContent و تصاویر inline_data می‌فرستد", async () => {
    responder = () =>
      jsonResponse({
        responseId: "g-1",
        candidates: [{ content: { parts: [{ text: "{\"ok\":1}" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7 },
      });
    const result = await googleProvider.analyze(
      {
        model: "gemini-3.8-flash",
        system: "S",
        user: "U",
        images: [{ mime: "image/webp", base64: "IMG" }],
        jsonSchema: { name: "x", schema: {} },
      },
      "dummy-google-key",
    );
    expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("dummy-google-key");
    const body = bodyOf(calls[0]);
    const parts = (body.contents as Array<{ parts: Array<Record<string, unknown>> }>)[0].parts;
    expect(parts[0]).toEqual({ text: "U" });
    expect(parts[1]).toEqual({ inline_data: { mime_type: "image/webp", data: "IMG" } });
    expect((body.generationConfig as Record<string, unknown>).responseMimeType).toBe("application/json");
    expect(result.text).toBe("{\"ok\":1}");
    expect(result.providerRequestId).toBe("g-1");
  });

  it("بازدارندگی محتوا را با کد مشخص گزارش می‌کند", async () => {
    responder = () => jsonResponse({ promptFeedback: { blockReason: "SAFETY" } });
    await expect(googleProvider.analyze({ model: "m", system: "s", user: "u" }, "k")).rejects.toMatchObject({
      code: "content_blocked",
      retryable: false,
    });
  });

  it("توانایی ماسک را ادعا نمی‌کند (مدل بدون پشتیبانی مستند)", () => {
    expect(googleProvider.capabilities().mask).toBe(false);
    expect(googleProvider.capabilities().maxReferenceImages).toBeLessThanOrEqual(14);
  });
});
