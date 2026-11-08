import { clearDraft, draftSyncState, enqueueSave, readDraft, writeDraft } from "@/lib/drafts";

export type WriterStatus = "idle" | "dirty" | "saving" | "saved" | "error";

/**
 * مقصد هر ذخیره، هنگام ساخت کار قفل می‌شود.
 *
 * صحنه و نسخهٔ مبنای سرور بخشی از خودِ کارند، نه چیزی که لحظهٔ اجرای callback
 * از state فعلی خوانده شود. بنابراین تغییر صحنه یا نمای جاری هرگز باعث
 * نوشتن متن یک صحنه روی صحنهٔ دیگر نمی‌شود.
 */
export interface SaveTarget {
  sceneId: string;
  /** متنی که سرور پیش از این ذخیره تأیید کرده بود */
  baseText: string;
  baseUpdatedAt: string | null;
  /** نوشتن با وجود تغییر سرور، فقط با تصمیم صریح کاربر */
  force: boolean;
}

export interface SaveOutcome {
  text: string;
  updatedAt?: string | null;
}

export type SaveFn = (text: string, reason: "autosave" | "manual", target: SaveTarget) => Promise<SaveOutcome>;

export interface DraftConflict {
  /** متن پیش‌نویس محلی */
  draftText: string;
  /** متنی که همین حالا روی سرور است */
  serverText: string;
}

export interface StaleWrite {
  serverText: string;
  serverUpdatedAt: string | null;
}

export interface CoordinatorState {
  sceneId: string | null;
  text: string;
  /** متنی که سرور تأیید کرده است */
  ack: string;
  ackUpdatedAt: string | null;
  status: WriterStatus;
  error: string | null;
  recovered: boolean;
  /** پیش‌نویس از نسخه‌ای قدیمی‌تر از سرور است: تصمیم صریح لازم است */
  conflict: DraftConflict | null;
  /** سرور درخواست را به‌دلیل تغییر متن رد کرد */
  stale: StaleWrite | null;
  dirty: boolean;
  /** خطای نوشتن پیش‌نویس روی دیسک (پنهان نمی‌شود) */
  draftSyncError: string | null;
}

function emptyState(sceneId: string | null, text: string): CoordinatorState {
  return {
    sceneId,
    text,
    ack: text,
    ackUpdatedAt: null,
    status: "idle",
    error: null,
    recovered: false,
    conflict: null,
    stale: null,
    dirty: false,
    draftSyncError: draftSyncState().error,
  };
}

function staleFromError(error: unknown): StaleWrite | null {
  if (!error || typeof error !== "object") return null;
  const info = (error as { info?: { code?: string; details?: unknown } }).info;
  if (!info || info.code !== "stale_write") return null;
  const details = info.details as { serverText?: unknown; serverUpdatedAt?: unknown } | undefined;
  if (!details || typeof details.serverText !== "string") return null;
  return {
    serverText: details.serverText,
    serverUpdatedAt: typeof details.serverUpdatedAt === "string" ? details.serverUpdatedAt : null,
  };
}

/**
 * هماهنگ‌کنندهٔ ذخیرهٔ صحنه — مستقل از React تا رفتارش مستقیم آزمون شود.
 *
 * قواعد:
 *  - هر کار ذخیره مقصد ثابت خودش را دارد؛ پاسخ دیررس هرگز صحنهٔ دیگر را
 *    تغییر نمی‌دهد و ack تازه‌تر را بازنویسی نمی‌کند.
 *  - ذخیره‌ها برای هر صحنه در سطح ماژول سریالی‌اند، پس بازسازی/رفتن به نمای
 *    دیگر ترتیب را نمی‌شکند.
 *  - «ذخیره شد» فقط وقتی اعلام می‌شود که پاسخ سرور همان آخرین متن باشد.
 *  - پیش‌نویس هر تغییر بی‌درنگ روی دیسک (از مسیر API) نوشته می‌شود.
 *  - تعارض با نسخهٔ سرور یا رد شدن به‌خاطر تغییر سرور، تا تصمیم صریح کاربر
 *    چیزی را بازنویسی نمی‌کند.
 */
export class SceneSaveCoordinator {
  private state: CoordinatorState = emptyState(null, "");
  private listeners = new Set<(state: CoordinatorState) => void>();
  private seq = 0;
  private pendingText: string | null = null;

  constructor(private saveFn: SaveFn) {}

