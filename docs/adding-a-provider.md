# افزودن ارائه‌دهندهٔ تازه

قرارداد داخلی در `src/server/providers/types.ts` تعریف شده و هیچ‌جای رابط کاربر یا
دامنه به یک ارائه‌دهنده وابسته نیست. برای افزودن ارائه‌دهندهٔ سوم:

## ۱. قابلیت‌ها را فقط از مستندات رسمی بردارید

پیش از نوشتن کد، صفحهٔ رسمی مستندات و صفحهٔ قیمت همان ارائه‌دهنده را بخوانید و این
موارد را یادداشت کنید: شناسهٔ دقیق مدل، endpoint، اندازه/نسبت تصویر، تعداد تصویر
مرجع، ماسک، شفافیت، seed، امکان دریافت وضعیت کار، و روش درخواست JSON ساختاریافته.
هر قابلیتی که مستند نشده است باید `false` بماند. قیمت هر مدل باید با `sourceUrl` و
`effectiveDate` در `src/server/models.ts` ثبت شود؛ اگر نرخ معلوم نیست مقدار `null`
بگذارید تا رابط «نامشخص» نشان دهد و عدد ساختگی نمایش داده نشود.

`npm run typecheck` هرگز شناسهٔ مدل را در کد مسیر درخواست هارد‌کد نمی‌کند؛ مدل از
کاتالوگ و تنظیمات پروژه می‌آید و در تاریخچهٔ درخواست (`ai_requests.model`) ثبت می‌شود.

## ۲. آداپتور را بنویسید

```ts
// src/server/providers/example.ts
import { Provider, ProviderCapabilities } from "./types";

const CAPABILITIES: ProviderCapabilities = {
  text: true,
  vision: false,
  imageGeneration: true,
  imageEdit: false,
  maxReferenceImages: 0,
  mask: false,
  transparent: false,
  seed: true,
  structuredJson: "prompt_only",
};

export const exampleProvider: Provider = {
  id: "example",           // باید به union نوع Provider.id اضافه شود
  label: "Example AI",
  capabilities: () => CAPABILITIES,
  analyze: async (req, apiKey) => { /* POST … → { text, tokensIn, tokensOut, … } */ },
  generateImage: async (req, apiKey) => { /* POST … → { images, imageOutputTokens, … } */ },
};
```

قواعد الزامی:

- کلید فقط به‌صورت پارامتر تابع می‌آید. هیچ آداپتوری کلید را ذخیره، لاگ یا در
  `raw` پاسخ برنمی‌گرداند.
- هر خطای HTTP با `classifyHttpError` نگاشت می‌شود تا صف بداند خطا موقت است یا نه.
  خطای نامشخص (قطعی شبکه/تایم‌اوت) باید `unknownOutcome = true` بدهد تا صف کار را
  خودکار دوباره نفرستد.
- پیام خطا فارسی، کوتاه و دارای اقدام بعدی باشد؛ جزئیات فنی در `raw_response` می‌ماند.
- درخواست همیشه با تایم‌اوت و `AbortSignal` اجرا شود (`fetchWithTimeout`).

## ۳. ثبت در رجیستری و کاتالوگ

1. `src/server/providers/index.ts`: آداپتور را در نقشهٔ `PROVIDERS` بگذارید.
2. `src/server/providers/types.ts`: `Provider["id"]` را گسترش دهید.
3. `src/server/models.ts`: مدل‌های متنی/تصویری با `capabilities` و `price` اضافه شوند
   و در `DEFAULT_MODELS` مدل پیش‌فرض مشخص شود.
4. `src/server/secrets.ts`: شناسهٔ ارائه‌دهنده را به `PROVIDERS` اضافه کنید تا کلید در
   Credential Manager با همان نام نگه‌داری شود.
5. `src/app/api/settings/route.ts` و صفحهٔ تنظیمات: فهرست مدل‌ها خودکار از کاتالوگ
   خوانده می‌شود؛ فقط اگر برچسب یا ترتیب خاصی می‌خواهید تغییر دهید.
6. `src/server/api-helpers.ts`: در صورت افزودن فیلد تنظیمات تازه، اسکیمای zod را
   به‌روز کنید (اعتبارسنجی ورودی ذخیره‌سازی الزامی است).

## ۴. آزمون

- یک تست واحد در `tests/` بنویسید که پاسخ کنترل‌شده (fetch جعلی) را به آداپتور بدهد و
  هم مسیر موفق و هم نگاشت خطا (۴۰۱/۴۲۹/۵۰۰) را بررسی کند.
- تست عمومی «نبود کلید در خروجی» (`tests/storage.test.ts`) باید همچنان سبز بماند.
- آزمون زنده فقط وقتی معنا دارد که کاربر کلید خودش را در تنظیمات وارد کرده باشد؛ آن را
  از تست خودکار جدا نگه دارید و هیچ درخواست پولی خودکار ارسال نکنید.

## ۵. چیزهایی که خودکار سازگار نمی‌شوند

«سازگار با OpenAI» به معنی پشتیبانی از همهٔ امکانات نیست. ماسک، شفافیت، seed، تعداد
مرجع و JSON ساختاریافته را جدا و صریح اعلام کنید؛ رابط کاربر بر اساس همان
`capabilities` دکمه‌ها را فعال/غیرفعال می‌کند و محدودیت ناسازگار را بی‌صدا حذف نمی‌کند.
