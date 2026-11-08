import { beforeEach, describe, expect, it, vi } from "vitest";
import { SceneSaveCoordinator } from "@/lib/sceneSave";
import { clearDraft, readDraft, writeDraft } from "@/lib/drafts";
import { HttpError } from "@/lib/api";

beforeEach(() => {
  // کش پیش‌نویس بین آزمون‌ها پاک می‌شود؛ نوشتن روی دیسک در این آزمون‌ها
  // شبیه‌سازی نمی‌شود و رفتار هماهنگ‌کننده سنجیده می‌شود.
  for (const id of ["scene-1", "scene-9", "scene-a", "scene-b", "scene-7", "scene-x"]) clearDraft(id);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function staleError(serverText: string, serverUpdatedAt: string) {
  return new HttpError(409, {
    message: "این صحنه پس از شروع ویرایش شما تغییر کرده است.",
    code: "stale_write",
    details: { serverText, serverUpdatedAt },
  });
}

describe("پایداری نوشتن: پیش‌نویس، ترتیب و پاسخ دیررس", () => {
  it("پاسخ دیررس متن قدیمی، وضعیت «ذخیره شد» متن تازه‌تر را جعل نمی‌کند", async () => {
    const first = deferred<{ text: string }>();
    const second = deferred<{ text: string }>();
    const calls: string[] = [];
    const save = vi.fn(async (text: string) => {
      calls.push(text);
      return text === "نسخهٔ یک" ? first.promise : second.promise;
    });
    const coordinator = new SceneSaveCoordinator(save);
    coordinator.open("scene-1", "متن پایه");
    coordinator.setText("نسخهٔ یک");
    const p1 = coordinator.flush("autosave");
    coordinator.setText("نسخهٔ دو");
    const p2 = coordinator.flush("autosave");

    await tick();
    // درخواست دوم تا پایان اولی ارسال نمی‌شود (سریالی).
    expect(calls).toEqual(["نسخهٔ یک"]);
    first.resolve({ text: "نسخهٔ یک" });
    await tick();
    expect(coordinator.snapshot().status).not.toBe("saved");
    expect(coordinator.snapshot().text).toBe("نسخهٔ دو");
    expect(calls).toEqual(["نسخهٔ یک", "نسخهٔ دو"]);
    second.resolve({ text: "نسخهٔ دو" });
    await Promise.all([p1, p2]);
    expect(coordinator.snapshot().status).toBe("saved");
    expect(coordinator.snapshot().ack).toBe("نسخهٔ دو");
    expect(coordinator.snapshot().dirty).toBe(false);
  });

  it("هر کار ذخیره مقصد ثابت خودش را می‌گیرد؛ عوض‌شدن صحنه، مقصد کار در صف را عوض نمی‌کند", async () => {
    const pending = deferred<{ text: string }>();
    const targets: string[] = [];
    const writes: Array<{ scene: string; text: string }> = [];
    const coordinator = new SceneSaveCoordinator(async (text, _reason, target) => {
      targets.push(target.sceneId);
      await pending.promise;
      writes.push({ scene: target.sceneId, text });
      return { text };
    });
    coordinator.open("scene-a", "قدیمی الف");
    coordinator.setText("تازهٔ الف");
    const saving = coordinator.flush();

    // کاربر به صحنهٔ B می‌رود و متن آن را هم ویرایش می‌کند.
    coordinator.open("scene-b", "قدیمی ب");
    expect(coordinator.snapshot().text).toBe("قدیمی ب");
    coordinator.setText("تازهٔ ب");

    pending.resolve({ text: "تازهٔ الف" });
    await saving;

    expect(targets).toEqual(["scene-a"]);
    expect(writes).toEqual([{ scene: "scene-a", text: "تازهٔ الف" }]);
    // وضعیت صحنهٔ جاری دست‌نخورده است و «ذخیره شد» جعل نمی‌شود.
    expect(coordinator.snapshot().sceneId).toBe("scene-b");
    expect(coordinator.snapshot().text).toBe("تازهٔ ب");
    expect(coordinator.snapshot().status).not.toBe("saved");
    // پیش‌نویس صحنهٔ A پس از تأیید سرور پاک شده، ولی پیش‌نویس B سر جایش است.
    expect(readDraft("scene-a")).toBeNull();
    expect(readDraft("scene-b")?.text).toBe("تازهٔ ب");
  });

  it("تأیید رسیده برای نسخهٔ قدیمی، متن تازه‌تر را «ذخیره‌شده» اعلام نمی‌کند", async () => {
    const pending = deferred<{ text: string }>();
    const coordinator = new SceneSaveCoordinator(async () => pending.promise);
    coordinator.open("scene-1", "پایه");
    coordinator.setText("میان");
    const p = coordinator.flush();
    coordinator.setText("پایانی");
    pending.resolve({ text: "میان" });
    await p;
    const state = coordinator.snapshot();
    expect(state.ack).toBe("میان");
    expect(state.text).toBe("پایانی");
    expect(state.dirty).toBe(true);
    expect(state.status).toBe("dirty");
    expect(readDraft("scene-1")?.text).toBe("پایانی");
  });

  it("با خطای ذخیره، متن در پیش‌نویس می‌ماند و در گشودن بعدی بازیابی می‌شود", async () => {
    const coordinator = new SceneSaveCoordinator(async () => {
      throw new Error("شبکه قطع شد");
    });
    coordinator.open("scene-9", "متن سرور");
    coordinator.setText("نوشتهٔ ذخیره‌نشده");
    await coordinator.flush("manual");
    expect(coordinator.snapshot().status).toBe("error");
    expect(readDraft("scene-9")?.text).toBe("نوشتهٔ ذخیره‌نشده");

    const reopened = new SceneSaveCoordinator(async () => ({ text: "" }));
    reopened.open("scene-9", "متن سرور");
    expect(reopened.snapshot().recovered).toBe(true);
    expect(reopened.snapshot().text).toBe("نوشتهٔ ذخیره‌نشده");
  });

  it("پیش‌نویس بازیابی‌شده با نخستین تأیید سرور پاک می‌شود", async () => {
    const coordinator = new SceneSaveCoordinator(async (text) => ({ text }));
    const seed = new SceneSaveCoordinator(async () => ({ text: "" }));
    seed.open("scene-7", "سرور");
    seed.setText("بازیابی من");
    coordinator.open("scene-7", "سرور");
    expect(coordinator.snapshot().recovered).toBe(true);
    await coordinator.flush("manual");
    expect(readDraft("scene-7")).toBeNull();
    expect(coordinator.snapshot().status).toBe("saved");
  });

  it("پیش‌نویس کهنه از نسخهٔ قدیمی‌تر سرور، بی‌صدا بازنویسی نمی‌شود و تصمیم صریح می‌خواهد", () => {
    writeDraft({
      sceneId: "scene-x",
      text: "نسخهٔ کهنهٔ من",
      baseText: "متن قدیمی سرور",
      baseUpdatedAt: "2026-01-01T00:00:00.000Z",
      savedAt: "2026-01-02T00:00:00.000Z",
    });
    const coordinator = new SceneSaveCoordinator(async (text) => ({ text }));
    coordinator.open("scene-x", "متن تازه‌تر سرور", "2026-02-01T00:00:00.000Z");
    const state = coordinator.snapshot();
    expect(state.recovered).toBe(true);
    expect(state.text).toBe("نسخهٔ کهنهٔ من");
    expect(state.conflict?.serverText).toBe("متن تازه‌تر سرور");

    // تا تصمیم کاربر، هیچ نوشتنی انجام نمی‌شود.
    const save = vi.fn(async (text: string) => ({ text }));
    const quiet = new SceneSaveCoordinator(save);
    quiet.open("scene-x", "متن تازه‌تر سرور", "2026-02-01T00:00:00.000Z");
    return quiet.flush().then(() => {
      expect(save).not.toHaveBeenCalled();
    });
  });

  it("انتخاب «متن سرور» پیش‌نویس کهنه را کنار می‌گذارد و انتخاب «نوشتهٔ من» آن را ذخیره می‌کند", async () => {
    writeDraft({
      sceneId: "scene-x",
      text: "نوشتهٔ من",
      baseText: "قدیمی",
      baseUpdatedAt: "2026-01-01T00:00:00.000Z",
      savedAt: "2026-01-02T00:00:00.000Z",
    });
    const server = new SceneSaveCoordinator(async (text) => ({ text }));
    server.open("scene-x", "سرور تازه", "2026-02-01T00:00:00.000Z");
    server.resolveRecovery("server");
    expect(server.snapshot().text).toBe("سرور تازه");
    expect(server.snapshot().conflict).toBeNull();
    expect(readDraft("scene-x")).toBeNull();

    // نوشتن دوباره پیش‌نویس و انتخاب «نوشتهٔ من».
    writeDraft({
      sceneId: "scene-x",
      text: "نوشتهٔ من",
      baseText: "قدیمی",
      baseUpdatedAt: "2026-01-01T00:00:00.000Z",
      savedAt: "2026-01-02T00:00:00.000Z",
    });
    const mine = new SceneSaveCoordinator(async (text) => ({ text }));
    mine.open("scene-x", "سرور تازه", "2026-02-01T00:00:00.000Z");
    mine.resolveRecovery("draft");
    await mine.flush("manual");
    expect(mine.snapshot().ack).toBe("نوشتهٔ من");
    expect(mine.snapshot().status).toBe("saved");
  });

  it("رد شدن ذخیره به‌دلیل تغییر سرور، تفاوت را نشان می‌دهد و با تأیید کاربر بازنویسی می‌کند", async () => {
    let serverText = "سرور";
    const save = vi.fn(async (text: string, _reason: "autosave" | "manual", target) => {
      // سرور بیرون از این پنجره جلو رفته است؛ نسخهٔ مبنا دیگر معتبر نیست.
      if (!target.force) throw staleError(serverText, "v2");
      serverText = text;
      return { text, updatedAt: "v3" };
    });
    const coordinator = new SceneSaveCoordinator(save);
    coordinator.open("scene-1", serverText, "v1");
    coordinator.setText("متن من");
    await coordinator.flush();
    expect(coordinator.snapshot().stale?.serverText).toBe("سرور");
    expect(coordinator.snapshot().status).toBe("error");
    expect(readDraft("scene-1")?.text).toBe("متن من");

    await coordinator.resolveStale("mine");
    expect(coordinator.snapshot().status).toBe("saved");
    expect(serverText).toBe("متن من");
  });
});
