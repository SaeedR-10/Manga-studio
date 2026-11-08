import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, nowIso } from "./db";
import { AppError } from "./http";

/**
 * پیش‌نویس‌های پایدار صحنه، بیرون از مبدأ مرورگر.
 *
 * پنجرهٔ دسکتاپ هر بار روی یک پورت تصادفی سرو می‌شود؛ `localStorage` به مبدأ
 * (شامل پورت) وابسته است و بنابراین برای بازیابی پس از اجرای دوباره کافی
 * نیست. پیش‌نویس‌ها در پوشهٔ دادهٔ کاربر نگه‌داری می‌شوند و فقط از مسیر
 * هم‌مبدأ و نشست همین برنامه خوانده/نوشته می‌شوند.
 */

export const DRAFT_DIR = path.join(DATA_DIR, "drafts");
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TEXT = 2_000_000;

export interface StoredDraft {
  sceneId: string;
  text: string;
  /** متنی که هنگام آغاز ویرایش روی سرور بود */
  baseText: string;
  baseUpdatedAt: string | null;
  savedAt: string;
  error?: string | null;
}

function ensureDir(): void {
  fs.mkdirSync(DRAFT_DIR, { recursive: true, mode: 0o700 });
}

function fileFor(sceneId: string): string {
  if (!ID_PATTERN.test(sceneId)) {
    throw new AppError("شناسهٔ صحنه برای پیش‌نویس معتبر نیست.", 400, "invalid_draft_id");
  }
  return path.join(DRAFT_DIR, `${sceneId}.json`);
}

function parse(raw: string): StoredDraft | null {
  try {
    const value = JSON.parse(raw) as StoredDraft;
    if (!value || typeof value.text !== "string" || typeof value.sceneId !== "string") return null;
    return value;
  } catch {
    return null;
  }
}

export function readStoredDraft(sceneId: string): StoredDraft | null {
  try {
    return parse(fs.readFileSync(fileFor(sceneId), "utf8"));
  } catch {
    return null;
  }
}

export function listStoredDrafts(): StoredDraft[] {
  try {
    ensureDir();
    const out: StoredDraft[] = [];
    for (const name of fs.readdirSync(DRAFT_DIR)) {
      if (!name.endsWith(".json")) continue;
      const draft = parse(fs.readFileSync(path.join(DRAFT_DIR, name), "utf8"));
      if (draft) out.push(draft);
    }
    return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  } catch {
    return [];
  }
}

export function writeStoredDraft(input: {
  sceneId: string;
  text: string;
  baseText?: string;
  baseUpdatedAt?: string | null;
  savedAt?: string;
  error?: string | null;
}): StoredDraft {
  if (typeof input.text !== "string") {
    throw new AppError("متن پیش‌نویس معتبر نیست.", 400, "invalid_draft");
  }
  if (input.text.length > MAX_TEXT || (input.baseText?.length ?? 0) > MAX_TEXT) {
    throw new AppError("حجم پیش‌نویس از سقف مجاز بیشتر است.", 413, "draft_too_large");
  }
  const target = fileFor(input.sceneId);
  ensureDir();
  const draft: StoredDraft = {
    sceneId: input.sceneId,
    text: input.text,
    baseText: input.baseText ?? "",
    baseUpdatedAt: input.baseUpdatedAt ?? null,
    savedAt: input.savedAt ?? nowIso(),
    error: input.error ?? null,
  };
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(draft), { mode: 0o600 });
  fs.renameSync(tmp, target);
  return draft;
}

export function deleteStoredDraft(sceneId: string): void {
  try {
    fs.unlinkSync(fileFor(sceneId));
  } catch {
    /* نبودِ فایل یعنی پیش‌نویسی نیست */
  }
}
