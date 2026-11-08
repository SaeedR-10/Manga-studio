import { cachedPlanModels } from "./chatgpt-plan";
/**
 * کاتالوگ مدل‌ها و نرخ‌ها.
 *
 * این فایل تنها جای «حافظهٔ» مدل‌هاست و همهٔ ردیف‌ها تاریخ بازبینی و منبع
 * رسمی دارند. شناسهٔ مدل هیچ‌گاه در کد مسیر درخواست هارد‌کد نمی‌شود؛ از
 * تنظیمات کاربر/کاتالوگ خوانده و در تاریخچهٔ درخواست ثبت می‌شود.
 *
 * منبع‌های خوانده‌شده (بازبینی: ۲۰۲۶-۱۰-۳۰):
 *  - https://developers.openai.com/api/docs/pricing
 *  - https://developers.openai.com/api/reference/resources/images/methods/generate/
 *  - https://developers.openai.com/api/reference/resources/images/methods/edit/
 *  - https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst
 *  - https://ai.google.dev/gemini-api/docs/pricing
 *  - https://ai.google.dev/gemini-api/docs/image-generation
 *  - https://ai.google.dev/gemini-api/docs/api-errors
 */

export const CATALOG_VERIFIED_AT = "2026-10-30";

export type Capability = {
  imageInput: boolean;
  maxReferenceImages: number;
  mask: boolean;
  transparent: boolean;
  seed: boolean;
  jobStatusPolling: boolean;
  structuredJson: "json_schema" | "prompt_only";
  aspectRatios: string[];
  sizes: string[];
  notes: string;
};

export type ModelEntry = {
  provider: "openai" | "google" | "chatgpt";
  id: string;
  label: string;
  kind: "text" | "image";
  capabilities: Capability;
  price: {
    /** نرخ‌ها بر پایهٔ واحد؛ null یعنی «نامشخص» و هیچ مقدار ساختگی جای آن نیست. */
    unit: "per_1m_tokens" | "per_image";
    inputUsd: number | null;
    outputUsd: number | null;
    imageUsdBySize?: Record<string, number | null>;
    sourceUrl: string;
    effectiveDate: string;
    note?: string;
  };
};

const NO = {
  imageInput: false,
  maxReferenceImages: 0,
  mask: false,
  transparent: false,
  seed: false,
  jobStatusPolling: false,
  structuredJson: "json_schema" as const,
  aspectRatios: [] as string[],
  sizes: [] as string[],
  notes: "",
};

