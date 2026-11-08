/**
 * پیش‌نویس پایدار صحنه — بیرون از حافظهٔ مبدأ مرورگر.
 *
 * پنجرهٔ دسکتاپ هر اجرا روی یک پورت تصادفی سرو می‌شود و `localStorage` به
 * مبدأ (شامل پورت) گره خورده است؛ بنابراین تنها راه بازیابی پس از اجرای
 * دوباره، نگه‌داری پیش‌نویس در پوشهٔ دادهٔ کاربر از مسیر API هم‌مبدأ است.
 *
 * طرح:
 *  - یک کش درون‌حافظه‌ای که همگام خوانده می‌شود (رابط نیازی به انتظار ندارد).
 *  - هر نوشتن/پاک‌کردن، صف‌شده به سرور می‌رود؛ خطای نوشتن پنهان نمی‌شود.
 *  - پیش‌نویس‌های قدیمی `localStorage` یک بار به سرور مهاجرت می‌کنند و تا
 *    موفقیت مهاجرت حذف نمی‌شوند (کار کاربر دور ریخته نمی‌شود).
 */

export interface SceneDraft {
  sceneId: string;
  /** متنی که کاربر نوشته و هنوز تأیید سرور را ندارد */
  text: string;
  /** متنی که در لحظهٔ آغاز ویرایش روی سرور بود */
  baseText: string;
  baseUpdatedAt: string | null;
  savedAt: string;
  /** آخرین خطای ذخیره؛ پیش‌نویس حتی با خطا بازیابی می‌شود */
  error?: string | null;
}

export interface DraftSyncState {
  hydrated: boolean;
  pending: number;
  error: string | null;
}

const PREFIX = "ravayat:draft:";
const cache = new Map<string, SceneDraft>();
const queues = new Map<string, Promise<unknown>>();
const listeners = new Set<() => void>();
let hydrated = false;
let hydratePromise: Promise<void> | null = null;
let syncState: DraftSyncState = { hydrated: false, pending: 0, error: null };

export function subscribeDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function draftSyncState(): DraftSyncState {
  return { ...syncState };
}

function emit(): void {
  syncState = { ...syncState, hydrated };
  for (const listener of listeners) listener();
}

function setError(message: string | null): void {
  if (syncState.error === message) return;
  syncState = { ...syncState, error: message };
  emit();
}

/** صف ذخیرهٔ هر صحنه؛ ترتیب ارسال حفظ می‌شود و درخواست‌ها روی هم نمی‌افتند. */
export function enqueueSave<T>(sceneId: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(sceneId) ?? Promise.resolve();
  const next = previous.then(task, task) as Promise<T>;
  queues.set(
    sceneId,
    next.catch(() => undefined),
  );
  return next;
}

function legacyStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

