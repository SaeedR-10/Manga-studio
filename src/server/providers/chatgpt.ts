import { planAccessToken } from "../chatgpt-plan";
import { Provider, ProviderError, TextResult } from "./types";

/** OAuth ChatGPT-plan requests use the documented public Responses route, never backend-api. */
export const chatgptProvider: Provider = {
  id: "chatgpt", label: "اشتراک ChatGPT",
  capabilities: () => ({ text: true, vision: true, imageGeneration: false, imageEdit: false, maxReferenceImages: 0, mask: false, transparent: false, seed: false, structuredJson: "prompt_only" }),
  async generateImage() { throw new ProviderError("تولید تصویر با اتصال اشتراک پشتیبانی نمی‌شود؛ API یا انتقال دستی را انتخاب کنید.", 400, "plan_image_unsupported", false); },
  async analyze(req): Promise<TextResult> {
    const access = await planAccessToken();
    const content: Record<string, unknown>[] = [{ type: "input_text", text: req.user }];
    for (const image of req.images ?? []) content.push({ type: "input_image", image_url: `data:${image.mime};base64,${image.base64}` });
    const response = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { authorization: `Bearer ${access}`, "content-type": "application/json" }, body: JSON.stringify({ model: req.model, instructions: req.system, input: [{ role: "user", content }], store: false, stream: true }), signal: req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000) });
    if (!response.ok) throw new ProviderError(response.status === 401 ? "اتصال ChatGPT منقضی شده؛ دوباره وارد شوید." : "درخواست اشتراک پذیرفته نشد؛ دسترسی مدل و سقف مصرف حساب را بررسی کنید.", response.status, "chatgpt_request_failed", false);
    if (!response.body) throw new ProviderError("جریان پاسخ دریافت نشد.", 200, "empty_stream", false, true);
    return readPlanStream(response.body);
  },
};

export async function readPlanStream(body: ReadableStream<Uint8Array>): Promise<TextResult> {
  const reader = body.getReader(); const decoder = new TextDecoder(); let buffer = ""; let text = ""; let complete = false; let id: string | null = null; let tokensIn: number | null = null; let tokensOut: number | null = null;
  function consume(block: string) {
    const data = block.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    let event: Record<string, any>; try { event = JSON.parse(data); } catch { throw new ProviderError("پاسخ جریانی نامعتبر است.", 200, "invalid_stream", false, true); }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") text += event.delta;
    if (["response.failed", "response.incomplete", "error"].includes(event.type)) throw new ProviderError("درخواست اشتراک کامل نشد؛ وضعیت دسترسی و مصرف را در ChatGPT بررسی کنید.", 200, String(event.response?.error?.code || event.error?.code || event.type), false, event.type !== "response.failed");
    if (event.type === "response.completed") { complete = true; id = event.response?.id ?? null; const u = event.response?.usage; tokensIn = typeof u?.input_tokens === "number" ? u.input_tokens : null; tokensOut = typeof u?.output_tokens === "number" ? u.output_tokens : null; }
  }
  try {
    while (true) { const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, { stream: true }); let match: RegExpExecArray | null; while ((match = /\r?\n\r?\n/.exec(buffer))) { const block = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length); consume(block); } }
    buffer += decoder.decode(); if (buffer.trim()) consume(buffer);
  } catch (error) { if (error instanceof ProviderError) throw error; throw new ProviderError("ارتباط پیش از تکمیل پاسخ قطع شد؛ دوباره‌فرستادن خودکار انجام نمی‌شود.", null, "stream_interrupted", false, true); }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  if (!complete || !text.trim()) throw new ProviderError("پاسخ کامل و قابل استفاده دریافت نشد.", 200, "incomplete_stream", false, true);
  return { text, tokensIn, tokensOut, providerRequestId: id, raw: { id, text, billing: "chatgpt_plan" }, reportedCostUsd: null };
}
