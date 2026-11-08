"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ANGLE_LABELS, api, SHOT_LABELS, STATUS_LABELS } from "@/lib/api";
import { useWorkspace } from "@/components/workspace";
import { Badge, Button, Empty, ErrorNote, Field, Notice, Spinner, StatusBadge } from "@/components/ui";
import type { Panel, PanelCharacter, PanelDialogue } from "@/lib/types";

const SHOTS = ["wide", "medium", "close", "extreme_close", "over_shoulder", "detail"] as const;
const ANGLES = ["eye", "low", "high", "birds_eye", "dutch"] as const;

export default function BoardView() {
  const ctx = useWorkspace();
  const { bundle, selectedSceneId, selectedPanelId, setSelectedPanelId, panelOrder } = ctx;
  const [panels, setPanels] = useState<Panel[]>([]);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [inspector, setInspector] = useState(true);

  const loadPanels = useCallback(async () => {
    if (!selectedSceneId) return;
    setLoading(true);
    try {
      const data = await api<{ panels: Panel[] }>(`/api/projects/${bundle.project.id}/panels?sceneId=${selectedSceneId}`);
      setPanels(data.panels);
      const keep = data.panels.find((p) => p.id === selectedPanelId) ?? data.panels[0] ?? null;
      setSelectedPanelId(keep?.id ?? null);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [bundle.project.id, selectedSceneId, selectedPanelId, setSelectedPanelId]);

  useEffect(() => {
    void loadPanels();
  }, [loadPanels]);

  useEffect(() => {
    if (!selectedPanelId) {
      setPanel(null);
      return;
    }
    let cancelled = false;
    void api<{ panel: Panel }>(`/api/panels/${selectedPanelId}?plan=0`)
      .then((data) => {
        if (!cancelled) setPanel(data.panel);
      })
      .catch((err) => setError(err));
    return () => {
      cancelled = true;
    };
  }, [selectedPanelId]);

  const patch = async (changes: Partial<Panel>) => {
    if (!panel) return;
    setSaving(true);
    try {
      const data = await api<{ panel: Panel }>(`/api/panels/${panel.id}`, { method: "PATCH", json: changes });
      setPanel(data.panel);
      setPanels((list) => list.map((p) => (p.id === data.panel.id ? data.panel : p)));
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  const approve = async () => {
    if (!panel) return;
    setSaving(true);
    try {
      await api(`/api/panels/${panel.id}/actions`, { method: "POST", json: { action: "approve" } });
      setNotice("پنل تأیید شد. تأیید نهایی پنل با شماست؛ این کار تصویری تولید نمی‌کند.");
      await loadPanels();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  /** ترتیب روایت همیشه از position کوچک به بزرگ ذخیره می‌شود؛ نمایش ممکن است راست‌به‌چپ باشد. */
  const ordered = useMemo(() => [...panels].sort((a, b) => a.position - b.position), [panels]);

  const move = async (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= ordered.length) return;
    const next = [...ordered];
    [next[index], next[target]] = [next[target], next[index]];
    setPanels(next.map((item, i) => ({ ...item, position: i + 1 })));
    setSaving(true);
    try {
      const data = await api<{ panels: Panel[] }>(`/api/projects/${bundle.project.id}/panels`, {
        method: "POST",
        json: { action: "reorder", sceneId: selectedSceneId, orderedIds: next.map((item) => item.id) },
      });
      setPanels(data.panels);
      setNotice("ترتیب پنل‌ها ذخیره شد؛ خروجی و صفحه‌بندی هم همین ترتیب را می‌گیرند.");
      setError(null);
    } catch (err) {
      setError(err);
      await loadPanels();
    } finally {
      setSaving(false);
    }
  };

  const updateCharacter = (index: number, patchChar: Partial<PanelCharacter>) => {
    if (!panel) return;
    const characters = panel.characters.map((c, i) => (i === index ? { ...c, ...patchChar } : c));
    setPanel({ ...panel, characters });
  };

  const updateDialogue = (index: number, patchLine: Partial<PanelDialogue>) => {
    if (!panel) return;
    const dialogue = panel.dialogue.map((d, i) => (i === index ? { ...d, ...patchLine } : d));
    setPanel({ ...panel, dialogue });
  };

  const scene = bundle.scenes.find((s) => s.id === selectedSceneId) ?? null;
  const missingImages = ordered.filter((item) => !item.imageAssetId).length;

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        <select value={selectedSceneId ?? ""} onChange={(e) => ctx.setSelectedSceneId(e.target.value || null)} style={{ width: 240 }} aria-label="صحنه">
          <option value="">— صحنه —</option>
          {bundle.scenes.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        <Badge>{panels.length} پنل</Badge>
        {missingImages ? <Badge tone="warn">{missingImages} پنل بدون تصویر</Badge> : null}
        {saving ? <Badge tone="muted">در حال ذخیره…</Badge> : null}
        <span className="grow" />
        <span className="small muted">ترتیب نمایش: {panelOrder === "rtl" ? "راست به چپ" : "چپ به راست"}</span>
        <Button size="sm" variant="ghost" onClick={() => setInspector((current) => !current)} aria-pressed={inspector}>
          {inspector ? "بستن جزئیات" : "جزئیات پنل"}
        </Button>
      </div>

      <ErrorNote error={error} onRetry={() => void loadPanels()} />
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

      <div className="board" data-inspector={inspector ? "open" : "closed"}>
        <div className="col" style={{ minWidth: 0 }}>
          {loading ? <Spinner /> : null}
          {!scene ? (
            <Empty title="صحنه را انتخاب کنید." />
          ) : panels.length === 0 ? (
            <Empty title="این صحنه پنلی ندارد." hint="در بخش «صحنه‌ها و پنل‌ها» پنل بسازید." />
          ) : (
            <div className="board-grid" dir={panelOrder}>
              {[...ordered]
                .map((item, index) => ({ item, index }))
                .sort((a, b) => (panelOrder === "rtl" ? b.index - a.index : a.index - b.index))
                .map(({ item, index }) => {
                  const displayIndex = panelOrder === "rtl" ? ordered.length - 1 - index : index;
                  return (
                    <article
                      key={item.id}
                      className={`board-card ${item.id === panel?.id ? "active" : ""}`}
                      onClick={() => setSelectedPanelId(item.id)}
                      onKeyDown={(event) => {
                        if (!event.altKey) return;
                        if (event.key === "ArrowRight") {
                          event.preventDefault();
                          void move(displayIndex, -1);
                        }
                        if (event.key === "ArrowLeft") {
                          event.preventDefault();
                          void move(displayIndex, 1);
                        }
                      }}
                      tabIndex={0}
                      role="button"
                      aria-pressed={item.id === panel?.id}
                      aria-label={`پنل ${item.position}: ${item.title}`}
                    >
                      <div className="board-thumb">
                        {item.imageAssetId ? (
                          <img src={`/api/assets/${item.imageAssetId}`} alt="" loading="lazy" />
                        ) : (
                          <span className="small muted">بدون تصویر</span>
                        )}
                        <span className="board-num">{item.position}</span>
                        {item.needsReview ? <span className="board-flag">نیازمند بازبینی</span> : null}
                      </div>
                      <div className="body">
                        <div className="row between">
                          <strong className="small">{item.title}</strong>
                          <Badge tone={item.imageAssetId ? "ok" : "warn"}>{item.imageAssetId ? "تصویر دارد" : "بدون تصویر"}</Badge>
                        </div>
                        <span className="small muted clamp-2">{item.action || item.narrativeGoal || "کنش ثبت نشده"}</span>
                        <div className="tiny muted">
                          {SHOT_LABELS[item.shotSize] ?? item.shotSize} · {ANGLE_LABELS[item.cameraAngle] ?? item.cameraAngle}
                          {item.characters.length ? ` · ${item.characters.map((c) => c.name).join("، ")}` : ""}
                        </div>
                        <div className="row" style={{ marginTop: "auto" }}>
                          <button
                            className="mini"
                            onClick={(event) => {
                              event.stopPropagation();
                              void move(displayIndex, -1);
                            }}
                            aria-label={`جابه‌جایی پنل ${item.position} به جایگاه پیشین`}
                            disabled={displayIndex === 0}
                          >
                            ›
                          </button>
                          <button
                            className="mini"
                            onClick={(event) => {
                              event.stopPropagation();
                              void move(displayIndex, 1);
                            }}
                            aria-label={`جابه‌جایی پنل ${item.position} به جایگاه بعدی`}
                            disabled={displayIndex === ordered.length - 1}
                          >
                            ‹
                          </button>
                          <span className="grow" />
                          <button
                            className="mini"
                            onClick={(event) => {
                              event.stopPropagation();
                              setSelectedPanelId(item.id);
                              ctx.setView("produce");
                            }}
                            aria-label={`تولید تصویر برای پنل ${item.position}`}
                          >
                            ✦
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
            </div>
          )}
          <p className="small muted">
            برای جابه‌جایی، پنل را انتخاب و با Alt + کلید جهت‌دار حرکت دهید؛ تغییر بلافاصله ذخیره می‌شود و قابل بازگشت است.
          </p>
        </div>

        {inspector ? (
          <aside className="board-side">
            {!panel ? (
              <p className="small muted">پنلی را از برد انتخاب کنید.</p>
            ) : (
              <>
                <div className="row between">
                  <h3 style={{ fontSize: "var(--fs-md)" }}>
                    {panel.position}. {panel.title}
                  </h3>
                  <StatusBadge status={panel.status} />
                </div>
                {panel.needsReview ? (
                  <Notice tone="warn">متن صحنه پس از ساخت این پنل تغییر کرده است؛ پیش‌نمایش و تصویر را بازبینی کنید.</Notice>
                ) : null}

                <div className="col" style={{ gap: 10, marginTop: 10 }}>
                  <Field label="عنوان پنل">
                    <input defaultValue={panel.title} onBlur={(event) => void patch({ title: event.target.value })} />
                  </Field>
                  <Field label="کنش قابل‌دیدن" hint="آنچه در تصویر دیده می‌شود، نه توضیح ذهنی.">
                    <textarea defaultValue={panel.action} rows={2} onBlur={(event) => void patch({ action: event.target.value })} />
                  </Field>
                  <Field label="هدف روایی">
                    <textarea defaultValue={panel.narrativeGoal} rows={2} onBlur={(event) => void patch({ narrativeGoal: event.target.value })} />
                  </Field>
                  <Field label="متن منبع (اتصال به رمان)" hint="با تغییر متن صحنه، این پنل نیازمند بازبینی می‌شود.">
                    <textarea defaultValue={panel.sourceExcerpt} rows={3} onBlur={(event) => void patch({ sourceExcerpt: event.target.value })} />
                  </Field>
                  <div className="grid grid-2">
                    <Field label="اندازهٔ نما">
                      <select defaultValue={panel.shotSize} onChange={(event) => void patch({ shotSize: event.target.value as Panel["shotSize"] })}>
                        {SHOTS.map((shot) => (
                          <option key={shot} value={shot}>
                            {SHOT_LABELS[shot] ?? shot}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="زاویه">
                      <select defaultValue={panel.cameraAngle} onChange={(event) => void patch({ cameraAngle: event.target.value as Panel["cameraAngle"] })}>
                        {ANGLES.map((angle) => (
                          <option key={angle} value={angle}>
                            {ANGLE_LABELS[angle] ?? angle}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <div className="grid grid-2">
                    <Field label="جهت نگاه">
                      <input defaultValue={panel.gazeDirection} onBlur={(event) => void patch({ gazeDirection: event.target.value })} />
                    </Field>
                    <Field label="احساس">
                      <input defaultValue={panel.emotion} onBlur={(event) => void patch({ emotion: event.target.value })} />
                    </Field>
                    <Field label="نور">
                      <input defaultValue={panel.lighting} onBlur={(event) => void patch({ lighting: event.target.value })} />
                    </Field>
                    <Field label="لباس">
                      <input defaultValue={panel.costumes} onBlur={(event) => void patch({ costumes: event.target.value })} />
                    </Field>
                  </div>

                  <h4>حاضران در کادر</h4>
                  {panel.characters.length === 0 ? <p className="small muted">شخصیتی ثبت نشده است.</p> : null}
                  {panel.characters.map((character, index) => (
                    <div key={index} className="issue">
                      <div className="row between">
                        <strong className="small">{character.name}</strong>
                        <Badge tone="muted">{character.position || "بدون جایگاه"}</Badge>
                      </div>
                      <input
                        defaultValue={character.position}
                        placeholder="جایگاه در کادر (چپ/راست/مرکز)"
                        aria-label={`جایگاه ${character.name}`}
                        onBlur={(event) => updateCharacter(index, { position: event.target.value })}
                      />
                      <Button size="sm" variant="ghost" onClick={() => setPanel({ ...panel, characters: panel.characters.filter((_, i) => i !== index) })}>
                        برداشتن از کادر
                      </Button>
                    </div>
                  ))}
                  <Button size="sm" onClick={() => void patch({ characters: panel.characters })} disabled={saving}>
                    ذخیرهٔ حاضران
                  </Button>

                  {panel.dialogue.length ? (
                    <>
                      <h4>دیالوگ‌ها</h4>
                      {panel.dialogue.map((line, index) => (
                        <div key={index} className="issue">
                          <input defaultValue={line.speaker} aria-label="گوینده" onBlur={(event) => updateDialogue(index, { speaker: event.target.value })} />
                          <textarea defaultValue={line.text} rows={2} aria-label="متن دیالوگ" onBlur={(event) => updateDialogue(index, { text: event.target.value })} />
                        </div>
                      ))}
                      <Button size="sm" onClick={() => void patch({ dialogue: panel.dialogue })} disabled={saving}>
                        ذخیرهٔ دیالوگ‌ها
                      </Button>
                    </>
                  ) : null}
                </div>

                <div className="row" style={{ marginTop: 12 }}>
                  <Button size="sm" onClick={() => void approve()} disabled={saving}>
                    تأیید پنل
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => ctx.setView("produce")}>
                    تولید تصویر
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => ctx.setView("review")}>
                    بازبینی
                  </Button>
                </div>
              </>
            )}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