  subscribe(listener: (state: CoordinatorState) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): CoordinatorState {
    return { ...this.state, draftSyncError: draftSyncState().error };
  }

  /** برای بازتاب وضعیت همگام‌سازی پیش‌نویس بدون تغییر داده. */
  refresh(): void {
    this.publish();
  }

  private publish(): void {
    this.state.dirty = this.state.text !== this.state.ack;
    const snap = this.snapshot();
    for (const listener of this.listeners) listener(snap);
  }

  private patch(next: Partial<CoordinatorState>): void {
    this.state = { ...this.state, ...next };
    this.publish();
  }

  /** گشودن صحنه: پیش‌نویس پایدار بر متن سرور مقدم است، چون کارِ کاربر است. */
  open(sceneId: string | null, serverText: string, serverUpdatedAt: string | null = null): void {
    this.seq += 1; // پاسخ‌های در جریان صحنهٔ قبلی بی‌اعتبار می‌شوند
    this.pendingText = null;
    if (!sceneId) {
      this.state = { ...emptyState(null, serverText), draftSyncError: draftSyncState().error };
      this.publish();
      return;
    }
    const draft = readDraft(sceneId);
    const differs = Boolean(draft && draft.text !== serverText);
    if (!differs) {
      if (draft) clearDraft(sceneId);
      this.state = {
        ...emptyState(sceneId, serverText),
        ackUpdatedAt: serverUpdatedAt,
        draftSyncError: draftSyncState().error,
      };
      this.publish();
      return;
    }
    /*
     * آیا پیش‌نویس بر پایهٔ نسخهٔ قدیمی‌تری از سرور ساخته شده؟ اگر بله، متن
     * سرور تازه‌تر است و پیش‌نویس نباید بی‌صدا آن را بازنویسی کند. کاربر پیش‌نویس
     * را می‌بیند، تفاوت را مقایسه می‌کند و خودش تصمیم می‌گیرد.
     */
    const baseMoved = draft!.baseText !== serverText || (Boolean(draft!.baseUpdatedAt) && draft!.baseUpdatedAt !== serverUpdatedAt);
    this.state = {
      sceneId,
      text: draft!.text,
      ack: serverText,
      ackUpdatedAt: serverUpdatedAt,
      status: baseMoved ? "idle" : "dirty",
      error: baseMoved ? null : draft!.error ?? null,
      recovered: true,
      conflict: baseMoved ? { draftText: draft!.text, serverText } : null,
      stale: null,
      dirty: draft!.text !== serverText,
      draftSyncError: draftSyncState().error,
    };
    this.publish();
  }

  setText(text: string): void {
    const sceneId = this.state.sceneId;
    if (!sceneId) {
      this.patch({ text, dirty: text !== this.state.ack });
      return;
    }
    if (text === this.state.ack) clearDraft(sceneId);
    else
      writeDraft({
        sceneId,
        text,
        baseText: this.state.ack,
        baseUpdatedAt: this.state.ackUpdatedAt,
        savedAt: new Date().toISOString(),
        error: this.state.error,
      });
    this.patch({ text, status: text === this.state.ack ? "idle" : "dirty", stale: null });
  }

  /** به‌روزرسانی متن سرور در حالی که ویرایش محلی وجود ندارد. */
  syncServerText(serverText: string, serverUpdatedAt: string | null = null): void {
    if (this.state.text !== this.state.ack) return;
    if (serverText === this.state.ack) {
      if (serverUpdatedAt !== this.state.ackUpdatedAt) this.patch({ ackUpdatedAt: serverUpdatedAt });
      return;
    }
    if (this.state.sceneId) clearDraft(this.state.sceneId);
    this.patch({ text: serverText, ack: serverText, ackUpdatedAt: serverUpdatedAt, status: "idle", dirty: false });
  }

  dismissRecovery(): void {
    this.patch({ recovered: false });
  }

  /**
   * تصمیم صریح دربارهٔ پیش‌نویس قدیمی.
   *  - "draft": نوشتهٔ من بماند و ذخیره شود (سرور بازنویسی می‌شود، نسخهٔ قبلی در تاریخچه می‌ماند).
   *  - "server": متن سرور مرجع باشد و پیش‌نویس قدیمی کنار گذاشته شود.
   */
  resolveRecovery(choice: "draft" | "server"): void {
    if (!this.state.conflict) return;
    if (choice === "server") {
      const text = this.state.conflict.serverText;
      if (this.state.sceneId) clearDraft(this.state.sceneId);
      this.patch({ text, ack: text, status: "idle", recovered: false, conflict: null, stale: null, error: null });
      return;
    }
    this.patch({ conflict: null, status: "dirty" });
  }