async function pushRemote(draft: SceneDraft): Promise<void> {
  syncState = { ...syncState, pending: syncState.pending + 1 };
  emit();
  try {
    const res = await fetch(`/api/drafts/${encodeURIComponent(draft.sceneId)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: draft.text,
        baseText: draft.baseText,
        baseUpdatedAt: draft.baseUpdatedAt,
        savedAt: draft.savedAt,
        error: draft.error ?? null,
      }),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`پیش‌نویس روی دیسک ذخیره نشد (${res.status}).`);
    setError(null);
  } catch (error) {
    setError(error instanceof Error ? error.message : "ذخیرهٔ پیش‌نویس روی دیسک ناموفق بود.");
    throw error;
  } finally {
    syncState = { ...syncState, pending: Math.max(0, syncState.pending - 1) };
    emit();
  }
}

async function deleteRemote(sceneId: string): Promise<void> {
  try {
    const res = await fetch(`/api/drafts/${encodeURIComponent(sceneId)}`, { method: "DELETE", cache: "no-store" });
    if (!res.ok) throw new Error(`پاک‌کردن پیش‌نویس ناموفق بود (${res.status}).`);
    setError(null);
  } catch (error) {
    setError(error instanceof Error ? error.message : "پاک‌کردن پیش‌نویس ناموفق بود.");
    throw error;
  }
}

function readLegacy(): SceneDraft[] {
  const store = legacyStorage();
  if (!store) return [];
  const out: SceneDraft[] = [];
  try {
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      try {
        const parsed = JSON.parse(store.getItem(key) ?? "") as SceneDraft;
        if (parsed && typeof parsed.text === "string" && parsed.sceneId) out.push(parsed);
      } catch {
        /* یک ورودی خراب مانع بقیه نمی‌شود */
      }
    }
  } catch {
    return out;
  }
  return out;
}

function forgetLegacy(sceneId: string): void {
  const store = legacyStorage();
  try {
    store?.removeItem(`${PREFIX}${sceneId}`);
  } catch {
    /* ignore */
  }
}

function adoptLegacy(): void {
  for (const draft of readLegacy()) {
    const existing = cache.get(draft.sceneId);
    if (existing && existing.savedAt >= draft.savedAt) {
      forgetLegacy(draft.sceneId);
      continue;
    }
    cache.set(draft.sceneId, draft);
    void enqueueSave(draft.sceneId, async () => {
      await pushRemote(draft);
      forgetLegacy(draft.sceneId);
    }).catch(() => undefined);
  }
}

/**
 * خواندن همهٔ پیش‌نویس‌ها از پوشهٔ دادهٔ کاربر و مهاجرت پیش‌نویس‌های مبدأ قبلی.
 * تا پایان این خواندن، صحنه‌ای باز نمی‌شود تا پیش‌نویسِ قدیمی بی‌صدا نادیده نماند.
 */
export async function hydrateDrafts(): Promise<void> {
  if (hydrated) return;
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    try {
      const res = await fetch("/api/drafts", { cache: "no-store" });
      if (!res.ok) throw new Error(`خواندن پیش‌نویس‌ها ناموفق بود (${res.status}).`);
      const data = (await res.json()) as { drafts?: SceneDraft[] };
      for (const draft of data.drafts ?? []) {
        if (!draft || typeof draft.text !== "string") continue;
        const existing = cache.get(draft.sceneId);
        if (!existing || existing.savedAt <= draft.savedAt) cache.set(draft.sceneId, draft);
      }
      setError(null);
    } catch (error) {
      // بدون سرور، دست‌کم پیش‌نویس‌های محلی همین مبدأ از دست نمی‌روند.
      for (const draft of readLegacy()) if (!cache.has(draft.sceneId)) cache.set(draft.sceneId, draft);
      setError(error instanceof Error ? error.message : "خواندن پیش‌نویس‌ها ناموفق بود.");
    } finally {
      adoptLegacy();
      hydrated = true;
      emit();
    }
  })();
  return hydratePromise;
}

export function readDraft(sceneId: string): SceneDraft | null {
  const found = cache.get(sceneId);
  return found ? { ...found } : null;
}

export function writeDraft(draft: SceneDraft): void {
  cache.set(draft.sceneId, draft);
  void enqueueSave(draft.sceneId, () => pushRemote(draft)).catch(() => undefined);
}

export function clearDraft(sceneId: string): void {
  cache.delete(sceneId);
  forgetLegacy(sceneId);
  void enqueueSave(sceneId, () => deleteRemote(sceneId)).catch(() => undefined);
}

/** برای نمایش «پیش‌نویس‌های بازیابی‌نشده» در فهرست پروژه. */
export function listDraftSceneIds(): string[] {
  return [...cache.keys()];
}

export function listDrafts(): SceneDraft[] {
  return [...cache.values()].map((draft) => ({ ...draft }));
}

/** تلاش دوباره برای پیش‌نویس‌هایی که نوشتنشان ناموفق مانده بود. */
export async function retryDraftSync(): Promise<void> {
  for (const draft of [...cache.values()]) {
    await enqueueSave(draft.sceneId, () => pushRemote(draft)).catch(() => undefined);
  }
}
