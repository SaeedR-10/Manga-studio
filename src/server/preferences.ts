import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./db";
import { AppError } from "./http";

/**
 * ترجیحات ظاهری کاربر (پوسته، عرض پنل‌ها، اندازهٔ متن).
 *
 * در پوشهٔ دادهٔ کاربر نگه‌داری می‌شود تا با تغییر پورت یا اجرای دوباره از
 * دست نرود؛ `localStorage` به مبدأ و پورت گره خورده و برای این کار کافی نیست.
 */

export interface Preferences {
  language: "fa" | "en";
  theme: "system" | "light" | "dark";
  navCollapsed: boolean;
  navWidth: number;
  inspectorWidth: number;
  editorFontSize: number;
  editorLineHeight: number;
  readingWidth: number;
}

export const DEFAULT_PREFERENCES: Preferences = {
  language: "fa",
  theme: "system",
  navCollapsed: false,
  navWidth: 248,
  inspectorWidth: 320,
  editorFontSize: 18,
  editorLineHeight: 2,
  readingWidth: 68,
};

const file = path.join(DATA_DIR, "preferences.json");

const LIMITS: Record<keyof Preferences, { min: number; max: number }> = {
  language: { min: 0, max: 0 },
  theme: { min: 0, max: 0 },
  navCollapsed: { min: 0, max: 0 },
  navWidth: { min: 190, max: 360 },
  inspectorWidth: { min: 260, max: 480 },
  editorFontSize: { min: 14, max: 30 },
  editorLineHeight: { min: 1.4, max: 2.6 },
  readingWidth: { min: 46, max: 96 },
};

export function readPreferences(): Preferences {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Preferences>;
    return sanitize({ ...DEFAULT_PREFERENCES, ...raw });
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function writePreferences(patch: Partial<Preferences>): Preferences {
  const next = sanitize({ ...readPreferences(), ...patch });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return next;
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitize(input: Preferences): Preferences {
  if (!["fa", "en"].includes(input.language)) input.language = "fa";
  if (!["system", "light", "dark"].includes(input.theme)) input.theme = DEFAULT_PREFERENCES.theme;
  if (typeof input.navCollapsed !== "boolean") input.navCollapsed = DEFAULT_PREFERENCES.navCollapsed;
  for (const key of ["navWidth", "inspectorWidth", "editorFontSize", "editorLineHeight", "readingWidth"] as const) {
    input[key] = clamp(input[key], DEFAULT_PREFERENCES[key], LIMITS[key].min, LIMITS[key].max);
  }
  input.editorLineHeight = Math.round(input.editorLineHeight * 10) / 10;
  return input;
}

export function assertWritablePreferences(input: unknown): Partial<Preferences> {
  if (!input || typeof input !== "object") throw new AppError("ترجیحات معتبر نیست.", 400, "invalid_preferences");
  return input as Partial<Preferences>;
}
