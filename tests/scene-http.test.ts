import { describe, expect, it } from "vitest";
import { createChapter, createProject, createScene, getScene } from "@/server/repo/projects";
import { PATCH } from "@/app/api/scenes/[id]/route";

function http(id: string, payload: Record<string, unknown>) {
  return PATCH(
    new Request(`http://localhost:3322/api/scenes/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://localhost:3322", host: "localhost:3322" },
      body: JSON.stringify(payload),
    }),
    { params: Promise.resolve({ id }) },
  );
}

function projectWithTwoScenes() {
  const project = createProject({ title: "ذخیرهٔ HTTP" });
  const chapter = createChapter(project.id, "فصل");
  const a = createScene({ chapterId: chapter.id, title: "صحنهٔ الف", text: "متن الف." });
  const b = createScene({ chapterId: chapter.id, title: "صحنهٔ ب", text: "متن ب." });
  return { project, a: getScene(a.id)!, b: getScene(b.id)! };
}

describe("ذخیرهٔ صحنه از مسیر HTTP", () => {
  it("مقصد درخواست همان صحنه است و نسخهٔ کهنه، صحنهٔ دیگر را تغییر نمی‌دهد", async () => {
    const { a, b } = projectWithTwoScenes();

    const ok = await http(a.id, { text: "متن تازهٔ الف.", reason: "manual", expectedUpdatedAt: a.updatedAt });
    expect(ok.status).toBe(200);
    expect(getScene(a.id)!.text).toBe("متن تازهٔ الف.");
    expect(getScene(b.id)!.text).toBe("متن ب.");

    // صحنهٔ ب بیرون از این پنجره تازه می‌شود؛ کلید کهنه باید رد شود و متن تازه حفظ شود.
    const bBefore = getScene(b.id)!.updatedAt;
    const outside = await http(b.id, { text: "متن تازه‌تر ب.", reason: "manual", force: true });
    expect(outside.status).toBe(200);

    const stale = await http(b.id, { text: "نوشتهٔ اشتباه روی ب.", reason: "manual", expectedUpdatedAt: bBefore });
    expect(stale.status).toBe(409);
    const body = await stale.json();
    expect(body.error.code).toBe("stale_write");
    expect(body.error.details.serverText).toBe("متن تازه‌تر ب.");
    expect(getScene(b.id)!.text).toBe("متن تازه‌تر ب.");
    expect(getScene(a.id)!.text).toBe("متن تازهٔ الف.");
  });

  it("نوشتن با force صریح انجام می‌شود و نسخهٔ پیشین در تاریخچه می‌ماند", async () => {
    const { a } = projectWithTwoScenes();
    const first = await http(a.id, { text: "نسخهٔ یک.", reason: "manual" });
    expect(first.status).toBe(200);
    const second = await http(a.id, { text: "نسخهٔ دو.", reason: "manual", force: true });
    expect(second.status).toBe(200);
    expect(getScene(a.id)!.text).toBe("نسخهٔ دو.");
  });
});
