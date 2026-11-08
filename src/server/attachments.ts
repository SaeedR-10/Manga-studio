import type { Asset } from "./storage";
import { AppError } from "./http";
import { sha256 } from "./db";
import { assetPath, getAsset } from "./storage";
import fs from "node:fs";

/** کمینهٔ چیزی که یک مرجع برای ساختن پیوست باید داشته باشد. */
export interface RefLike {
  id: string;
  assetId: string;
  title: string;
  status: string;
  roles: string[];
  entityIds: string[];
  version: number;
}

/**
 * «فهرست پیوست» واحد و مرتب مراجع تصویری.
 *
 * پیش‌نمایش، پرامپت، درخواست ذخیره‌شده، کارگر صف و آداپتور ارائه‌دهنده همه از
 * همین فهرست استفاده می‌کنند؛ شمارهٔ «تصویر ۱، ۲، …» در پرامپت دقیقاً همان
 * ترتیبی است که بایت‌ها به سرویس می‌روند. ترتیب ورودی هرگز با مرتب‌سازی
 * دوباره عوض نمی‌شود و مرجع گم‌شده/تأییدنشده/تغییرکرده با خطای روشن گزارش
 * می‌شود، نه با جابه‌جایی بی‌صدای شماره‌ها.
 */

export interface AttachmentEntry {
  /** شمارهٔ یک‌پایه؛ همان «image N» در پرامپت */
  index: number;
  referenceId: string;
  referenceVersion: number;
  referenceTitle: string;
  assetId: string;
  assetSha256: string;
  assetMime: string;
  roles: string[];
  entityIds: string[];
  entityName: string;
}

export interface AttachmentProblem {
  referenceId: string;
  reason: string;
}

export interface AttachmentManifest {
  entries: AttachmentEntry[];
  problems: AttachmentProblem[];
  limit: number;
}

function entityNames(ref: RefLike, nameOf: (id: string) => string): string {
  return ref.entityIds.map((id) => nameOf(id)).filter(Boolean).join("، ");
}

/**
 * @param ids ترتیب درخواستی (انتخاب کاربر یا انتخاب خودکار) — حفظ می‌شود
 * @param refs مراجع بارگذاری‌شده برای همان شناسه‌ها
 */
export function buildAttachmentManifest(input: {
  ids: string[];
  refs: RefLike[];
  limit: number;
  entityName?: (id: string) => string;
}): AttachmentManifest {
  const byId = new Map(input.refs.map((ref) => [ref.id, ref]));
  const nameOf = input.entityName ?? (() => "");
  const entries: AttachmentEntry[] = [];
  const problems: AttachmentProblem[] = [];
  const seen = new Set<string>();

  for (const id of input.ids) {
    if (seen.has(id)) {
      problems.push({ referenceId: id, reason: "شناسهٔ تکراری در فهرست مراجع؛ فقط یک بار فرستاده می‌شود." });
      continue;
    }
    seen.add(id);
    const ref = byId.get(id);
    if (!ref) {
      problems.push({ referenceId: id, reason: "مرجع پیدا نشد (حذف شده یا متعلق به پروژهٔ دیگر است)." });
      continue;
    }
    if (ref.status !== "approved") {
      problems.push({ referenceId: id, reason: `مرجع «${ref.title}» تأیید نشده است (${ref.status}).` });
      continue;
    }
    const asset = getAsset(ref.assetId);
    if (!asset) {
      problems.push({ referenceId: id, reason: `فایل مرجع «${ref.title}» پیدا نشد.` });
      continue;
    }
    entries.push({
      index: entries.length + 1,
      referenceId: ref.id,
      referenceVersion: ref.version,
      referenceTitle: ref.title,
      assetId: asset.id,
      assetSha256: asset.sha256,
      assetMime: asset.mime,
      roles: ref.roles,
      entityIds: ref.entityIds,
      entityName: entityNames(ref, nameOf),
    });
  }

  if (entries.length > input.limit) {
    throw new AppError(
      `تعداد مراجع انتخاب‌شده (${entries.length}) از سقف مدل (${input.limit}) بیشتر است.`,
      400,
      "too_many_references",
      "چند مرجع را بردارید یا مدلی با سقف بالاتر انتخاب کنید؛ حذف خودکار انجام نمی‌شود.",
    );
  }

  return { entries, problems, limit: input.limit };
}