  /** بازیابی از رد شدن ذخیره به‌دلیل تغییر متن سرور. */
  resolveStale(choice: "mine" | "server"): Promise<void> {
    if (!this.state.stale) return Promise.resolve();
    if (choice === "server") {
      const text = this.state.stale.serverText;
      if (this.state.sceneId) clearDraft(this.state.sceneId);
      this.patch({
        text,
        ack: text,
        ackUpdatedAt: this.state.stale.serverUpdatedAt,
        status: "idle",
        stale: null,
        error: null,
        recovered: false,
      });
      return Promise.resolve();
    }
    this.patch({ stale: null });
    return this.flush("manual", { force: true });
  }

  markSaved(text: string, updatedAt: string | null = null): void {
    this.seq += 1;
    this.pendingText = null;
    if (this.state.sceneId) clearDraft(this.state.sceneId);
    this.patch({
      text,
      ack: text,
      ackUpdatedAt: updatedAt ?? this.state.ackUpdatedAt,
      status: "saved",
      error: null,
      dirty: false,
      recovered: false,
      conflict: null,
      stale: null,
    });
  }

  flush(reason: "autosave" | "manual" = "autosave", options: { force?: boolean } = {}): Promise<void> {
    const sceneId = this.state.sceneId;
    if (!sceneId) return Promise.resolve();
    if (this.state.conflict) return Promise.resolve();
    const value = this.state.text;
    if (value === this.state.ack && !options.force) return Promise.resolve();
    if (value === this.pendingText && !options.force) return Promise.resolve();

    // مقصد همین‌جا قفل می‌شود؛ callback دیگر به state جاری وابسته نیست.
    const target: SaveTarget = {
      sceneId,
      baseText: this.state.ack,
      baseUpdatedAt: this.state.ackUpdatedAt,
      force: Boolean(options.force),
    };
    this.pendingText = value;
    const mySeq = ++this.seq;
    this.patch({ status: "saving", error: null });

    const run = async () => {
      try {
        const result = await this.saveFn(value, reason, target);
        if (this.state.sceneId === target.sceneId && this.seq === mySeq) {
          this.pendingText = null;
          if (this.state.text === result.text) {
            clearDraft(target.sceneId);
            this.patch({
              ack: result.text,
              ackUpdatedAt: result.updatedAt ?? target.baseUpdatedAt,
              status: "saved",
              error: null,
              stale: null,
            });
          } else {
            this.patch({
              ack: result.text,
              ackUpdatedAt: result.updatedAt ?? target.baseUpdatedAt,
              status: "dirty",
            });
            writeDraft({
              sceneId: target.sceneId,
              text: this.state.text,
              baseText: result.text,
              baseUpdatedAt: result.updatedAt ?? target.baseUpdatedAt,
              savedAt: new Date().toISOString(),
              error: null,
            });
          }
        } else {
          const leftover = readDraft(target.sceneId);
          // پاسخ برای صحنه‌ای است که دیگر باز نیست: پیش‌نویس همان صحنه پاک می‌شود.
          if (leftover?.text === value) clearDraft(target.sceneId);
        }
      } catch (error) {
        const stale = staleFromError(error);
        const message = error instanceof Error ? error.message : "ذخیره نشد.";
        if (this.state.sceneId === target.sceneId && this.seq === mySeq) {
          this.pendingText = null;
          writeDraft({
            sceneId: target.sceneId,
            text: this.state.text,
            baseText: this.state.ack,
            baseUpdatedAt: this.state.ackUpdatedAt,
            savedAt: new Date().toISOString(),
            error: message,
          });
          this.patch({ status: "error", error: message, stale });
        } else {
          // صحنه دیگر باز نیست؛ پیش‌نویس همان صحنه با خطا نگه داشته می‌شود.
          writeDraft({
            sceneId: target.sceneId,
            text: value,
            baseText: target.baseText,
            baseUpdatedAt: target.baseUpdatedAt,
            savedAt: new Date().toISOString(),
            error: message,
          });
        }
      }
    };

    return enqueueSave(sceneId, run);
  }
}
