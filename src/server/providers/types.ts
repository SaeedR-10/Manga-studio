/** قرارداد داخلی مستقل از ارائه‌دهنده. */

export type ImagePart = { mime: string; base64: string; label?: string };

export interface TextRequest {
  model: string;
  system: string;
  user: string;
  images?: ImagePart[];
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface TextResult {
  text: string;
  tokensIn: number | null;
  tokensOut: number | null;
  providerRequestId: string | null;
  raw: unknown;
  /** اگر ارائه‌دهنده هزینهٔ گزارش‌شده بدهد */
  reportedCostUsd: number | null;
}

export interface ImageRequest {
  model: string;
  prompt: string;
  images?: ImagePart[];
  mask?: ImagePart;
  size?: string;
  aspectRatio?: string;
  imageSize?: string;
  n?: number;
  outputFormat?: "png" | "jpeg" | "webp";
  background?: "auto" | "transparent" | "opaque";
  signal?: AbortSignal;
}

export interface ImageResult {
  images: Array<{ base64: string; mime: string }>;
  providerRequestId: string | null;
  raw: unknown;
  reportedCostUsd: number | null;
  /** توکن مصرفی تصویر، اگر ارائه‌دهنده گزارش کند (برای محاسبهٔ هزینه) */
  imageOutputTokens: number | null;
  seed: string | null;
}

export interface ProviderCapabilities {
  text: boolean;
  vision: boolean;
  imageGeneration: boolean;
  imageEdit: boolean;
  maxReferenceImages: number;
  mask: boolean;
  transparent: boolean;
  seed: boolean;
  structuredJson: "json_schema" | "prompt_only";
}

export interface Provider {
  id: "openai" | "google" | "chatgpt";
  label: string;
  capabilities(): ProviderCapabilities;
  analyze(req: TextRequest, apiKey: string): Promise<TextResult>;
  generateImage(req: ImageRequest, apiKey: string): Promise<ImageResult>;
}

/** خطای یکسان‌شده؛ `unknownOutcome` یعنی ممکن است درخواست در سمت سرویس اجرا شده باشد. */
export class ProviderError extends Error {
  constructor(
    message: string,
    public httpStatus: number | null,
    public code: string,
    public retryable: boolean,
    public unknownOutcome = false,
    public hint?: string,
  ) {
    super(message);
  }
}

export function timeoutSignal(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

export async function readJsonResponse(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw_text: text.slice(0, 2000) };
  }
}

export function errorMessage(payload: unknown): { message: string; code: string | null; type: string | null } {
  const obj = payload as Record<string, unknown> | null;
  const err = (obj?.error ?? null) as Record<string, unknown> | null;
  if (err) {
    return {
      message: String(err.message ?? "خطای ارائه‌دهنده"),
      code: err.code == null ? null : String(err.code),
      type: err.type == null ? null : String(err.type),
    };
  }
  return {
    message: String((obj?.message as string) ?? "پاسخ خطای نامشخص از ارائه‌دهنده"),
    code: obj?.code == null ? null : String(obj.code),
    type: null,
  };
}

/** نگاشت خطای HTTP به وضعیت قابل‌اقدام برای کاربر و صف. */
export function classifyHttpError(status: number, message: string, code: string | null): ProviderError {
  if (status === 401) {
    return new ProviderError("کلید API پذیرفته نشد یا منقضی است.", status, "unauthorized", false, false, "کلید را در تنظیمات اتصال‌ها جایگزین کنید.");
  }
  if (status === 402) {
    return new ProviderError("اعتبار حساب ارائه‌دهنده کافی نیست.", status, "payment_required", false, false, "اعتبار حساب سرویس را بررسی کنید.");
  }
  if (status === 403) {
    return new ProviderError("دسترسی این کلید به این مدل مجاز نیست.", status, "forbidden", false, false, "مدل دیگری انتخاب کنید یا دسترسی پروژه را بررسی کنید.");
  }
  if (status === 429) {
    return new ProviderError("محدودیت نرخ یا سهمیهٔ سرویس فعال شد.", status, "rate_limited", true, false, "کمی بعد دوباره تلاش کنید؛ درخواست خودکار تکرار نمی‌شود.");
  }
  if (status === 400 || status === 404 || status === 422) {
    return new ProviderError(message, status, code ?? "invalid_request", false, false, "ورودی یا شناسهٔ مدل را بررسی کنید.");
  }
  if (status >= 500) {
    return new ProviderError("سرویس ارائه‌دهنده موقتاً در دسترس نیست.", status, "provider_unavailable", true, true);
  }
  return new ProviderError(message, status, code ?? "provider_error", false, true);
}

export async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const { signal, cancel } = timeoutSignal(ms);
  const composite = init.signal
    ? AbortSignal.any([init.signal, signal])
    : signal;
  try {
    return await fetch(url, { ...init, signal: composite });
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    throw new ProviderError(
      aborted ? "زمان پاسخ سرویس به پایان رسید." : "ارتباط با سرویس برقرار نشد.",
      null,
      aborted ? "timeout" : "network",
      !aborted,
      true,
      "وضعیت این درخواست نامشخص است؛ پیش از ارسال دوباره، وضعیت را بررسی کنید.",
    );
  } finally {
    cancel();
  }
}
