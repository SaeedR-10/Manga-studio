"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorText, SHOT_LABELS, STATUS_LABELS } from "@/lib/api";
import { useWorkspace } from "@/components/workspace";
import { Badge, Button, Card, Empty, ErrorNote, Field, Modal, Notice, Spinner } from "@/components/ui";
import type { Job, Panel } from "@/lib/types";

export default function ScenesView() {
  const ctx = useWorkspace();
  const { bundle, selectedSceneId, setSelectedSceneId, setSelectedPanelId, setView } = ctx;
  const [panels, setPanels] = useState<Panel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Panel[] | null>(null);
  const [target, setTarget] = useState(bundle.project.settings.adaptation.panelsPerScene);
  const [job, setJob] = useState<Job | null>(null);
  const [aiRequestId, setAiRequestId] = useState<string | null>(null);
  const [aiStatus, setAiStatus] = useState<string | null>(null);
  const [assistantKind, setAssistantKind] = useState<"extract" | "suggest" | "director" | null>(null);
  const [assistantRequestId, setAssistantRequestId] = useState<string | null>(null);
  const [assistant, setAssistant] = useState<{
    requestId: string;
    parsed: unknown;
    note: string;
    currentHash: string;
  } | null>(null);
  const [picked, setPicked] = useState<number[]>([]);

  const scene = bundle.scenes.find((s) => s.id === selectedSceneId) ?? null;

  const loadPanels = useCallback(async () => {
    if (!selectedSceneId) {
      setPanels([]);
      return;
    }
    setLoading(true);
    try {
      const data = await api<{ panels: Panel[] }>(`/api/projects/${bundle.project.id}/panels?sceneId=${selectedSceneId}`);
      setPanels(data.panels);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [bundle.project.id, selectedSceneId]);

  useEffect(() => {
    void loadPanels();
  }, [loadPanels]);

  const splitLocal = async (commit: boolean) => {
    if (!scene) return;
    setBusy(true);
    setError(null);
    try {
      const data = await api<{ proposals?: Panel[]; panels?: Panel[] }>(`/api/projects/${bundle.project.id}/panels`, {
        method: "POST",
        json: { action: "local-split", sceneId: scene.id, target, commit },
      });
      if (!commit && data.proposals) {
        setPreview(data.proposals as unknown as Panel[]);
      } else if (data.panels) {
        setPanels(data.panels);
        setNotice(`${data.panels.length} پنل افزوده شد. هر پنل به نسخهٔ متن فعلی گره خورده است.`);
        await ctx.reload();
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const adaptWithAi = async () => {
    if (!scene) return;
    setBusy(true);
    setError(null);
    try {
      const data = await api<{ job: Job; requestId: string }>(`/api/projects/${bundle.project.id}/panels`, {
        method: "POST",
        json: { action: "adapt-ai", sceneId: scene.id, target },
      });
      setJob(data.job);
      setAiRequestId(data.requestId);
      setAiStatus("در صف");
      setNotice("درخواست اقتباس در پس‌زمینه اجرا می‌شود. می‌توانید به نوشتن ادامه دهید.");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!aiRequestId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await api<{ requests: Array<{ id: string; status: string; errorMessage: string | null }> }>(
          `/api/projects/${bundle.project.id}/jobs`,
        );
        const request = data.requests.find((r) => r.id === aiRequestId);
        if (!request || cancelled) return;
        setAiStatus(request.status);
        if (request.status === "succeeded") {
          setNotice("نتیجهٔ اقتباس آماده است. پیش از افزودن، پنل‌ها را بررسی کنید.");
          setJob(null);
        }
        if (request.status === "failed") setError(new Error(request.errorMessage ?? "اقتباس ناموفق بود."));
      } catch {
        /* polling errors are transient */
      }
    };
    void poll();
    const timer = setInterval(poll, 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [aiRequestId, bundle.project.id]);

  const useAiResult = async () => {
    if (!scene || !aiRequestId) return;
    setBusy(true);
    try {
      const data = await api<{ panels: Panel[] }>(`/api/projects/${bundle.project.id}/panels`, {
        method: "POST",
        json: { action: "use-ai-result", sceneId: scene.id, requestId: aiRequestId },
      });
      setPanels(data.panels);
      setNotice(`${data.panels.length} پنل از نتیجهٔ AI افزوده شد؛ همه پیش‌نویس و قابل ویرایش‌اند.`);
      setAiRequestId(null);
      await ctx.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const runAssistant = async (kind: "extract" | "suggest" | "director") => {
    if (!scene) return;
    setBusy(true);
    setError(null);
    setAssistant(null);
    setPicked([]);
    try {
      const data = await api<{ requestId: string; note: string }>(`/api/scenes/${scene.id}/assistant`, {
        method: "POST",
        json: { action: "run", kind },
      });
      setAssistantKind(kind);
      setAssistantRequestId(data.requestId);
      setNotice(data.note);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  // انتظار برای نتیجهٔ دستیار؛ هیچ تغییری تا تأیید کاربر اعمال نمی‌شود.
  useEffect(() => {
    if (!assistantRequestId || !scene) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await api<{ result: { requestId: string; parsed: unknown; note: string; currentHash: string } }>(
          `/api/scenes/${scene.id}/assistant?requestId=${assistantRequestId}`,
        );
        if (cancelled || !data.result) return;
        setAssistant(data.result);
        setAssistantRequestId(null);
        setNotice("نتیجه آماده است. بررسی و تأیید شما لازم است.");
      } catch {
        /* هنوز آماده نیست یا خطا موقت است */
      }
    };
    void poll();
    const timer = setInterval(poll, 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [assistantRequestId, scene]);

  const applyExtract = async () => {
    if (!scene || !assistant) return;
    setBusy(true);
    try {
      const data = await api<{ createdEntities: number; createdFacts: number; note: string }>(`/api/scenes/${scene.id}/assistant`, {
        method: "POST",
        json: { action: "apply-extract", requestId: assistant.requestId, acceptAll: true },
      });
      setNotice(`${data.note} (${data.createdEntities} موجودیت، ${data.createdFacts} واقعیت پیشنهادی)`);
      setAssistant(null);
      await ctx.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
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
      await ctx.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const removePanel = async (panel: Panel) => {
    if (!window.confirm(`پنل «${panel.title}» حذف شود؟`)) return;
    try {
      const data = await api<{ panels: Panel[] }>(`/api/panels/${panel.id}`, { method: "DELETE" });
      setPanels(data.panels);
    } catch (err) {
      setError(err);
    }
  };

  return (
    <div className="col" style={{ gap: 14 }}>
      <ErrorNote error={error} />
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

      <Card
        title="صحنه‌ها"
        actions={
          <select value={selectedSceneId ?? ""} onChange={(e) => setSelectedSceneId(e.target.value || null)} style={{ width: 260 }}>
            <option value="">— انتخاب صحنه —</option>
            {bundle.scenes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title} {s.isFlashback ? "(فلش‌بک)" : ""}
              </option>
            ))}
          </select>
        }
      >
        {!scene ? (
          <Empty title="صحنه‌ای انتخاب نشده است." hint="از بخش «نوشتن» صحنه بسازید." />
        ) : (
          <>
            <p className="small muted">
              {scene.wordCount} واژه · زمان داستان: {scene.storyDate ?? "نامشخص"} {scene.isFlashback ? "· فلش‌بک" : ""}
            </p>
            <div className="row" style={{ marginBottom: 8 }}>
              <Field label="تعداد پنل هدف">
                <input type="number" min={1} max={28} value={target} onChange={(e) => setTarget(Number(e.target.value))} style={{ width: 90 }} />
              </Field>
              <Button onClick={() => void splitLocal(false)} disabled={busy}>
                پیش‌نمایش تقسیم محلی
              </Button>
              <Button variant="primary" onClick={() => void splitLocal(true)} disabled={busy}>
                افزودن پنل‌های محلی
              </Button>
              <Button onClick={() => void adaptWithAi()} disabled={busy}>
                اقتباس با AI (پس‌زمینه)
              </Button>
            </div>
            {aiRequestId ? (
              <Notice tone={aiStatus === "failed" ? "bad" : "info"}>
                وضعیت درخواست: <strong>{STATUS_LABELS[aiStatus ?? ""] ?? aiStatus}</strong>
                {aiStatus === "succeeded" ? (
                  <Button size="sm" variant="primary" onClick={() => void useAiResult()} style={{ marginInlineStart: 8 }}>
                    افزودن نتیجه به برد
                  </Button>
                ) : null}
                {job ? <span className="small muted"> · کار در صف باقی می‌ماند حتی اگر برنامه بسته شود (بدون ارسال دوباره).</span> : null}
              </Notice>
            ) : null}
            <p className="small muted">
              تقسیم محلی بدون AI و بدون هزینه است. اقتباس با AI نیازمند کلید و هزینهٔ توکن است؛ نتیجه پیش از افزودن باید
              تأیید شما را بگیرد.
            </p>
          </>
        )}
      </Card>

      {scene ? (
        <Card title="دستیار نوشتن و کارگردانی">
          <p className="small muted">
            این سه کار از مدل متنی پروژه استفاده می‌کنند و در پس‌زمینه اجرا می‌شوند. هیچ‌کدام بدون تأیید شما متن یا مرجع قطعی را
            تغییر نمی‌دهد.
          </p>
          <div className="row" style={{ marginBottom: 8 }}>
            <Button onClick={() => void runAssistant("extract")} disabled={busy || Boolean(assistantRequestId)}>
              استخراج شخصیت/مکان/شیء و واقعیت از متن
            </Button>
            <Button onClick={() => void runAssistant("suggest")} disabled={busy || Boolean(assistantRequestId)}>
              پیشنهاد ویرایش جمله‌ها
            </Button>
            <Button onClick={() => void runAssistant("director")} disabled={busy || Boolean(assistantRequestId) || panels.length === 0}>
              یادداشت کارگردانی برای پنل‌ها
            </Button>
          </div>
          {assistantRequestId ? <Spinner label="در انتظار نتیجهٔ مدل…" /> : null}

          {assistant && assistantKind === "extract" ? (
            <div>
              {(() => {
                const data = assistant.parsed as {
                  characters?: Array<{ name: string; description: string; evidence: string }>;
                  locations?: Array<{ name: string; description: string }>;
                  objects?: Array<{ name: string; description: string }>;
                  facts?: Array<{ subjectName: string; attribute: string; value: string }>;
                  notes?: string[];
                };
                const list = [
                  ...(data.characters ?? []).map((c) => `شخصیت: ${c.name}${c.description ? ` — ${c.description}` : ""}`),
                  ...(data.locations ?? []).map((c) => `مکان: ${c.name}${c.description ? ` — ${c.description}` : ""}`),
                  ...(data.objects ?? []).map((c) => `شیء: ${c.name}${c.description ? ` — ${c.description}` : ""}`),
                  ...(data.facts ?? []).map((f) => `واقعیت: ${f.subjectName} / ${f.attribute}: ${f.value}`),
                ];
                return (
                  <>
                    {assistant.note ? <Notice tone="warn">{assistant.note}</Notice> : null}
                    <ul className="small">
                      {list.map((line, index) => (
                        <li key={index}>{line}</li>
                      ))}
                    </ul>
                    {list.length === 0 ? <p className="small muted">چیزی پیدا نشد.</p> : null}
                    <Button variant="primary" onClick={() => void applyExtract()} disabled={busy || list.length === 0}>
                      افزودن به‌صورت «پیشنهادی»
                    </Button>
                    <span className="small muted"> پیشنهادها وارد مرجع قطعی نمی‌شوند و باید در بخش جهان داستان تأیید شوند.</span>
                  </>
                );
              })()}
            </div>
          ) : null}

          {assistant && assistantKind === "suggest" ? (
            <div>
              {assistant.note ? <Notice tone="warn">{assistant.note}</Notice> : null}
              {(() => {
                const data = assistant.parsed as { suggestions?: Array<{ original: string; replacement: string; reason: string }> };
                const items = data.suggestions ?? [];
                return (
                  <>
                    {items.map((item, index) => (
                      <div key={index} className="issue">
                        <div className="row">
                          <input
                            type="checkbox"
                            checked={picked.includes(index)}
                            onChange={(e) =>
                              setPicked((current) => (e.target.checked ? [...current, index] : current.filter((i) => i !== index)))
                            }
                            aria-label="انتخاب پیشنهاد"
                          />
                          <div>
                            <div className="small" dir="rtl">
                              <del>{item.original}</del>
                            </div>
                            <div className="small" dir="rtl">
                              {item.replacement}
                            </div>
                            {item.reason ? <div className="small muted">{item.reason}</div> : null}
                          </div>
                        </div>
                      </div>
                    ))}
                    {items.length === 0 ? <p className="small muted">پیشنهادی برنگشت.</p> : null}
                    <Button variant="primary" onClick={() => void applySuggestions()} disabled={busy || picked.length === 0}>
                      اعمال پیشنهادهای انتخاب‌شده
                    </Button>
                    <span className="small muted"> متن اصلی تا این لحظه تغییری نمی‌کند؛ نسخهٔ قبلی در تاریخچه می‌ماند.</span>
                  </>
                );
              })()}
            </div>
          ) : null}

          {assistant && assistantKind === "director" ? (
            <div>
              <ul className="small">
                {((assistant.parsed as { notes?: Array<{ panelIndex: number; kind: string; note: string; suggestion: string }> }).notes ?? []).map(
                  (note, index) => (
                    <li key={index}>
                      پنل {note.panelIndex} · {note.kind}: {note.note}
                      {note.suggestion ? <span className="muted"> — {note.suggestion}</span> : null}
                    </li>
                  ),
                )}
              </ul>
              <p className="small muted">این یادداشت‌ها فقط خواندنی‌اند؛ تغییر پنل‌ها دست شماست.</p>
            </div>
          ) : null}
        </Card>
      ) : null}

      <Card title={`پنل‌های صحنه (${panels.length})`} actions={loading ? <Spinner label="" /> : null}>
        {panels.length === 0 ? (
          <Empty title="پنلی برای این صحنه نیست." hint="با تقسیم محلی یا اقتباس AI بسازید." />
        ) : (
          <div className="panel-grid">
            {[...panels]
              .sort((a, b) => (ctx.panelOrder === "rtl" ? b.position - a.position : a.position - b.position))
              .map((panel) => (
                <div
                  key={panel.id}
                  className={`panel-card ${ctx.selectedPanelId === panel.id ? "active" : ""}`}
                  onClick={() => {
                    setSelectedPanelId(panel.id);
                    setView("board");
                  }}
                >
                  {panel.imageAssetId ? <img src={`/api/assets/${panel.imageAssetId}`} alt={panel.title} loading="lazy" /> : <div style={{ height: 150 }} />}
                  <div className="body">
                    <div className="row between">
                      <strong>
                        {panel.position}. {panel.title}
                      </strong>
                      {panel.needsReview ? <Badge tone="warn">بازبینی</Badge> : <Badge tone="muted">{STATUS_LABELS[panel.status] ?? panel.status}</Badge>}
                    </div>
                    <span className="small muted">
                      {SHOT_LABELS[panel.shotSize] ?? panel.shotSize} · {panel.dialogue.length} دیالوگ
                    </span>
                    <span className="small" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                      {panel.action}
                    </span>
                    <div className="row">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          void removePanel(panel);
                        }}
                      >
                        حذف
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
          </div>
        )}
      </Card>

      {preview ? (
        <Modal
          title={`پیش‌نمایش ${preview.length} پنل (ذخیره نشده)`}
          onClose={() => setPreview(null)}
          wide
        >
          <Notice tone="info">
            این پیشنهاد فقط پیش‌نمایش است. با «افزودن»، پنل‌ها به برد اضافه می‌شوند و به نسخهٔ فعلی متن گره می‌خورند.
          </Notice>
          <div className="col">
            {preview.map((panel, index) => (
              <div key={index} className="list-item" style={{ cursor: "default", alignItems: "flex-start" }}>
                <div>
                  <strong className="small">
                    {panel.position}. {panel.title}
                  </strong>
                  <div className="small">{panel.action}</div>
                  <div className="small muted">
                    {panel.dialogue.map((d) => `«${d.text}»`).join(" ") || "بدون دیالوگ"}
                  </div>
                </div>
                <Badge>{SHOT_LABELS[panel.shotSize] ?? panel.shotSize}</Badge>
              </div>
            ))}
          </div>
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
            <Button variant="ghost" onClick={() => setPreview(null)}>
              انصراف
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setPreview(null);
                void splitLocal(true);
              }}
            >
              افزودن به برد
            </Button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
