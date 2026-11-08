"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SceneSaveCoordinator,
  type CoordinatorState,
  type DraftConflict,
  type SaveFn,
  type StaleWrite,
} from "@/lib/sceneSave";
import { subscribeDrafts } from "@/lib/drafts";

export type WriterState = CoordinatorState["status"];

export interface UseSceneWriterArgs {
  sceneId: string | null;
  /** متن تأییدشدهٔ سرور (از bundle) */
  serverText: string;
  serverUpdatedAt?: string | null;
  /** ذخیرهٔ واقعی؛ مقصد قفل‌شده را می‌گیرد و متن تأییدشده را برمی‌گرداند */
  save: SaveFn;
  debounceMs?: number;
}

export interface SceneWriter {
  text: string;
  state: WriterState;
  error: string | null;
  /** پیش‌نویس ذخیره‌نشده بازیابی شد */
  recovered: boolean;
  /** پیش‌نویس از نسخهٔ قدیمی‌تر از سرور است؛ تصمیم صریح لازم است */
  conflict: DraftConflict | null;
  /** سرور نوشتن را به‌دلیل تغییر متن رد کرد */
  stale: StaleWrite | null;
  draftSyncError: string | null;
  dirty: boolean;
  updateText: (value: string) => void;
  flush: (reason?: "autosave" | "manual") => Promise<void>;
  markSaved: (text: string, updatedAt?: string | null) => void;
  dismissRecovery: () => void;
  resolveRecovery: (choice: "draft" | "server") => void;
  resolveStale: (choice: "mine" | "server") => Promise<void>;
}

/**
 * پیوند React با هماهنگ‌کنندهٔ ذخیره.
 * همهٔ تصمیم‌های ترتیب/تأیید در `SceneSaveCoordinator` است تا آزمون‌پذیر باشد.
 */
export function useSceneWriter({ sceneId, serverText, serverUpdatedAt = null, save, debounceMs = 1200 }: UseSceneWriterArgs): SceneWriter {
  const saveRef = useRef(save);
  saveRef.current = save;
  const coordinator = useMemo(() => new SceneSaveCoordinator((text, reason, target) => saveRef.current(text, reason, target)), []);
  const [state, setState] = useState<CoordinatorState>(coordinator.snapshot());
  const timerRef = useRef<number | null>(null);

  useEffect(() => coordinator.subscribe(setState), [coordinator]);

  // خطای نوشتن پیش‌نویس هم در همان وضعیت دیده شود، نه فقط در کنسول.
  useEffect(() => subscribeDrafts(() => coordinator.refresh()), [coordinator]);

  useEffect(() => {
    coordinator.open(sceneId, serverText, serverUpdatedAt);
    // عمداً به serverText وابسته نیست؛ تغییر متن سرور در افکت جدا مدیریت می‌شود.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coordinator, sceneId]);

  useEffect(() => {
    coordinator.syncServerText(serverText, serverUpdatedAt);
  }, [coordinator, serverText, serverUpdatedAt]);

  const updateText = useCallback(
    (value: string) => {
      coordinator.setText(value);
    },
    [coordinator],
  );

  const flush = useCallback(
    (reason: "autosave" | "manual" = "autosave") => coordinator.flush(reason),
    [coordinator],
  );

  // debounce واقعی: هر کلید تایمر قبلی را بازنشانی می‌کند.
  useEffect(() => {
    if (!sceneId) return;
    if (!state.dirty) return;
    if (state.conflict) return; // تا تصمیم کاربر هیچ نوشتنی نمی‌شود
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void coordinator.flush("autosave");
    }, debounceMs);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [state.text, state.dirty, state.conflict, sceneId, debounceMs, coordinator]);

  // آخرین فرصت: رفتن به نمای دیگر یا بسته‌شدن پنجره، متن بدون تأیید را از دست نمی‌دهد.
  useEffect(() => {
    if (!sceneId) return;
    const onHide = () => {
      const snapshot = coordinator.snapshot();
      if (snapshot.dirty && !snapshot.conflict) void coordinator.flush("autosave");
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onHide);
      onHide();
    };
  }, [sceneId, coordinator]);

  return {
    text: state.text,
    state: state.status,
    error: state.error,
    recovered: state.recovered,
    conflict: state.conflict,
    stale: state.stale,
    draftSyncError: state.draftSyncError,
    dirty: state.dirty,
    updateText,
    flush,
    markSaved: useCallback((text: string, updatedAt?: string | null) => coordinator.markSaved(text, updatedAt ?? null), [coordinator]),
    dismissRecovery: useCallback(() => coordinator.dismissRecovery(), [coordinator]),
    resolveRecovery: useCallback((choice: "draft" | "server") => coordinator.resolveRecovery(choice), [coordinator]),
    resolveStale: useCallback((choice: "mine" | "server") => coordinator.resolveStale(choice), [coordinator]),
  };
}
