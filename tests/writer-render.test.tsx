// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSceneWriter, type SceneWriter } from "@/lib/useSceneWriter";
import { clearDraft } from "@/lib/drafts";
import { HttpError } from "@/lib/api";

/**
 * آزمون تعاملی رندرشده: تعویض سریع صحنه در حالی که ذخیرهٔ قبلی هنوز پاسخ
 * نگرفته است. هیچ‌چیز از سرور شبیه‌سازی نمی‌شود جز خودِ پاسخ؛ مقصدی که
 * هماهنگ‌کننده به save می‌دهد سنجیده می‌شود.
 */
function Harness({
  sceneId,
  serverText,
  save,
  writerRef,
}: {
  sceneId: string;
  serverText: string;
  save: Parameters<typeof useSceneWriter>[0]["save"];
  writerRef: React.MutableRefObject<SceneWriter | null>;
}) {
  const writer = useSceneWriter({ sceneId, serverText, serverUpdatedAt: "2026-01-01T00:00:00.000Z", save, debounceMs: 5 });
  writerRef.current = writer;
  return (
    <div>
      <textarea aria-label="متن صحنه" value={writer.text} onChange={(event) => writer.updateText(event.target.value)} />
      <span data-testid="status">{writer.state}</span>
      <span data-testid="stale">{writer.stale?.serverText ?? ""}</span>
    </div>
  );
}

beforeEach(() => {
  clearDraft("scene-A");
  clearDraft("scene-B");
  // پیش‌نویس‌ها در این آزمون روی دیسک نوشته نمی‌شوند؛ فقط درخواست شبکه پاسخ می‌گیرد.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ drafts: [] }), { status: 200, headers: { "content-type": "application/json" } })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("نویسنده در حالت رندرشده", () => {
  it("تعویض صحنه پیش از پاسخ ذخیره، مقصد را جابه‌جا نمی‌کند و متن صحنهٔ تازه را بازنویسی نمی‌کند", async () => {
    let resolveSave!: (value: { text: string }) => void;
    const calls: Array<{ text: string; sceneId: string }> = [];
    const save = vi.fn(async (text: string, _reason: string, target: { sceneId: string }) => {
      calls.push({ text, sceneId: target.sceneId });
      return new Promise<{ text: string }>((resolve) => {
        resolveSave = resolve;
      });
    });
    const writerRef: React.MutableRefObject<SceneWriter | null> = { current: null };
    const { rerender } = render(<Harness sceneId="scene-A" serverText="متن الف" save={save} writerRef={writerRef} />);

    const textarea = screen.getByLabelText("متن صحنه") as HTMLTextAreaElement;
    act(() => {
      writerRef.current!.updateText("متن تازهٔ الف");
    });
    expect(textarea.value).toBe("متن تازهٔ الف");

    // درخواست ارسال می‌شود ولی پاسخش هنوز نیامده.
    let pending!: Promise<void>;
    act(() => {
      pending = writerRef.current!.flush("manual");
    });

    // کاربر پیش از پاسخ، به صحنهٔ دیگر می‌رود (و نمای میزکار هم عوض می‌شود).
    rerender(<Harness sceneId="scene-B" serverText="متن ب" save={save} writerRef={writerRef} />);
    await waitFor(() => expect(textarea.value).toBe("متن ب"));
    act(() => {
      writerRef.current!.updateText("متن تازهٔ ب");
    });

    await act(async () => {
      resolveSave({ text: "متن تازهٔ الف" });
      await pending;
    });

    // درخواست فقط برای الف رفت، نه برای ب.
    expect(calls).toEqual([{ text: "متن تازهٔ الف", sceneId: "scene-A" }]);
    expect(screen.getByLabelText("متن صحنه")).toHaveProperty("value", "متن تازهٔ ب");
    expect(writerRef.current!.stale).toBeNull();
  });

  it("رد شدن ذخیره به‌دلیل تغییر سرور، متن کاربر را نگه می‌دارد و تصمیم صریح می‌خواهد", async () => {
    const save = vi.fn(async () => {
      throw new HttpError(409, {
        message: "این صحنه تغییر کرده است.",
        code: "stale_write",
        details: { serverText: "متن تازه‌تر سرور", serverUpdatedAt: "2026-02-02T00:00:00.000Z" },
      });
    });
    const writerRef: React.MutableRefObject<SceneWriter | null> = { current: null };
    render(<Harness sceneId="scene-A" serverText="متن سرور" save={save} writerRef={writerRef} />);

    act(() => {
      writerRef.current!.updateText("نوشتهٔ من");
    });
    await act(async () => {
      await writerRef.current!.flush("manual");
    });

    expect(screen.getByLabelText("متن صحنه")).toHaveProperty("value", "نوشتهٔ من");
    expect(screen.getByTestId("status").textContent).toBe("error");
    expect(screen.getByTestId("stale").textContent).toBe("متن تازه‌تر سرور");

    act(() => {
      writerRef.current!.resolveStale("server");
    });
    expect(screen.getByLabelText("متن صحنه")).toHaveProperty("value", "متن تازه‌تر سرور");
  });
});
