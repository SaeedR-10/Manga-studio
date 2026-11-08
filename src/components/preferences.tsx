"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";

/**
 * ترجیحات ظاهری، از پوشهٔ دادهٔ کاربر (نه localStorage).
 * بنابراین با تغییر پورت یا اجرای دوباره، پوسته و اندازه‌ها می‌مانند.
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

interface PreferencesContextValue {
  preferences: Preferences;
  setPreference: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
  theme: "light" | "dark";
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

export function usePreferences(): PreferencesContextValue {
  const ctx = useContext(PreferencesContext);
  if (!ctx) throw new Error("Preferences context missing");
  return ctx;
}

/** پوستهٔ مؤثر: system با ترجیح سیستم‌عامل حل می‌شود. */
function resolveTheme(theme: Preferences["theme"]): "light" | "dark" {
  if (theme === "light" || theme === "dark") return theme;
  if (typeof window === "undefined") return "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function PreferencesProvider({ children }: { children: React.ReactNode }) {
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES);
  const [systemDark, setSystemDark] = useState(false);
  const timer = useRef<number | null>(null);
  const pending = useRef<Partial<Preferences>>({});

  useEffect(() => {
    let cancelled = false;
    void api<{ preferences: Preferences }>("/api/preferences")
      .then((data) => {
        if (!cancelled && data.preferences) setPreferences({ ...DEFAULT_PREFERENCES, ...data.preferences });
      })
      .catch(() => undefined);
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (media) {
      setSystemDark(media.matches);
      const handler = (event: MediaQueryListEvent) => setSystemDark(event.matches);
      media.addEventListener("change", handler);
      return () => {
        cancelled = true;
        media.removeEventListener("change", handler);
      };
    }
    return () => {
      cancelled = true;
    };
  }, []);

  const effective = preferences.theme === "system" ? (systemDark ? "dark" : "light") : resolveTheme(preferences.theme);

  useEffect(() => {
    document.documentElement.lang = preferences.language;
    document.documentElement.dataset.language = preferences.language;
    document.documentElement.dir = preferences.language === "en" ? "ltr" : "rtl";
    document.documentElement.dataset.theme = effective;
    document.documentElement.style.colorScheme = effective;
  }, [effective, preferences.language]);

  const flush = useCallback(() => {
    const patch = pending.current;
    pending.current = {};
    if (Object.keys(patch).length === 0) return;
    void api("/api/preferences", { method: "PUT", json: patch }).catch(() => undefined);
  }, []);

  const setPreference = useCallback(
    <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
      setPreferences((current) => ({ ...current, [key]: value }));
      pending.current = { ...pending.current, [key]: value };
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        flush();
      }, 450);
    },
    [flush],
  );

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
      flush();
    },
    [flush],
  );

  const value = useMemo<PreferencesContextValue>(
    () => ({ preferences, setPreference, theme: effective }),
    [preferences, setPreference, effective],
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function LanguageToggle() {
  const { preferences, setPreference } = usePreferences();
  const english = preferences.language === "en";
  return <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPreference("language", english ? "fa" : "en")} aria-label={english ? "Switch to Persian" : "Switch to English"}>{english ? "فارسی" : "English"}</button>;
}

/** کلید پوسته: سه حالت روشن/تاریک/سیستم، با برچسب متنی. */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { preferences, setPreference, theme } = usePreferences();
  const next: Preferences["theme"] = preferences.theme === "system" ? "light" : preferences.theme === "light" ? "dark" : "system";
  const label = preferences.theme === "system" ? `پوسته: سیستم (${theme === "dark" ? "تاریک" : "روشن"})` : preferences.theme === "light" ? "پوسته: روشن" : "پوسته: تاریک";
  return (
    <button
      type="button"
      className={`iconbtn ${compact ? "iconbtn-compact" : ""}`}
      onClick={() => setPreference("theme", next)}
      title={`${label} — برای تغییر کلیک کنید`}
      aria-label={label}
    >
      <span aria-hidden>{preferences.theme === "system" ? "◐" : preferences.theme === "light" ? "☀" : "☾"}</span>
      {compact ? null : <span className="small">{label}</span>}
    </button>
  );
}
