import { AppError } from "./http";

/**
 * خزانهٔ کلید API.
 *
 * کلید فقط در Windows Credential Manager (یا Keychain/libsecret روی سیستم‌های
 * دیگر) ذخیره می‌شود. هیچ‌گاه در SQLite، فایل پروژه، localStorage، خروجی یا
 * لاگ نوشته نمی‌شود. اگر خزانهٔ سیستم در دسترس نباشد، کلید فقط تا پایان
 * اجرای برنامه در حافظهٔ همین فرایند سرویس‌دهنده می‌ماند و رابط کاربر این را
 * صریح نشان می‌دهد. هیچ رمزنگاری دست‌سازی در این ماژول نیست.
 *
 * تابع خواندن کلید فقط برای لایهٔ ارائه‌دهنده است و در پاسخ‌های API استفاده
 * نمی‌شود؛ رابط کاربر تنها وضعیت «تنظیم شده / نشده» را می‌بیند.
 */

export type SecretStoreMode = "credential_manager" | "session_memory" | "unavailable";

const SERVICE = "RavayatStudio";
const PROVIDERS = ["openai", "google"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

const sessionKeys = new Map<ProviderId, string>();
let mode: SecretStoreMode | null = null;
let modeNote = "";

interface KeyringEntry {
  setPassword(value: string): void;
  getPassword(): string | null;
  deletePassword(): boolean;
}

interface KeyringModule {
  Entry: new (service: string, username: string) => KeyringEntry;
}

let keyring: KeyringModule | null | undefined;

function loadKeyring(): KeyringModule | null {
  if (keyring !== undefined) return keyring;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@napi-rs/keyring") as KeyringModule;
    keyring = mod;
  } catch {
    keyring = null;
  }
  return keyring;
}

function entry(provider: ProviderId): KeyringEntry | null {
  if (process.env.RAVAYAT_DISABLE_KEYRING === "1") return null;
  const mod = loadKeyring();
  if (!mod) return null;
  try {
    return new mod.Entry(SERVICE, provider);
  } catch {
    return null;
  }
}

export function secretStoreStatus(): { mode: SecretStoreMode; note: string; providers: ProviderId[] } {
  if (!mode) {
    try {
      const e = entry("openai");
      if (e) {
        mode = "credential_manager";
        modeNote = "کلید در خزانهٔ امن سیستم (Windows Credential Manager) نگه‌داری می‌شود.";
      } else {
        mode = "session_memory";
        modeNote =
          "خزانهٔ امن سیستم در دسترس نیست؛ کلید فقط تا بستن برنامه در حافظه می‌ماند و ذخیره نمی‌شود.";
      }
    } catch {
      mode = "unavailable";
      modeNote = "دسترسی به خزانهٔ امن سیستم ممکن نشد؛ ذخیرهٔ کلید غیرفعال است.";
    }
  }
  return { mode: mode!, note: modeNote, providers: [...PROVIDERS] };
}

export function setApiKey(provider: ProviderId, value: string): SecretStoreMode {
  const key = value.trim();
  if (!key) throw new AppError("کلید خالی است.", 400, "empty_key");
  if (key.length > 4096) throw new AppError("کلید بیش از حد بلند است.", 400, "invalid_key");
  const status = secretStoreStatus();
  const e = entry(provider);
  if (e) {
    try {
      e.setPassword(key);
      sessionKeys.set(provider, key);
      mode = "credential_manager";
      return mode;
    } catch {
      // افتادن به حافظهٔ نشست، به‌جای ذخیرهٔ ناامن
    }
  }
  sessionKeys.set(provider, key);
  mode = status.mode === "unavailable" ? "unavailable" : "session_memory";
  modeNote = "کلید فقط در حافظهٔ این اجرا نگه‌داری می‌شود و پس از بستن برنامه پاک خواهد شد.";
  return mode;
}

export function getApiKey(provider: ProviderId): string | null {
  const cached = sessionKeys.get(provider);
  if (cached) return cached;
  const e = entry(provider);
  if (!e) return null;
  try {
    const value = e.getPassword();
    if (value) sessionKeys.set(provider, value);
    return value ?? null;
  } catch {
    return null;
  }
}

export function hasApiKey(provider: ProviderId): boolean {
  const key = getApiKey(provider);
  return Boolean(key && key.length > 0);
}

export function deleteApiKey(provider: ProviderId): void {
  sessionKeys.delete(provider);
  const e = entry(provider);
  if (!e) return;
  try {
    e.deletePassword();
  } catch {
    throw new AppError("حذف کلید از خزانهٔ سیستم ناموفق بود.", 500, "key_delete_failed");
  }
}

export function maskKey(key: string): string {
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 3)}••••${key.slice(-2)}`;
}