export const MODELS: ModelEntry[] = [
  // ---------------------------------------------------------------- OpenAI
  {
    provider: "openai",
    id: "gpt-6.1-sol",
    label: "GPT-6.1 Sol (متن و بینایی)",
    kind: "text",
    capabilities: {
      ...NO,
      imageInput: true,
      structuredJson: "json_schema",
      notes: "تحلیل متن/تصویر؛ مدل پیش‌فرض متعادل برای تحلیل صحنه و بازبینی.",
    },
    price: {
      unit: "per_1m_tokens",
      inputUsd: 2,
      outputUsd: 10,
      sourceUrl: "https://developers.openai.com/api/docs/pricing",
      effectiveDate: "2026-10-30",
    },
  },
  {
    provider: "openai",
    id: "gpt-6.1-terra",
    label: "GPT-6.1 Terra (ارزان‌تر)",
    kind: "text",
    capabilities: { ...NO, imageInput: true, notes: "برای پیش‌نویس و وظایف سادهٔ متنی؛ همهٔ مدل‌های جدید OpenAI ورودی تصویر را پشتیبانی می‌کنند." },
    price: {
      unit: "per_1m_tokens",
      inputUsd: 1,
      outputUsd: 5,
      sourceUrl: "https://developers.openai.com/api/docs/pricing",
      effectiveDate: "2026-10-30",
    },
  },
  {
    provider: "openai",
    id: "gpt-image-2.5-flare",
    label: "GPT Image 2.5 Flare (تصویر، سریع)",
    kind: "image",
    capabilities: {
      ...NO,
      imageInput: true,
      maxReferenceImages: 16,
      mask: true,
      transparent: true,
      seed: false,
      structuredJson: "prompt_only",
      aspectRatios: ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"],
      sizes: ["1024x1024", "1536x1024", "1024x1536", "custom WxH (÷16، نسبت 1:3 تا 3:1، حداکثر 3840x2160)"],
      notes: "تا ۱۶ تصویر مرجع؛ قیمت بر پایهٔ توکن تصویر خروجی است، نه جدول ثابت هر تصویر.",
    },
    price: {
      unit: "per_1m_tokens",
      inputUsd: 8,
      outputUsd: 30,
      imageUsdBySize: {},
      sourceUrl: "https://developers.openai.com/api/docs/pricing",
      effectiveDate: "2026-10-30",
      note: "OpenAI برای این مدل قیمت ثابت هر تصویر منتشر نمی‌کند؛ برآورد هر تصویر «نامشخص» است و فقط مصرف گزارش‌شده محاسبه می‌شود.",
    },
  },
  {
    provider: "openai",
    id: "gpt-image-2.5-sunburst",
    label: "GPT Image 2.5 Sunburst (تصویر، دقیق‌تر)",
    kind: "image",
    capabilities: {
      ...NO,
      imageInput: true,
      maxReferenceImages: 16,
      mask: true,
      transparent: true,
      seed: false,
      structuredJson: "prompt_only",
      aspectRatios: ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"],
      sizes: ["1024x1024", "1536x1024", "1024x1536", "custom WxH (÷16، نسبت 1:3 تا 3:1، حداکثر 3840x2160)"],
      notes: "دقیق‌ترین مدل تصویر OpenAI؛ برای پنل‌های نهایی. تا ۱۶ مرجع، ماسک و پس‌زمینهٔ شفاف.",
    },
    price: {
      unit: "per_1m_tokens",
      inputUsd: 8,
      outputUsd: 30,
      imageUsdBySize: {},
      sourceUrl: "https://developers.openai.com/api/docs/pricing",
      effectiveDate: "2026-10-30",
      note: "قیمت هر تصویر منتشر نشده؛ «نامشخص».",
    },
  },
  // ---------------------------------------------------------------- Google
  {
    provider: "google",
    id: "gemini-3.8-flash",
    label: "Gemini 3.8 Flash (متن و بینایی)",
    kind: "text",
    capabilities: {
      ...NO,
      imageInput: true,
      structuredJson: "json_schema",
      notes: "تحلیل متن و تصویر؛ پاسخ JSON در پراپمت درخواست و با zod اعتبارسنجی می‌شود.",
    },
    price: {
      unit: "per_1m_tokens",
      inputUsd: 0.75,
      outputUsd: 3.75,
      sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing",
      effectiveDate: "2026-10-30",
      note: "نرخ تا ۳۱ دسامبر ۲۰۲۶؛ از ۱ ژانویه ۲۰۲۷ دو برابر می‌شود.",
    },
  },
  {
    provider: "google",
    id: "gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash Lite (ارزان)",
    kind: "text",
    capabilities: { ...NO, imageInput: true, structuredJson: "json_schema", notes: "برای وظایف سبک و آزمون اتصال." },
    price: {
      unit: "per_1m_tokens",
      inputUsd: 0.3,
      outputUsd: 2.5,
      sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing",
      effectiveDate: "2026-10-30",
    },
  },
  {
    provider: "google",
    id: "gemini-nano-banana-2.1",
    label: "Nano Banana 2.1 (تصویر)",
    kind: "image",
    capabilities: {
      ...NO,
      imageInput: true,
      maxReferenceImages: 14,
      mask: false,
      transparent: false,
      seed: false,
      structuredJson: "prompt_only",
      aspectRatios: ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
      sizes: ["1K", "2K", "4K"],
      notes: "حداکثر ۱۴ تصویر مرجع؛ Interactions API. ماسک و seed پشتیبانی مستند ندارد.",
    },
    price: {
      unit: "per_image",
      inputUsd: null,
      outputUsd: null,
      imageUsdBySize: { "1K": 0.0336, "2K": 0.0504, "4K": 0.113 },
      sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing",
      effectiveDate: "2026-10-30",
      note: "قیمت مؤثر هر تصویر بر پایهٔ ۱۱۲۰/۱۶۸۰/۳۷۸۰ توکن تصویر.",
    },
  },
  {
    provider: "google",
    id: "gemini-3-pro-image",
    label: "Nano Banana Pro (تصویر، کیفیت بالا)",
    kind: "image",
    capabilities: {
      ...NO,
      imageInput: true,
      maxReferenceImages: 14,
      mask: false,
      transparent: false,
      seed: false,
      structuredJson: "prompt_only",
      aspectRatios: ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
      sizes: ["1K", "2K", "4K"],
      notes: "کیفیت بالاتر با هزینهٔ بیشتر؛ برای پنل نهایی.",
    },
    price: {
      unit: "per_image",
      inputUsd: null,
      outputUsd: null,
      imageUsdBySize: { "1K": 0.134, "2K": 0.134, "4K": 0.24 },
      sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing",
      effectiveDate: "2026-10-30",
      note: "نرخ از صفحهٔ رسمی قیمت خوانده شده، اما بخش این مدل در آخرین بازبینی خودکار کامل قابل بازیابی نبود؛ پیش از اتکا در محاسبهٔ بودجه، همان صفحه را ببینید.",
    },
  },
];