/** مراجع صریح کاربر باید همه معتبر باشند؛ مشکل = خطای قابل‌اقدام. */
export function assertManifestComplete(manifest: AttachmentManifest): void {
  if (manifest.problems.length === 0) return;
  throw new AppError(
    "مجموعهٔ مراجع انتخاب‌شده کامل نیست.",
    409,
    "reference_set_invalid",
    manifest.problems.map((p) => p.reason).join(" · "),
  );
}

/** فایل بارگذاری‌شده و بایت‌هایی که دقیقاً همین حالا سنجیده و تأیید شدند. */
export interface LoadedAttachment {
  entry: AttachmentEntry;
  asset: Asset;
  /** همان بایت‌هایی که به سرویس می‌رود؛ بین بررسی و ارسال فاصله‌ای نیست. */
  buffer: Buffer;
}

const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_BYTES = 40 * 1024 * 1024;

/**
 * بررسی زمان ارسال: بایت‌های واقعیِ فایل خوانده، هش و اعتبارسنجی می‌شوند و همان
 * بافرها برگردانده می‌شوند. مقایسهٔ هشِ ذخیره‌شده در پایگاه داده کافی نیست، چون
 * فایل روی دیسک می‌تواند پس از پیش‌نمایش تغییر کرده باشد.
 */
export function loadVerifiedAttachments(entries: AttachmentEntry[]): LoadedAttachment[] {
  const out: LoadedAttachment[] = [];
  for (const entry of entries) {
    const asset = getAsset(entry.assetId);
    if (!asset) {
      throw new AppError(
        `فایل تصویر مرجع «${entry.referenceTitle}» (تصویر ${entry.index}) پیدا نشد.`,
        409,
        "attachment_missing",
        "مرجع را دوباره بارگذاری یا در پیش‌نمایش جایگزین کنید.",
      );
    }
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(assetPath(asset));
    } catch {
      throw new AppError(
        `فایل تصویر مرجع «${entry.referenceTitle}» (تصویر ${entry.index}) روی دیسک خوانده نشد.`,
        409,
        "attachment_missing",
        "فایل مرجع آسیب دیده یا جابه‌جا شده است؛ آن را دوباره بارگذاری کنید.",
      );
    }
    if (buffer.byteLength === 0) {
      throw new AppError(
        `فایل تصویر مرجع «${entry.referenceTitle}» (تصویر ${entry.index}) خالی است.`,
        409,
        "attachment_corrupt",
        "فایل خالی ارسال نمی‌شود؛ مرجع را دوباره بارگذاری کنید.",
      );
    }
    if (buffer.byteLength > MAX_BYTES) {
      throw new AppError(
        `حجم فایل مرجع «${entry.referenceTitle}» از سقف ۴۰ مگابایت بیشتر است.`,
        409,
        "attachment_too_large",
        "فایل کوچک‌تری بارگذاری کنید.",
      );
    }
    const mime = entry.assetMime || asset.mime;
    if (!ALLOWED_MIME.has(mime) || asset.mime !== mime) {
      throw new AppError(
        `نوع فایل مرجع «${entry.referenceTitle}» پشتیبانی نمی‌شود (${mime}).`,
        409,
        "attachment_type_invalid",
        "فقط PNG، JPEG، WebP یا GIF پذیرفته می‌شود.",
      );
    }
    const actual = sha256(buffer);
    if ((entry.assetSha256 && actual !== entry.assetSha256) || actual !== asset.sha256) {
      throw new AppError(
        `محتوای تصویر مرجع «${entry.referenceTitle}» (تصویر ${entry.index}) پس از تأیید تغییر کرده است.`,
        409,
        "attachment_changed",
        "پیش‌نمایش ورودی را دوباره بسازید تا مجموعهٔ مراجع با فایل‌های فعلی هم‌راستا شود.",
      );
    }
    out.push({ entry, asset, buffer });
  }
  return out;
}
