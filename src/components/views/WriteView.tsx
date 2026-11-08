"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText, formatDate } from "@/lib/api";
import { useWorkspace } from "@/components/workspace";
import { Badge, Button, Empty, Field, Modal, Notice, Spinner, useDebounced } from "@/components/ui";
import { diffLines, diffStats } from "@/lib/diff";
import { useSceneWriter } from "@/lib/useSceneWriter";
import { usePreferences } from "@/components/preferences";
import { retryDraftSync } from "@/lib/drafts";
import type { Scene, SceneVersion } from "@/lib/types";

interface Suggestion {
  original: string;
  replacement: string;
  reason: string;
}

export default function WriteView() {
  const ctx = useWorkspace();
  const { bundle, reload, selectedSceneId, setSelectedSceneId, textDirection, reportSaveStatus } = ctx;
  const { preferences, setPreference } = usePreferences();
  const scene = bundle.scenes.find((item) => item.id === selectedSceneId) ?? null;

  const [versions, setVersions] = useState<SceneVersion[]>([]);
  const [showVersions, setShowVersions] = useState(false);
  const [diffPair, setDiffPair] = useState<{ a: SceneVersion; b: SceneVersion } | null>(null);
  const [showRecovery, setShowRecovery] = useState(false);
  const [conflictPreview, setConflictPreview] = useState<{ title: string; before: string; after: string } | null>(null);
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<Array<{ id: string; title: string; snippet: string; kind: string; sceneId?: string }>>([]);
  const [assoc, setAssoc] = useState<{ present: string[]; locationId: string | null }>({ present: [], locationId: null });
  const [newChapter, setNewChapter] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [inspector, setInspector] = useState(true);
  const [showType, setShowType] = useState(false);
  const [assistant, setAssistant] = useState<{ requestId: string; suggestions: Suggestion[]; note: string } | null>(null);
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [picked, setPicked] = useState<number[]>([]);

  const history = useRef<string[]>([]);
  const historyIndex = useRef(-1);
  const manualSave = useRef(false);
  const debouncedSearch = useDebounced(search, 260);

  const writer = useSceneWriter({
    sceneId: scene?.id ?? null,
    serverText: scene?.text ?? "",
    serverUpdatedAt: scene?.updatedAt ?? null,
    save: async (value, reason, target) => {
      const data = await api<{ scene: Scene }>(`/api/scenes/${target.sceneId}`, {
        method: "PATCH",
        json: {
          text: value,
          reason,
          expectedUpdatedAt: target.force ? null : target.baseUpdatedAt,
          force: target.force,
        },
      });
      // به‌روزرسانی bundel با شناسهٔ مقصدِ همان کار، نه صحنهٔ نمایش‌داده‌شده.
      ctx.patchScene(target.sceneId, {
        text: data.scene.text,
        wordCount: data.scene.wordCount,
        updatedAt: data.scene.updatedAt,
        currentVersionId: data.scene.currentVersionId,
      });
      return { text: data.scene.text, updatedAt: data.scene.updatedAt };
    },
  });
  const text = writer.text;
  const setText = writer.updateText;

  useEffect(() => {
    history.current = [text];
    historyIndex.current = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene?.id]);

  // وضعیت ذخیره در نوار بالای میزکار دیده می‌شود، حتی وقتی بخش دیگری باز است.
  useEffect(() => {
    const label =
      writer.state === "saving"
        ? "در حال ذخیره…"
        : writer.state === "error"
          ? "ذخیره ناموفق"
          : writer.conflict
            ? "پیش‌نویس نیازمند تصمیم"
            : writer.dirty
              ? "تغییر ذخیره‌نشده"
              : writer.state === "saved"
                ? "ذخیره شد"
                : "همه‌چیز ذخیره شده";
    const tone = writer.state === "error" || writer.conflict ? "bad" : writer.dirty ? "warn" : writer.state === "saved" ? "ok" : "muted";
    reportSaveStatus({ label, tone: tone as "ok" | "warn" | "bad" | "muted" });
    return () => reportSaveStatus(null);
  }, [writer.state, writer.dirty, writer.conflict, reportSaveStatus]);

  useEffect(() => {
    if (writer.state === "saved" && manualSave.current) {
      manualSave.current = false;
      setNotice("متن ذخیره شد.");
    }
    if (writer.state === "error") manualSave.current = false;
  }, [writer.state]);

  useEffect(() => {
    if (writer.conflict) setShowRecovery(true);
  }, [writer.conflict]);

  useEffect(() => {
    if (!scene) return;
    let cancelled = false;
    void api<{ sceneState: { presentEntities: string[]; locationId: string | null } }>(`/api/projects/${bundle.project.id}/world?sceneId=${scene.id}`)
      .then((data) => {
        if (!cancelled) setAssoc({ present: data.sceneState.presentEntities ?? [], locationId: data.sceneState.locationId ?? null });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [scene?.id, bundle.project.id]);

  useEffect(() => {
    if (!debouncedSearch.trim()) {
      setHits([]);
      return;
    }
    let cancelled = false;
    void api<{ hits: typeof hits }>(`/api/projects/${bundle.project.id}/search?q=${encodeURIComponent(debouncedSearch)}`)
      .then((data) => {
        if (!cancelled) setHits(data.hits);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [debouncedSearch, bundle.project.id]);

  const save = useCallback(
    async (reason: "manual" | "autosave") => {
      if (reason === "manual") manualSave.current = true;
      await writer.flush(reason);
    },
    [writer],
  );

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save("manual");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [save]);

  const pushHistory = (value: string) => {
    if (historyIndex.current >= 0 && history.current[historyIndex.current] === value) return;
    history.current = [...history.current.slice(0, historyIndex.current + 1), value].slice(-100);
    historyIndex.current = history.current.length - 1;
  };

  const undo = () => {
    if (historyIndex.current <= 0) return;
    historyIndex.current -= 1;
    setText(history.current[historyIndex.current]);
  };
  const redo = () => {
    if (historyIndex.current >= history.current.length - 1) return;
    historyIndex.current += 1;
    setText(history.current[historyIndex.current]);
  };

  const loadVersions = async () => {
    if (!scene) return;
    setBusy(true);
    try {
      const data = await api<{ versions: SceneVersion[] }>(`/api/scenes/${scene.id}`);
      setVersions(data.versions);
      setShowVersions(true);
    } catch (error) {
      setLocalError(errorText(error).message);
    } finally {
      setBusy(false);
    }
  };

  const restoreVersion = async (versionId: string) => {
    if (!scene) return;
    setBusy(true);
    try {
      const data = await api<{ scene: Scene }>(`/api/scenes/${scene.id}`, { method: "POST", json: { action: "restore", versionId } });
      writer.markSaved(data.scene.text, data.scene.updatedAt);
      setShowVersions(false);
      await reload();
      setNotice("نسخه بازگردانده شد؛ نسخهٔ فعلی هم در تاریخچه ماند و پنل‌های وابسته «نیازمند بازبینی» شدند.");
    } catch (error) {
      setLocalError(errorText(error).message);
    } finally {
      setBusy(false);
    }
  };

  const addChapter = async () => {
    if (!newChapter.trim()) return;
    setBusy(true);
    try {
      await api(`/api/projects/${bundle.project.id}/chapters`, { method: "POST", json: { title: newChapter.trim() } });
      setNewChapter("");
      await reload();
    } catch (error) {
      setLocalError(errorText(error).message);
    } finally {
      setBusy(false);
    }
  };

  const addScene = async (chapterId: string) => {
    setBusy(true);
    try {
      const data = await api<{ scene: Scene }>(`/api/projects/${bundle.project.id}/scenes`, {
        method: "POST",
        json: { chapterId, title: "صحنهٔ تازه" },
      });
      await reload();
      setSelectedSceneId(data.scene.id);
    } catch (error) {
      setLocalError(errorText(error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveMeta = async (patch: Partial<Scene>) => {
    if (!scene) return;
    try {
      await api(`/api/scenes/${scene.id}`, { method: "PATCH", json: patch });
      await reload();
    } catch (error) {
      setLocalError(errorText(error).message);
    }
  };

  const saveAssoc = async (next: { present: string[]; locationId: string | null }) => {
    if (!scene) return;
    setAssoc(next);
    try {
      await api(`/api/projects/${bundle.project.id}/world`, {
        method: "POST",
        json: { action: "scene-state", sceneId: scene.id, presentEntities: next.present, locationId: next.locationId },
      });
    } catch (error) {
      setLocalError(errorText(error).message);
    }
  };

  const runSuggestions = async () => {
    if (!scene) return;
    setAssistantBusy(true);
    setLocalError(null);
    try {
      const data = await api<{ requestId: string; note: string }>(`/api/scenes/${scene.id}/assistant`, {
        method: "POST",
        json: { action: "run", kind: "suggest" },
      });
      setNotice(data.note);
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        try {
          const result = await api<{ result: { requestId: string; parsed: unknown; note: string } | null }>(
            `/api/scenes/${scene.id}/assistant?requestId=${data.requestId}`,
          );
          if (!result.result) continue;
          const parsed = result.result.parsed as { suggestions?: Suggestion[] };
          setAssistant({ requestId: result.result.requestId, suggestions: parsed.suggestions ?? [], note: result.result.note });
          setPicked([]);
          break;
        } catch {
          /* هنوز آماده نیست */
        }
      }
    } catch (error) {
      setLocalError(errorText(error).message);
    } finally {
      setAssistantBusy(false);
    }
  };

  const applySuggestions = async () => {
    if (!scene || !assistant || picked.length === 0) return;
    setBusy(true);
    try {
      const data = await api<{ applied: number; note: string }>(`/api/scenes/${scene.id}/assistant`, {
        method: "POST",
        json: { action: "apply-suggest", requestId: assistant.requestId, indices: picked },
      });
      setNotice(data.note);
      setAssistant(null);
      setPicked([]);
      await reload();
    } catch (error) {
      setLocalError(errorText(error).message);
    } finally {
      setBusy(false);
    }
  };

  const words = useMemo(() => text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean).length, [text]);
  const characters = bundle.entities.filter((entity) => entity.kind === "character");
  const locations = bundle.entities.filter((entity) => entity.kind === "location");
  const approvedRefs = bundle.references.filter((ref) => ref.status === "approved");
  const saveError = writer.error;
  const conflictLines = writer.conflict ? diffLines(writer.conflict.serverText, writer.conflict.draftText) : [];
  const conflictStats = diffStats(conflictLines);

  return (
    <div className="writer" data-inspector={inspector ? "open" : "closed"}>
      <div className="col">
        {writer.draftSyncError ? (
          <Notice tone="bad">
            <div className="row between">
              <span>
                پیش‌نویس روی دیسک ذخیره نشد: {writer.draftSyncError} — متن در همین پنجره سالم است. تا وقتی این پیام هست،
                بستن برنامه ممکن است آخرین تغییرها را از دست بدهد.
              </span>
              <Button size="sm" onClick={() => void retryDraftSync()}>
                تلاش دوباره
              </Button>
            </div>
          </Notice>
        ) : null}
        {saveError ? (
          <Notice tone="bad">
            <div className="row between">
              <span>ذخیره ناموفق: {saveError} — متن در پیش‌نویس پایدار همین صحنه مانده و با بازگشت بازیابی می‌شود.</span>
              <Button size="sm" onClick={() => void save("manual")}>
                تلاش دوباره
              </Button>
            </div>
          </Notice>
        ) : null}
        {writer.stale ? (
          <Notice tone="warn">
            <div className="col" style={{ gap: 8 }}>
              <span>
                متن این صحنه بیرون از این پنجره تازه‌تر شده است. نوشتهٔ شما پاک نشده؛ انتخاب کنید کدام بماند.
              </span>
              <div className="row">
                <Button
                  size="sm"
                  onClick={() => {
                    setDiffPair(null);
                    setShowVersions(false);
                    setConflictPreview({ before: writer.stale!.serverText, after: text, title: "تفاوت متن سرور و نوشتهٔ من" });
                  }}
                >
                  دیدن تفاوت
                </Button>
                <Button size="sm" variant="primary" onClick={() => void writer.resolveStale("mine")}>
                  نوشتهٔ من بماند
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void writer.resolveStale("server")}>
                  متن سرور را بپذیر
                </Button>
              </div>
            </div>
          </Notice>
        ) : null}
        {localError ? (
          <Notice tone="bad">
            <div className="row between">
              <span>{localError}</span>
              <Button size="sm" variant="ghost" onClick={() => setLocalError(null)}>
                بستن
              </Button>
            </div>
          </Notice>
        ) : null}
        {notice ? (
          <Notice tone="ok">
            <div className="row between">
              <span>{notice}</span>
              <Button size="sm" variant="ghost" onClick={() => setNotice(null)}>
                بستن
              </Button>
            </div>
          </Notice>
        ) : null}
        {writer.recovered && !writer.conflict ? (
          <Notice tone="warn">
            <div className="row between">
              <span>پیش‌نویس ذخیره‌نشدهٔ این صحنه بازیابی شد.</span>
              <div className="row">
                <Button size="sm" variant="ghost" onClick={() => setShowRecovery(true)}>
                  مقایسه با متن سرور
                </Button>
                <Button size="sm" variant="ghost" onClick={writer.dismissRecovery}>
                  بستن
                </Button>
              </div>
            </div>
          </Notice>
        ) : null}

        <section className="manuscript" aria-label="متن صحنه">
          <div className="manuscript-head">
            <div className="grow" style={{ minWidth: 220 }}>
              {scene ? (
                <input
                  className="scene-title-input"
                  value={scene.title}
                  onChange={(event) => saveMeta({ title: event.target.value })}
                  aria-label="عنوان صحنه"
                />
              ) : (
                <h2>صحنه‌ای انتخاب نشده</h2>
              )}
              <div className="row small muted" style={{ gap: 8, marginTop: 4 }}>
                <span>{words.toLocaleString("fa-IR")} واژه</span>
                <span aria-hidden>·</span>
                <span>{scene?.storyDate ? `زمان داستان: ${scene.storyDate}` : "زمان داستان نامشخص"}</span>
                {scene?.isFlashback ? <Badge tone="warn">فلش‌بک</Badge> : null}
                {scene?.currentVersionId ? <Badge tone="muted">نسخه‌دار</Badge> : null}
              </div>
            </div>
            <div className="row">
              <Button size="sm" onClick={undo} title="واگرد" aria-label="واگرد">
                ↶
              </Button>
              <Button size="sm" onClick={redo} title="ازنو" aria-label="ازنو">
                ↷
              </Button>
              <Button size="sm" onClick={() => setShowType((current) => !current)} aria-expanded={showType}>
                آا اندازه
              </Button>
              <Button size="sm" onClick={() => void loadVersions()} disabled={busy || !scene}>
                نسخه‌ها
              </Button>
              <Button size="sm" variant="primary" onClick={() => void save("manual")} disabled={!scene}>
                ذخیره
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setInspector((current) => !current)} aria-pressed={inspector}>
                {inspector ? "بستن کنار" : "باز کردن کنار"}
              </Button>
            </div>
          </div>

          {showType ? (
            <div className="toolbar" style={{ padding: 10, background: "var(--surface-2)", borderRadius: 10 }}>
              <label className="small muted" htmlFor="font-size">
                اندازهٔ متن
              </label>
              <input
                id="font-size"
                type="range"
                min={14}
                max={30}
                step={1}
                value={preferences.editorFontSize}
                onChange={(event) => setPreference("editorFontSize", Number(event.target.value))}
                style={{ width: 140 }}
              />
              <label className="small muted" htmlFor="line-height">
                فاصلهٔ خطوط
              </label>
              <input
                id="line-height"
                type="range"
                min={1.4}
                max={2.6}
                step={0.1}
                value={preferences.editorLineHeight}
                onChange={(event) => setPreference("editorLineHeight", Number(event.target.value))}
                style={{ width: 140 }}
              />
              <label className="small muted" htmlFor="reading-width">
                عرض سطر
              </label>
              <input
                id="reading-width"
                type="range"
                min={46}
                max={96}
                step={2}
                value={preferences.readingWidth}
                onChange={(event) => setPreference("readingWidth", Number(event.target.value))}
                style={{ width: 120 }}
              />
              <Button size="sm" variant="ghost" onClick={() => { setPreference("editorFontSize", 18); setPreference("editorLineHeight", 2); setPreference("readingWidth", 68); }}>
                بازگشت به پیش‌فرض
              </Button>
            </div>
          ) : null}

          {!scene ? (
            <Empty
              title="هنوز صحنه‌ای انتخاب نشده است."
              hint="از فهرست فصل‌ها در کنار یک صحنه بسازید یا انتخاب کنید."
              action={bundle.chapters[0] ? <Button onClick={() => void addScene(bundle.chapters[0].id)}>ساخت صحنه در «{bundle.chapters[0].title}»</Button> : null}
            />
          ) : (
            <>
              <textarea
                className="editor-textarea"
                dir={textDirection}
                value={text}
                onChange={(event) => {
                  setText(event.target.value);
                  pushHistory(event.target.value);
                }}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "z") {
                    event.preventDefault();
                    if (event.shiftKey) redo();
                    else undo();
                  }
                }}
                placeholder="اینجا بنویسید… متن به‌صورت خودکار ذخیره می‌شود و پیش‌نویس روی دیسک می‌ماند."
                spellCheck={false}
                aria-label={`متن صحنهٔ ${scene.title}`}
              />
              <div className="editor-meta">
                <span>
                  ذخیرهٔ خودکار روشن است · <span className="kbd">Ctrl</span> + <span className="kbd">S</span> برای ذخیرهٔ دستی
                </span>
                <span>{writer.dirty ? "تغییر ذخیره‌نشده" : writer.state === "saved" ? "ذخیره شد" : "—"}</span>
              </div>
            </>
          )}
        </section>
      </div>

      {inspector ? (
        <aside className="inspector" aria-label="کنار نویسنده">
          <section>
            <h4>فصل‌ها و صحنه‌ها</h4>
            <div className="outline">
              {bundle.chapters.length === 0 ? <p className="small muted">فصلی وجود ندارد.</p> : null}
              {bundle.chapters.map((chapter) => (
                <div key={chapter.id}>
                  <div className="outline-chapter">
                    <span>{chapter.title}</span>
                    <Button size="sm" variant="ghost" onClick={() => void addScene(chapter.id)} aria-label={`افزودن صحنه به ${chapter.title}`}>
                      +
                    </Button>
                  </div>
                  <div className="list">
                    {bundle.scenes
                      .filter((item) => item.chapterId === chapter.id)
                      .map((item) => (
                        <button
                          key={item.id}
                          className={`list-item ${selectedSceneId === item.id ? "active" : ""}`}
                          onClick={() => setSelectedSceneId(item.id)}
                          aria-current={selectedSceneId === item.id ? "true" : undefined}
                        >
                          <span>{item.title}</span>
                          <span className="small muted">{item.wordCount.toLocaleString("fa-IR")}</span>
                        </button>
                      ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <input value={newChapter} onChange={(event) => setNewChapter(event.target.value)} placeholder="نام فصل تازه" aria-label="نام فصل تازه" />
              <Button size="sm" onClick={() => void addChapter()} disabled={!newChapter.trim() || busy}>
                افزودن
              </Button>
            </div>
          </section>

          {scene ? (
            <section>
              <h4>پیشنهاد ویرایش با AI</h4>
              <p className="small muted" style={{ marginBottom: 8 }}>
                پیشنهادها فقط نمایش داده می‌شوند؛ متن اصلی تا انتخاب شما تغییر نمی‌کند. نیازمند کلید مدل متنی است.
              </p>
              {!assistant ? (
                <Button size="sm" onClick={() => void runSuggestions()} disabled={assistantBusy}>
                  {assistantBusy ? "در حال ساخت پیشنهادها…" : "پیشنهاد ویرایش بگیر"}
                </Button>
              ) : (
                <div className="col" style={{ gap: 8 }}>
                  {assistant.note ? <Notice tone="warn">{assistant.note}</Notice> : null}
                  {assistant.suggestions.length === 0 ? <p className="small muted">پیشنهادی برنگشت.</p> : null}
                  {assistant.suggestions.map((item, index) => (
                    <label key={index} className="issue" style={{ cursor: "pointer" }}>
                      <div className="row">
                        <input
                          type="checkbox"
                          checked={picked.includes(index)}
                          onChange={(event) => setPicked((current) => (event.target.checked ? [...current, index] : current.filter((i) => i !== index)))}
                          aria-label={`انتخاب پیشنهاد ${index + 1}`}
                        />
                        <span className="small muted">پیشنهاد {index + 1}</span>
                      </div>
                      <div className="small" dir={textDirection}>
                        <span className="del">{item.original}</span>
                      </div>
                      <div className="small" dir={textDirection}>
                        <span className="ins">{item.replacement}</span>
                      </div>
                      {item.reason ? <span className="xs muted">{item.reason}</span> : null}
                    </label>
                  ))}
                  <div className="row">
                    <Button size="sm" variant="primary" onClick={() => void applySuggestions()} disabled={busy || picked.length === 0}>
                      اعمال {picked.length ? `(${picked.length})` : ""}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => { setAssistant(null); setPicked([]); }}>
                      رد همه
                    </Button>
                  </div>
                </div>
              )}
            </section>
          ) : null}

          {scene ? (
            <section>
              <h4>کارگردانی این صحنه</h4>
              <div className="col" style={{ gap: 10 }}>
                <Field label="تاریخ داستان" hint="مرجع معتبر زمانی از همین تاریخ سنجیده می‌شود.">
                  <input type="date" value={scene.storyDate ?? ""} onChange={(event) => void saveMeta({ storyDate: event.target.value || null })} />
                </Field>
                <label className="toggle">
                  <input type="checkbox" checked={scene.isFlashback} onChange={(event) => void saveMeta({ isFlashback: event.target.checked })} />
                  این صحنه فلش‌بک است
                </label>
                <Field label="مکان صحنه">
                  <select value={assoc.locationId ?? ""} onChange={(event) => void saveAssoc({ ...assoc, locationId: event.target.value || null })}>
                    <option value="">— بدون مکان —</option>
                    {locations.map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <div>
                  <span className="field-label">حاضران</span>
                  <div className="chip-list" style={{ marginTop: 6 }}>
                    {characters.map((character) => {
                      const on = assoc.present.includes(character.id);
                      return (
                        <button
                          key={character.id}
                          className={`chip ${on ? "on" : ""}`}
                          aria-pressed={on}
                          onClick={() =>
                            void saveAssoc({ ...assoc, present: on ? assoc.present.filter((id) => id !== character.id) : [...assoc.present, character.id] })
                          }
                        >
                          {character.name}
                        </button>
                      );
                    })}
                    {characters.length === 0 ? <span className="small muted">شخصیتی ثبت نشده است.</span> : null}
                  </div>
                </div>
                <Field label="هدف صحنه" hint="برای کارگردانی و ساخت پنل استفاده می‌شود.">
                  <textarea rows={3} dir={textDirection} value={scene.objective} onChange={(event) => void saveMeta({ objective: event.target.value })} />
                </Field>
              </div>
            </section>
          ) : null}

          <section>
            <h4>مراجع تأییدشدهٔ این پروژه ({approvedRefs.length})</h4>
            {approvedRefs.length === 0 ? (
              <p className="small muted">مرجع تأییدشده‌ای نیست. در «کتابخانهٔ مراجع» تصویر هویت اضافه و تأیید کنید.</p>
            ) : (
              <div className="refstrip">
                {approvedRefs.slice(0, 8).map((ref) => (
                  <figure key={ref.id}>
                    <img src={ref.thumbUrl} alt={ref.title} loading="lazy" />
                    <figcaption title={ref.title}>{ref.title}</figcaption>
                  </figure>
                ))}
              </div>
            )}
          </section>

          <section>
            <h4>جست‌وجو در پروژه</h4>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="واژه یا نام…" aria-label="جست‌وجوی پروژه" />
            <div className="list" style={{ marginTop: 6 }}>
              {hits.map((hit) => (
                <button
                  key={`${hit.kind}-${hit.id}`}
                  className="search-hit"
                  onClick={() => {
                    if (hit.sceneId) setSelectedSceneId(hit.sceneId);
                  }}
                >
                  <div className="row between">
                    <strong className="small">{hit.title}</strong>
                    <Badge tone="muted">{hit.kind === "scene" ? "صحنه" : hit.kind === "entity" ? "موجودیت" : "واقعیت"}</Badge>
                  </div>
                  <span className="small muted">{hit.snippet}</span>
                </button>
              ))}
              {search && hits.length === 0 ? <p className="small muted">نتیجه‌ای پیدا نشد.</p> : null}
            </div>
          </section>
        </aside>
      ) : null}

      {showVersions ? (
        <Modal title={`نسخه‌های «${scene?.title ?? ""}»`} onClose={() => setShowVersions(false)} wide>
          {busy ? <Spinner /> : null}
          {versions.length === 0 ? <Empty title="نسخه‌ای ثبت نشده است." /> : null}
          <div className="col">
            {versions.map((version, index) => (
              <div key={version.id} className="version-row">
                <div>
                  <strong>نسخهٔ {version.version}</strong>{" "}
                  <Badge tone="muted">
                    {version.reason === "autosave" ? "خودکار" : version.reason === "manual" ? "دستی" : version.reason === "restore" ? "بازیابی" : "AI"}
                  </Badge>
                  <div className="small muted">
                    {formatDate(version.createdAt)} · {version.wordCount.toLocaleString("fa-IR")} واژه
                  </div>
                </div>
                <div className="row">
                  {versions[index + 1] ? (
                    <Button size="sm" variant="ghost" onClick={() => setDiffPair({ a: versions[index + 1], b: version })}>
                      مقایسه
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    onClick={() => {
                      if (window.confirm("این نسخه جایگزین متن فعلی می‌شود؛ نسخهٔ فعلی هم در تاریخچه می‌ماند. ادامه؟")) void restoreVersion(version.id);
                    }}
                  >
                    بازگردانی
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Modal>
      ) : null}

      {diffPair ? (
        <Modal title={`مقایسهٔ نسخهٔ ${diffPair.a.version} و ${diffPair.b.version}`} onClose={() => setDiffPair(null)} wide>
          {(() => {
            const lines = diffLines(diffPair.a.text, diffPair.b.text);
            const stats = diffStats(lines);
            return (
              <>
                <p className="small muted">
                  {stats.added} سطر افزوده · {stats.removed} سطر حذف‌شده — متن اصلی فقط خوانده می‌شود.
                </p>
                <div className="pre" dir={textDirection}>
                  {lines.map((line, index) => (
                    <div key={index} className={line.kind === "add" ? "ins" : line.kind === "del" ? "del" : ""}>
                      {line.kind === "add" ? "+ " : line.kind === "del" ? "− " : "  "}
                      {line.text || " "}
                    </div>
                  ))}
                </div>
              </>
            );
          })()}
        </Modal>
      ) : null}

      {showRecovery && writer.conflict ? (
        <Modal title="پیش‌نویس شما با متن تازه‌تر سرور تفاوت دارد" onClose={() => setShowRecovery(false)} wide>
          <p className="small muted">
            نوشتهٔ شما ({conflictStats.added} سطر تازه) بر پایهٔ نسخهٔ پیشین متن است. هیچ‌کدام خودکار جای دیگری را نمی‌گیرد؛ خودتان
            انتخاب کنید.
          </p>
          <div className="grid grid-2">
            <div>
              <h4 className="small">نوشتهٔ من (پیش‌نویس)</h4>
              <div className="pre" dir={textDirection} style={{ maxHeight: 260 }}>
                {writer.conflict.draftText}
              </div>
            </div>
            <div>
              <h4 className="small">متن فعلی سرور</h4>
              <div className="pre" dir={textDirection} style={{ maxHeight: 260 }}>
                {writer.conflict.serverText}
              </div>
            </div>
          </div>
          <details style={{ marginTop: 10 }}>
            <summary className="small muted">تفاوت سطر‌به‌سطر</summary>
            <div className="pre" dir={textDirection} style={{ maxHeight: 220 }}>
              {conflictLines.map((line, index) => (
                <div key={index} className={line.kind === "add" ? "ins" : line.kind === "del" ? "del" : ""}>
                  {line.kind === "add" ? "+ " : line.kind === "del" ? "− " : "  "}
                  {line.text || " "}
                </div>
              ))}
            </div>
          </details>
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
            <Button variant="ghost" onClick={() => setShowRecovery(false)}>
              بعداً
            </Button>
            <Button
              onClick={() => {
                writer.resolveRecovery("server");
                setShowRecovery(false);
              }}
            >
              متن سرور را بپذیر
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                writer.resolveRecovery("draft");
                setShowRecovery(false);
                void save("manual");
              }}
            >
              نوشتهٔ من را نگه دار
            </Button>
          </div>
        </Modal>
      ) : null}

      {conflictPreview ? (
        <Modal title={conflictPreview.title} onClose={() => setConflictPreview(null)} wide>
          {(() => {
            const lines = diffLines(conflictPreview.before, conflictPreview.after);
            const stats = diffStats(lines);
            return (
              <>
                <p className="small muted">
                  {stats.added} سطر افزوده · {stats.removed} سطر حذف‌شده
                </p>
                <div className="pre" dir={textDirection}>
                  {lines.map((line, index) => (
                    <div key={index} className={line.kind === "add" ? "ins" : line.kind === "del" ? "del" : ""}>
                      {line.kind === "add" ? "+ " : line.kind === "del" ? "− " : "  "}
                      {line.text || " "}
                    </div>
                  ))}
                </div>
              </>
            );
          })()}
        </Modal>
      ) : null}
    </div>
  );
}