export const DEFAULT_MODELS = {
  text: { openai: "gpt-6.1-sol", google: "gemini-3.8-flash" },
  image: { openai: "gpt-image-2.5-flare", google: "gemini-nano-banana-2.1" },
} as const;

export function findModel(provider: string, id: string): ModelEntry | undefined {
  return allModels().find((m) => m.provider === provider && m.id === id);
}

export function modelsFor(provider: string, kind: "text" | "image"): ModelEntry[] {
  return allModels().filter((m) => m.provider === provider && m.kind === kind);
}

/** برآورد هزینه؛ اگر نرخ معلوم نباشد null برمی‌گردد تا رابط «نامشخص» نشان دهد. */
export function estimateImageCost(modelId: string, size: string): { usd: number | null; basis: string; source: string } {
  const model = allModels().find((m) => m.id === modelId);
  if (!model || model.kind !== "image") {
    return { usd: null, basis: "مدل در کاتالوگ نیست", source: "" };
  }
  const direct = model.price.imageUsdBySize?.[size];
  if (typeof direct === "number") {
    return {
      usd: direct,
      basis: `نرخ منتشرشده برای ${size}`,
      source: model.price.sourceUrl,
    };
  }
  return {
    usd: null,
    basis: "ناشر قیمت ثابت هر تصویر منتشر نکرده است",
    source: model.price.sourceUrl,
  };
}

export function estimateTextCost(
  modelId: string,
  tokensIn: number,
  tokensOut: number,
): { usd: number | null; basis: string; source: string } {
  const model = allModels().find((m) => m.id === modelId);
  if (!model || model.kind !== "text" || model.price.inputUsd == null || model.price.outputUsd == null) {
    return { usd: null, basis: "نرخ توکن برای این مدل ثبت نشده", source: model?.price.sourceUrl ?? "" };
  }
  const usd = (tokensIn / 1_000_000) * model.price.inputUsd + (tokensOut / 1_000_000) * model.price.outputUsd;
  return { usd, basis: "بر پایهٔ نرخ هر یک‌میلیون توکن", source: model.price.sourceUrl };
}

export function allModels(): ModelEntry[] {
  return [...MODELS, ...cachedPlanModels().map(m => ({
    provider: "chatgpt" as const, id: m.id, label: `${m.label} · اشتراک ChatGPT`, kind: "text" as const,
    capabilities: { ...NO, imageInput: true, structuredJson: "prompt_only" as const, notes: "تحلیل با سهمیهٔ حساب؛ پذیرش تصویر به مدل و دسترسی حساب وابسته است. تولید تصویر پشتیبانی نمی‌شود." },
    price: { unit: "per_1m_tokens" as const, inputUsd: null, outputUsd: null, sourceUrl: "https://developers.openai.com/siwc/token-sharing-open-source", effectiveDate: "2026-10-31", note: "مصرف سهمیهٔ اشتراک؛ این مسیر صورتحساب API را محاسبه نمی‌کند." }
  }))];
}
