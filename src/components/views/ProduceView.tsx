"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ManualImagePanel from "@/components/ManualImagePanel";
import { api, errorText, formatUsd, STATUS_LABELS } from "@/lib/api";
import { useWorkspace } from "@/components/workspace";
import { Badge, Button, Empty, ErrorNote, Field, Notice, Spinner, StatusBadge, Toggle, useDebounced } from "@/components/ui";
import type { AiRequest, Job, Panel, PanelTake, ReviewReport } from "@/lib/types";

interface Plan {
  panelId: string;
  provider: string;
  model: string;
  prompt: string;
  references: Array<{ index: number; id: string; title: string; roles: string[]; entityName: string; thumbUrl: string; version: number }>;
  attachments: Array<{ index: number; referenceId: string; referenceTitle: string; assetSha256: string; roles: string[]; entityName: string }>;
  dropped: Array<{ title: string; reason: string }>;
  warnings: string[];
  blocking: string[];
  size: string;
  aspectRatio: string;
  imageSize: string;
  costEstimate: { usd: number | null; basis: string; source?: string; kind: "estimate" };
  caps: {
    generationsPerPanel: number;
    used: number;
    inFlight: number;
    remaining: number;
    reviewsPerPanel: number;
    reviewsUsed: number;
    reviewsInFlight: number;
  };
  budget: { budgetUsd: number | null; knownUsd: number; reservedUsd: number; unknownCount: number; overBudget: boolean; policy: string; explanation: string };
  knowledge: Array<{ name: string; knows: string[]; suspects: string[]; withheld: string[] }>;
  identityConflicts: Array<{
    entityId: string;
    entityName: string;
    layer: string;
    message: string;
    candidates: Array<{ id: string; label: string; layer: string; validFrom: string | null; validTo: string | null; approvedAt: string | null }>;
  }>;
  supportsMask: boolean;
  canon: Array<{ subject: string; attribute: string; value: string | null; status: string; reason: string }>;
  conflicts: string[];
  requestKey: string;
}

interface ModelInfo {
  id: string;
  label: string;
  provider: string;
  kind: string;
  capabilities: { sizes: string[]; aspectRatios: string[]; maxReferenceImages: number; mask: boolean; seed: boolean };
  price: { note?: string; sourceUrl: string };
}

interface Options {
  size: string;
  imageSize: string;
  aspectRatio: string;
  allowedChanges: string;
  constraints: string;
}

const EMPTY_OPTIONS: Options = { size: "", imageSize: "1K", aspectRatio: "9:16", allowedChanges: "", constraints: "" };

export default function ProduceView() {
  const ctx = useWorkspace();
  const { bundle, selectedSceneId, selectedPanelId, setSelectedPanelId } = ctx;
  const [manualMode, setManualMode] = useState(false);
  useEffect(() => { const refresh = () => void api<{ imageWorkflow: string }>("/api/settings/chatgpt").then(s => setManualMode(s.imageWorkflow === "manual_chatgpt")).catch(() => undefined); refresh(); window.addEventListener("focus", refresh); return () => window.removeEventListener("focus", refresh); }, []);
  const [panels, setPanels] = useState<Panel[]>([]);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [takes, setTakes] = useState<PanelTake[]>([]);
  const [reviews, setReviews] = useState<ReviewReport[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [requests, setRequests] = useState<AiRequest[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [options, setOptions] = useState<Options>(EMPTY_OPTIONS);
  const [pinned, setPinned] = useState<string[] | null>(null);
  const [ackConflicts, setAckConflicts] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editSource, setEditSource] = useState<string>("");
  const [maskAssetId, setMaskAssetId] = useState<string | null>(null);
  const [maskName, setMaskName] = useState<string>("");
  const [editInstruction, setEditInstruction] = useState("");
  const [brush, setBrush] = useState(false);
  const [showMaskPreview, setShowMaskPreview] = useState(true);
  const [zoom, setZoom] = useState(1);
  const adopted = useRef<string | null>(null);

  const debouncedOptions = useDebounced(options, 450);
  const debouncedPinned = useDebounced(pinned, 450);

  const loadPanels = useCallback(async () => {
    if (!selectedSceneId) return;
    const data = await api<{ panels: Panel[] }>(`/api/projects/${bundle.project.id}/panels?sceneId=${selectedSceneId}`);
    setPanels(data.panels);
    if (!data.panels.some((p) => p.id === selectedPanelId)) setSelectedPanelId(data.panels[0]?.id ?? null);
  }, [bundle.project.id, selectedSceneId, selectedPanelId, setSelectedPanelId]);

  const loadJobs = useCallback(async () => {
    try {
      const data = await api<{ jobs: Job[]; requests: AiRequest[] }>(`/api/projects/${bundle.project.id}/jobs`);
      setJobs(data.jobs);
      setRequests(data.requests);
    } catch {
      /* گذرا */
    }
  }, [bundle.project.id]);

  const loadDetail = useCallback(async () => {
    if (!selectedPanelId) {
      setPanel(null);
      setPlan(null);
      setTakes([]);
      return;
    }
    try {
      const data = await api<{ panel: Panel; takes: PanelTake[]; reviews: ReviewReport[] }>(`/api/panels/${selectedPanelId}?plan=0`);
      setPanel(data.panel);
      setTakes(data.takes);
      setReviews(data.reviews);
    } catch (err) {
      setError(err);
    }
  }, [selectedPanelId]);

  /**
   * پیش‌نمایش با همان گزینه‌های فعلی فرم ساخته می‌شود؛ اگر چیزی تغییر کند،
   * پیش‌نمایش کهنه می‌شود و تا رسیدن نسخهٔ تازه، دکمهٔ ارسال غیرفعال است.
   */
  const loadPlan = useCallback(async () => {
    if (!selectedPanelId) return;
    setPlanLoading(true);
    try {
      const params = new URLSearchParams({ plan: "1" });
      if (debouncedOptions.size) params.set("size", debouncedOptions.size);
      if (debouncedOptions.imageSize) params.set("imageSize", debouncedOptions.imageSize);
      if (debouncedOptions.aspectRatio) params.set("aspectRatio", debouncedOptions.aspectRatio);
      if (debouncedOptions.allowedChanges) params.set("allowedChanges", debouncedOptions.allowedChanges);
      if (debouncedOptions.constraints) params.set("constraints", debouncedOptions.constraints);
      (debouncedPinned ?? []).forEach((id) => params.append("reference", id));
      const data = await api<{ panel: Panel; plan: Plan | null; planError: string | null }>(`/api/panels/${selectedPanelId}?${params.toString()}`);
      setPanel(data.panel);
      setPlan(data.plan);
      setPlanError(data.planError);
      if (data.plan) {
        // نخستین بار، مقدارهای پیش‌فرض سرور در فرم می‌نشینند تا آنچه دیده می‌شود همان باشد که می‌رود.
        if (adopted.current !== selectedPanelId) {
          adopted.current = selectedPanelId;
          setOptions((current) => ({
            ...current,
            size: data.plan!.size || current.size,
            imageSize: data.plan!.imageSize || current.imageSize,
            aspectRatio: data.plan!.aspectRatio || current.aspectRatio,
          }));
        }
      }
    } catch (err) {
      setPlanError(errorText(err).message);
    } finally {
      setPlanLoading(false);
    }
  }, [selectedPanelId, debouncedOptions, debouncedPinned]);

  useEffect(() => {
    void loadPanels();
  }, [loadPanels]);
  useEffect(() => {
    setOptions(EMPTY_OPTIONS);
    setPinned(null);
    setAckConflicts(false);
    setMaskAssetId(null);
    setMaskName("");
    adopted.current = null;
    void loadDetail();
  }, [loadDetail]);
  useEffect(() => {
    void loadPlan();
  }, [loadPlan]);
  useEffect(() => {
    void api<{ models: ModelInfo[] }>("/api/settings").then((d) => setModels(d.models)).catch(() => undefined);
    void loadJobs();
  }, [loadJobs]);

  const activeRequest = requests.find((r) => ["queued", "sending", "processing"].includes(r.status));
  useEffect(() => {
    if (!activeRequest) return;
    const timer = setInterval(() => {
      void loadJobs();
      void loadDetail();
    }, 3000);
    return () => clearInterval(timer);
  }, [activeRequest, loadJobs, loadDetail]);

  const model = models.find((m) => m.id === (plan?.model ?? bundle.project.settings.image.model));
  const accepted = takes.find((take) => take.status === "accepted") ?? null;
  const shownTake = accepted ?? takes[0] ?? null;
  const approvedRefs = useMemo(() => bundle.references.filter((ref) => ref.status === "approved"), [bundle.references]);
  const planRefs = plan?.references ?? [];
  const usingAutoRefs = pinned === null;

  const updateOptions = (patch: Partial<Options>) => setOptions((current) => ({ ...current, ...patch }));

  const movePin = (index: number, delta: number) => {
    const list = pinned ?? planRefs.map((r) => r.id);
    const next = [...list];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setPinned(next);
  };

  const produce = async () => {
    if (!panel || !plan) return;
    if (planLoading) return;
    setBusy(true);
    setError(null);
    try {
      const data = await api<{ job: Job; requestId: string; note: string }>(`/api/panels/${panel.id}/actions`, {
        method: "POST",
        json: {
          action: "produce",
          options: {
            size: plan.provider === "openai" ? plan.size : undefined,
            imageSize: plan.provider === "google" ? plan.imageSize : undefined,
            aspectRatio: plan.provider === "google" ? plan.aspectRatio : undefined,
            allowedChanges: options.allowedChanges || undefined,
            constraints: options.constraints || undefined,
            referenceIds: plan.references.map((r) => r.id),
            expectedRequestKey: plan.requestKey,
            acknowledgeIdentityConflicts: ackConflicts && plan.identityConflicts.length > 0,
          },
        },
      });
      setNotice(data.note);
      await loadJobs();
      await loadDetail();
      await loadPlan();
    } catch (err) {
      const info = errorText(err);
      if (/plan_outdated|پیش‌نمایش/.test(`${(err as { code?: string }).code ?? ""} ${info.message}`)) {
        setNotice("گزینه‌ها پس از ساخت پیش‌نمایش تغییر کرده بودند؛ پیش‌نمایش تازه ساخته شد. یک بار دیگر بررسی و ارسال کنید.");
        await loadPlan();
      }
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const act = async (payload: Record<string, unknown>, message?: string) => {
    if (!panel) return;
    setBusy(true);
    try {
      await api(`/api/panels/${panel.id}/actions`, { method: "POST", json: payload });
      if (message) setNotice(message);
      await loadDetail();
      await loadPlan();
      await loadJobs();
      await ctx.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const cancelJob = async (job: Job) => {
    try {
      await api(`/api/jobs/${job.id}`, { method: "POST", json: { action: "cancel" } });
      setNotice("لغو محلی ثبت شد. اگر درخواست قبلاً به سرویس رسیده باشد، ممکن است پردازش ادامه یابد.");
      await loadJobs();
    } catch (err) {
      setError(err);
    }
  };

  const maskedSource = editSource || accepted?.id || takes[0]?.id || "";
  const sourceTake = takes.find((take) => take.id === maskedSource) ?? null;

  const uploadMaskDataUrl = async (dataUrl: string, filename: string) => {
    if (!panel) return;
    if (!maskedSource) {
      setError(new Error("برای اصلاح ناحیه‌ای نخست یک خروجی تولید یا انتخاب کنید."));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const data = await api<{ asset: { id: string; width: number | null; height: number | null } }>(`/api/panels/${panel.id}/mask`, {
        method: "POST",
        json: { dataUrl, filename, sourceTakeId: maskedSource },
      });
      setMaskAssetId(data.asset.id);
      setMaskName(`${filename} (${data.asset.width ?? "?"}×${data.asset.height ?? "?"})`);
      setNotice("ماسک ثبت شد و ابعادش با خروجی مبدأ سنجیده شد. ناحیهٔ روشن‌شده اصلاح می‌شود.");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const uploadMaskFile = async (file: File) => {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("خواندن فایل ماسک ممکن نشد."));
      reader.readAsDataURL(file);
    });
    await uploadMaskDataUrl(dataUrl, file.name);
  };

  const submitEdit = async () => {
    if (!panel) return;
    setBusy(true);
    setError(null);
    try {
      const data = await api<{ job: Job; requestId: string; note: string }>(`/api/panels/${panel.id}/actions`, {
        method: "POST",
        json: {
          action: "produce-edit",
          sourceTakeId: maskedSource,
          maskAssetId,
          editKind: maskAssetId ? "inpaint" : "refine",
          editInstruction: editInstruction || undefined,
          options: { allowedChanges: options.allowedChanges || undefined, constraints: options.constraints || undefined },
        },
      });
      setNotice(data.note);
      await loadJobs();
      await loadDetail();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const scene = bundle.scenes.find((s) => s.id === selectedSceneId) ?? null;
  const formChanged = useMemo(() => {
    if (!plan) return false;
    return (
      (plan.provider === "openai" && options.size && options.size !== plan.size) ||
      (plan.provider === "google" && (options.imageSize !== plan.imageSize || options.aspectRatio !== plan.aspectRatio))
    );
  }, [plan, options]);

  return (
    <div className="col" style={{ gap: 14 }}>
      {manualMode && selectedPanelId && <ManualImagePanel panelId={selectedPanelId} options={{ ...options, referenceIds: plan?.references.map(r => r.id), expectedRequestKey: plan?.requestKey }} onImported={async () => { await loadDetail(); await loadJobs(); }} />}
      {manualMode && <Notice tone="info">حالت انتقال دستی فعال است؛ تولید و اصلاح خودکار API غیرفعال‌اند. برای تغییر، به تنظیمات اتصال‌ها بروید.</Notice>}
      <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
        <div className="row" style={{ gap: 8 }}>
          <select value={selectedSceneId ?? ""} onChange={(e) => ctx.setSelectedSceneId(e.target.value || null)} style={{ width: 200 }} aria-label="صحنه">
            <option value="">— صحنه —</option>
            {bundle.scenes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
          <select value={selectedPanelId ?? ""} onChange={(e) => setSelectedPanelId(e.target.value || null)} style={{ width: 190 }} aria-label="پنل">
            <option value="">— پنل —</option>
            {panels.map((p) => (
              <option key={p.id} value={p.id}>
                {p.position}. {p.title}
              </option>
            ))}
          </select>
        </div>
        <span className="grow" />
        {activeRequest ? <Badge tone="warn">⟳ درخواست در جریان: {STATUS_LABELS[activeRequest.status] ?? activeRequest.status}</Badge> : null}
        {plan ? (
          <Badge tone={planLoading ? "warn" : formChanged ? "warn" : "ok"}>
            {planLoading ? "به‌روزرسانی پیش‌نمایش…" : formChanged ? "پیش‌نمایش کهنه" : "پیش‌نمایش به‌روز"}
          </Badge>
        ) : null}
      </div>

      <ErrorNote error={error} onRetry={() => void loadPlan()} />
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
      {!scene ? <Empty title="صحنه را انتخاب کنید." /> : null}
      {scene && panels.length === 0 ? <Empty title="پنلی برای تولید نیست." hint="نخست در بخش «صحنه‌ها و پنل‌ها» پنل بسازید." /> : null}

      {panel && planError ? (
        <Notice tone="bad">
          <strong>ساخت پیش‌نمایش ممکن نشد:</strong> {planError}
          <div className="small muted">مدل و کلید اتصال را در تنظیمات بررسی کنید. نوشتن و ذخیره بدون کلید کار می‌کند.</div>
        </Notice>
      ) : null}

      {panel ? (
        <div className="stage">
          <div className="col" style={{ minWidth: 0 }}>
            <div className="stage-frame">
              {shownTake ? (
                <div className="zoom-wrap" style={{ transform: `scale(${zoom})` }}>
                  <img
                    src={maskAssetId && showMaskPreview && sourceTake ? sourceTake.imageUrl : shownTake.imageUrl}
                    alt={`پنل ${panel.position}: ${panel.title}`}
                    style={{ maxHeight: "62vh", width: "auto", objectFit: "contain", borderRadius: 8 }}
                  />
                  {maskAssetId && showMaskPreview ? (
                    <img
                      src={`/api/assets/${maskAssetId}`}
                      alt="نمای ماسک روی تصویر"
                      className="mask-overlay"
                      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", opacity: 0.55, mixBlendMode: "screen" }}
                    />
                  ) : null}
                </div>
              ) : (
                <div className="stage-empty">
                  <span className="big" aria-hidden>
                    ◫
                  </span>
                  <strong>هنوز تصویری برای این پنل نیست</strong>
                  <span className="small muted">پیش‌نمایش ورودی را بررسی کنید و تولید را شروع کنید.</span>
                </div>
              )}
            </div>

            <div className="row" style={{ marginTop: 8 }}>
              <Button size="sm" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2)))} aria-label="کوچک‌نمایی">
                −
              </Button>
              <span className="small muted" style={{ minWidth: 44, textAlign: "center" }}>{Math.round(zoom * 100)}٪</span>
              <Button size="sm" onClick={() => setZoom((z) => Math.min(2.5, +(z + 0.1).toFixed(2)))} aria-label="بزرگ‌نمایی">
                +
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setZoom(1)}>
                اندازهٔ اصلی
              </Button>
              <span className="grow" />
              <span className="small muted">
                پنل {panel.position} از {panels.length} · {panel.characters.length} شخصیت · {panel.shotSize}
              </span>
            </div>

            <div className="refstrip">
              {planRefs.length === 0 ? <span className="small muted">مرجعی به این تولید وصل نیست.</span> : null}
              {planRefs.map((ref, index) => (
                <figure key={ref.id} title={`${ref.title} — ${ref.entityName}`}>
                  <img src={ref.thumbUrl} alt={`${ref.title} (${ref.entityName})`} loading="lazy" />
                  <figcaption>
                    {index + 1} · {ref.title}
                  </figcaption>
                  <div className="row" style={{ gap: 2 }}>
                    <button className="mini" onClick={() => movePin(index, -1)} disabled={index === 0} aria-label={`جابه‌جایی ${ref.title} به چپ`}>
                      ›
                    </button>
                    <button
                      className="mini"
                      onClick={() => movePin(index, 1)}
                      disabled={index === planRefs.length - 1}
                      aria-label={`جابه‌جایی ${ref.title} به راست`}
                    >
                      ‹
                    </button>
                    <button
                      className="mini"
                      onClick={() => setPinned((pinned ?? planRefs.map((r) => r.id)).filter((id) => id !== ref.id))}
                      aria-label={`برداشتن ${ref.title}`}
                    >
                      ✕
                    </button>
                  </div>
                </figure>
              ))}
            </div>

            <div className="row" style={{ marginTop: 8 }}>
              <select
                value=""
                onChange={(event) => {
                  if (!event.target.value) return;
                  const next = [...(pinned ?? planRefs.map((r) => r.id)), event.target.value];
                  setPinned([...new Set(next)]);
                }}
                aria-label="افزودن مرجع تأییدشده"
                style={{ maxWidth: 260 }}
              >
                <option value="">+ افزودن مرجع تأییدشده…</option>
                {approvedRefs
                  .filter((ref) => !planRefs.some((r) => r.id === ref.id))
                  .map((ref) => (
                    <option key={ref.id} value={ref.id}>
                      {ref.title} — {ref.roles.join("، ")}
                    </option>
                  ))}
              </select>
              {usingAutoRefs ? (
                <span className="small muted">مراجع خودکار از زمان صحنه انتخاب شده‌اند.</span>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setPinned(null)}>
                  بازگشت به انتخاب خودکار
                </Button>
              )}
            </div>
          </div>

          <aside className="stage-side">
            <div className="row between">
              <h3 style={{ fontSize: "var(--fs-md)" }}>{panel.title}</h3>
              <StatusBadge status={panel.status} />
            </div>
            <p className="small muted" style={{ marginTop: 2 }}>
              {panel.narrativeGoal || panel.action}
            </p>

            {plan ? (
              <>
                <div className="kv">
                  <dt>مدل</dt>
                  <dd>
                    <span className="lat" dir="ltr">
                      {plan.model}
                    </span>
                  </dd>
                  <dt>برآورد هزینه</dt>
                  <dd>
                    {formatUsd(plan.costEstimate.usd)} <span className="small muted">— {plan.costEstimate.basis}</span>
                  </dd>
                  <dt>ظرفیت این پنل</dt>
                  <dd>
                    {plan.caps.used} از {plan.caps.generationsPerPanel} استفاده‌شده
                    {plan.caps.inFlight ? ` · ${plan.caps.inFlight} در جریان` : ""}
                  </dd>
                </div>

                {plan.identityConflicts.length ? (
                  <Notice tone="bad">
                    <strong>تعارض نسخه‌های هویتی — تا تصمیم شما تولید متوقف است</strong>
                    <ul style={{ margin: "6px 0", paddingInlineStart: 18 }}>
                      {plan.identityConflicts.map((conflict) => (
                        <li key={`${conflict.entityId}-${conflict.layer}`} className="small">
                          {conflict.entityName} / {conflict.layer}: {conflict.candidates.map((c) => c.label || c.id.slice(0, 8)).join(" ←→ ")}
                        </li>
                      ))}
                    </ul>
                    <Toggle checked={ackConflicts} onChange={setAckConflicts} label="می‌دانم و با همین اطلاعات تولید می‌کنم" />
                  </Notice>
                ) : null}
                {plan.blocking.length ? (
                  <Notice tone="bad">
                    <strong>مجموعهٔ مراجع سازگار نیست</strong>
                    <ul style={{ margin: "6px 0", paddingInlineStart: 18 }}>
                      {plan.blocking.map((item, index) => (
                        <li key={index} className="small">
                          {item}
                        </li>
                      ))}
                    </ul>
                  </Notice>
                ) : null}
                {plan.conflicts.length ? (
                  <Notice tone="warn">
                    <strong>تعارض اطلاعات قطعی:</strong> {plan.conflicts.join(" | ")}
                  </Notice>
                ) : null}
                {plan.dropped.length ? (
                  <details>
                    <summary className="small muted">{plan.dropped.length} مرجع کنار گذاشته شد — چرا؟</summary>
                    <ul className="small muted">
                      {plan.dropped.map((d, i) => (
                        <li key={i}>
                          {d.title}: {d.reason}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}

                <div className="col" style={{ gap: 8, marginTop: "auto" }}>
                  <Button
                    variant="primary"
                    onClick={() => void produce()}
                    disabled={manualMode || busy || planLoading || plan.caps.remaining <= 0 || plan.blocking.length > 0 || (plan.identityConflicts.length > 0 && !ackConflicts)}
                  >
                    {busy ? "در حال ثبت…" : planLoading ? "در حال به‌روزرسانی پیش‌نمایش…" : "تولید تصویر با این ورودی"}
                  </Button>
                  {!plan.caps.remaining ? <span className="small muted">سقف محلی این پنل پر شده است؛ در تنظیمات پروژه قابل تغییر است.</span> : null}
                  {plan.identityConflicts.length && !ackConflicts ? (
                    <span className="small muted">تا تأیید تعارض هویتی، ارسال انجام نمی‌شود.</span>
                  ) : null}
                  <span className="small muted">کلیک دوباره با همان ورودی، درخواست تکراری نمی‌سازد.</span>
                </div>
              </>
            ) : panel ? (
              <Spinner label="در حال ساخت پیش‌نمایش…" />
            ) : null}

            <details className="advanced" open={showAdvanced} onToggle={(event) => setShowAdvanced((event.target as HTMLDetailsElement).open)}>
              <summary>گزینه‌های پیشرفته و پیش‌نمایش دقیق ارسال</summary>
              <div className="col" style={{ gap: 10, marginTop: 8 }}>
                <div className="grid grid-2">
                  <Field label="اندازه / کیفیت">
                    {plan?.provider === "openai" ? (
                      <select value={options.size} onChange={(e) => updateOptions({ size: e.target.value })}>
                        {(model?.capabilities.sizes ?? ["1024x1536", "1024x1024", "1536x1024"]).map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <div className="row">
                        <select value={options.imageSize} onChange={(e) => updateOptions({ imageSize: e.target.value })} aria-label="کیفیت">
                          {(model?.capabilities.sizes ?? ["1K", "2K", "4K"]).map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                        <select value={options.aspectRatio} onChange={(e) => updateOptions({ aspectRatio: e.target.value })} aria-label="نسبت">
                          {(model?.capabilities.aspectRatios ?? ["9:16", "1:1", "16:9"]).map((a) => (
                            <option key={a} value={a}>
                              {a}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </Field>
                  <Field label="تغییرات مجاز" hint="مثلاً «فقط لباس و نور اصلاح شود».">
                    <input value={options.allowedChanges} onChange={(e) => updateOptions({ allowedChanges: e.target.value })} />
                  </Field>
                  <Field label="محدودیت‌ها" hint="مثلاً «هیچ زخم تازه‌ای اضافه نشود».">
                    <input value={options.constraints} onChange={(e) => updateOptions({ constraints: e.target.value })} />
                  </Field>
                </div>

                {plan ? (
                  <>
                    <div className="pre small" dir="ltr" style={{ maxHeight: 220 }}>
                      {plan.prompt}
                    </div>
                    <div className="small muted">
                      ارسال به <span className="lat" dir="ltr">{plan.provider}/{plan.model}</span> · اندازه:{" "}
                      <span className="lat" dir="ltr">{plan.size || plan.imageSize}</span> · نسبت:{" "}
                      <span className="lat" dir="ltr">{plan.aspectRatio}</span> · {plan.attachments.length} پیوست
                    </div>
                    <ol className="small muted" style={{ paddingInlineStart: 18, margin: 0 }}>
                      {plan.attachments.map((att) => (
                        <li key={att.index}>
                          {att.index}. {att.referenceTitle} ({att.roles.join("، ")}) —{" "}
                          <span className="lat" dir="ltr">
                            {att.assetSha256.slice(0, 12)}
                          </span>
                        </li>
                      ))}
                    </ol>
                    <details>
                      <summary className="small muted">دانش شخصیت‌ها در این صحنه</summary>
                      <ul className="small muted">
                        {plan.knowledge.map((k) => (
                          <li key={k.name}>
                            <strong>{k.name}</strong>
                            {k.knows.length ? ` · می‌داند: ${k.knows.join("، ")}` : ""}
                            {k.suspects.length ? ` · گمان: ${k.suspects.join("، ")}` : ""}
                            {k.withheld.length ? ` · بی‌خبر از: ${k.withheld.join("، ")}` : ""}
                          </li>
                        ))}
                      </ul>
                    </details>
                    <details>
                      <summary className="small muted">اطلاعات قطعی استفاده‌شده</summary>
                      {plan.canon
                        .filter((c) => c.status === "resolved" && c.value)
                        .map((entry, index) => (
                          <div key={index} className="small">
                            {entry.subject} / {entry.attribute}: {entry.value}
                          </div>
                        ))}
                    </details>
                    {plan.warnings.map((w, i) => (
                      <Notice key={i} tone="warn">
                        {w}
                      </Notice>
                    ))}
                  </>
                ) : null}
              </div>
            </details>
          </aside>
        </div>
      ) : null}

      {panel ? (
        <div className="grid grid-2">
          <section className="card">
            <header className="card-head">
              <h3>خروجی‌های این پنل</h3>
              <Badge>{takes.length}</Badge>
            </header>
            <div className="card-body">
              {takes.length === 0 ? <Empty title="هنوز تصویری تولید نشده است." /> : null}
              <div className="panel-grid">
                {takes.map((take) => (
                  <div key={take.id} className={`panel-card ${take.status === "accepted" ? "active" : ""}`}>
                    <a href={take.imageUrl} target="_blank" rel="noreferrer">
                      <img src={take.imageUrl} alt={`خروجی ${take.variant + 1}`} loading="lazy" />
                    </a>
                    <div className="body">
                      <div className="row between">
                        <Badge tone={take.status === "accepted" ? "ok" : take.status === "rejected" ? "bad" : "muted"}>
                          {take.status === "accepted" ? "پذیرفته" : take.status === "rejected" ? "ردشده" : take.status === "superseded" ? "جانشین‌شده" : "نامزد"}
                        </Badge>
                        <span className="small muted">{take.editKind === "inpaint" ? "اصلاح ناحیه‌ای" : take.seed ? `seed: ${take.seed}` : ""}</span>
                      </div>
                      <div className="row">
                        <Button size="sm" onClick={() => void act({ action: "accept-take", takeId: take.id }, "این خروجی به‌عنوان تصویر پنل پذیرفته شد.")} disabled={busy}>
                          پذیرفتن
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => void act({ action: "reject-take", takeId: take.id })} disabled={busy}>
                          رد
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditSource(take.id)}>
                          اصلاح این
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {panel.imageAssetId ? (
                <Button onClick={() => void act({ action: "review" }, "بازبینی در پس‌زمینه اجرا می‌شود.")} disabled={busy} style={{ marginTop: 8 }}>
                  بازبینی تصویر پذیرفته‌شده
                </Button>
              ) : null}
            </div>
          </section>

          <section className="card">
            <header className="card-head">
              <h3>اصلاح ناحیه‌ای</h3>
              {plan?.supportsMask ? <Badge tone="muted">ماسک پشتیبانی می‌شود</Badge> : null}
            </header>
            <div className="card-body">
              {!plan?.supportsMask ? (
                <Notice tone="warn">مدل انتخاب‌شده ویرایش با ماسک را پشتیبانی نمی‌کند؛ در تنظیمات پروژه مدل دیگری انتخاب کنید.</Notice>
              ) : takes.length === 0 ? (
                <p className="small muted">برای اصلاح، نخست یک خروجی تصویری تولید کنید.</p>
              ) : (
                <div className="col" style={{ gap: 10 }}>
                  <Field label="خروجی مبدأ" hint="خروجی اصلی دست‌نخورده می‌ماند؛ نتیجهٔ اصلاح، خروجی نامزد تازه است.">
                    <select
                      value={maskedSource}
                      onChange={(e) => {
                        setEditSource(e.target.value);
                        setMaskAssetId(null);
                        setMaskName("");
                      }}
                    >
                      {takes.map((take) => (
                        <option key={take.id} value={take.id}>
                          خروجی {take.variant + 1} — {take.status}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <div className="row" style={{ flexWrap: "wrap" }}>
                    <Button size="sm" variant="primary" onClick={() => setBrush(true)}>
                      کشیدن ماسک با قلم‌مو
                    </Button>
                    <label className="btn btn-secondary btn-sm" style={{ cursor: "pointer" }}>
                      بارگذاری ماسک
                      <input
                        type="file"
                        accept="image/png,image/webp"
                        style={{ display: "none" }}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) void uploadMaskFile(file);
                        }}
                      />
                    </label>
                    {maskAssetId ? (
                      <>
                        <Badge tone="ok">ماسک آماده</Badge>
                        <Toggle checked={showMaskPreview} onChange={setShowMaskPreview} label="نمایش روی تصویر" />
                        <Button size="sm" variant="ghost" onClick={() => { setMaskAssetId(null); setMaskName(""); }}>
                          برداشتن ماسک
                        </Button>
                      </>
                    ) : null}
                  </div>
                  {maskName ? <span className="small muted">ماسک: {maskName}</span> : null}
                  <Field label="دستور اصلاح" hint="مثلاً «فقط چین لباس را اصلاح کن».">
                    <input value={editInstruction} onChange={(e) => setEditInstruction(e.target.value)} />
                  </Field>
                  <p className="small muted">
                    ناحیهٔ روشن ماسک تغییر می‌کند. بدون ماسک، این عملیات «پالایش کلی» است و ممکن است چهره را عوض کند.
                    ثابت‌ماندن دقیق بیرون ناحیه تضمین نمی‌شود.
                  </p>
                  <Button onClick={() => void submitEdit()} disabled={manualMode || busy || !maskedSource}>
                    ثبت درخواست اصلاح
                  </Button>
                </div>
              )}
            </div>
          </section>
        </div>
      ) : null}

      <div className="grid grid-2">
        <section className="card">
          <header className="card-head">
            <h3>صف کارها</h3>
            <Badge>{jobs.length}</Badge>
          </header>
          <div className="card-body">
            {jobs.length === 0 ? <p className="small muted">کاری در صف نیست.</p> : null}
            <div className="list">
              {jobs.slice(0, 8).map((job) => (
                <div key={job.id} className="issue">
                  <div className="row between">
                    <strong className="small">{jobLabel(job.type)}</strong>
                    <StatusBadge status={job.status} />
                  </div>
                  {job.errorMessage ? <span className="small muted">{job.errorMessage}</span> : null}
                  {job.status === "unknown" ? (
                    <span className="small" style={{ color: "var(--warn)" }}>
                      وضعیت این درخواست در سرویس قابل استعلام نیست. ارسال دوباره هزینهٔ تازه دارد و فقط با تصمیم شما انجام می‌شود.
                    </span>
                  ) : null}
                  {["queued", "sending", "processing", "unknown"].includes(job.status) ? (
                    <Button size="sm" variant="ghost" onClick={() => void cancelJob(job)}>
                      لغو محلی
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="card">
          <header className="card-head">
            <h3>تاریخچهٔ درخواست‌ها</h3>
            <span className="small muted">برآورد، مصرف گزارش‌شده و هزینهٔ محاسبه‌شده جدا هستند.</span>
          </header>
          <div className="card-body">
            {requests.length === 0 ? <p className="small muted">درخواستی ثبت نشده است.</p> : null}
            {requests.slice(0, 8).map((request) => (
              <div key={request.id} className="small" style={{ marginBottom: 8 }}>
                <div className="row between">
                  <span>{request.role === "prompt_writer" ? "تولید تصویر" : request.role}</span>
                  <StatusBadge status={request.status} />
                </div>
                <span className="small muted">
                  <span className="lat" dir="ltr">{request.model}</span> · برآورد {formatUsd(request.costEstimate.usd)} · محاسبه‌شده {formatUsd(request.costComputed.usd)}
                </span>
                {request.errorMessage ? <div className="small" style={{ color: "var(--bad)" }}>{request.errorMessage}</div> : null}
              </div>
            ))}
          </div>
        </section>
      </div>

      {reviews.length ? (
        <section className="card">
          <header className="card-head">
            <h3>بازبینی‌های ثبت‌شده</h3>
          </header>
          <div className="card-body">
            {reviews.slice(0, 2).map((report) => (
              <div key={report.id} className="issue">
                <strong className="small">خلاصه: {report.summary || "بدون خلاصه"}</strong>
                {report.issues.slice(0, 5).map((issue) => (
                  <div key={issue.id} className="small">
                    <Badge tone={issue.severity === "high" ? "bad" : issue.severity === "medium" ? "warn" : "muted"}>{issue.severity}</Badge>{" "}
                    {issue.evaluable ? issue.description : "قابل ارزیابی نیست"}
                  </div>
                ))}
                <span className="small muted">برای تصمیم‌گیری دربارهٔ ایرادها به بخش «بازبینی» بروید.</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {brush && sourceTake ? (
        <MaskBrush
          sourceUrl={sourceTake.imageUrl}
          onClose={() => setBrush(false)}
          onApply={async (dataUrl) => {
            setBrush(false);
            await uploadMaskDataUrl(dataUrl, `mask-${panel?.position ?? 0}.png`);
          }}
        />
      ) : null}
    </div>
  );
}

function jobLabel(type: string): string {
  const labels: Record<string, string> = {
    panel_image: "تولید تصویر",
    panel_edit: "اصلاح ناحیه‌ای",
    image_review: "بازبینی",
    adaptation: "اقتباس",
    scene_extract: "استخراج جهان داستان",
    scene_suggest: "پیشنهاد ویرایش",
    director_notes: "یادداشت کارگردانی",
  };
  return labels[type] ?? type;
}

/**
 * قلم‌موی ماسک: روی بوم هم‌اندازهٔ تصویر مبدأ نقاشی می‌شود و خروجی PNG با
 * پس‌زمینهٔ شفاف و ناحیهٔ سفید ارسال می‌شود؛ ابعاد همیشه با مبدأ یکی است.
 */
function MaskBrush({ sourceUrl, onClose, onApply }: { sourceUrl: string; onClose: () => void; onApply: (dataUrl: string) => Promise<void> }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [brushSize, setBrushSize] = useState(40);
  const [strokes, setStrokes] = useState<Array<Array<{ x: number; y: number }>>>([]);
  const drawing = useRef(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const img = new Image();
    img.onload = () => setSize({ width: img.naturalWidth, height: img.naturalHeight });
    img.src = sourceUrl;
  }, [sourceUrl]);

  useEffect(() => {
    const el = canvas.current;
    if (!el || !size.width) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, size.width, size.height);
    ctx.strokeStyle = "rgba(255,255,255,0.92)";
    ctx.lineWidth = brushSize;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const stroke of strokes) {
      if (stroke.length === 1) {
        ctx.beginPath();
        ctx.arc(stroke[0].x, stroke[0].y, brushSize / 2, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.92)";
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      stroke.forEach((point, index) => (index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)));
      ctx.stroke();
    }
  }, [strokes, size.width, size.height, brushSize]);

  const toCanvasPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const el = event.currentTarget;
    const rect = el.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * size.width,
      y: ((event.clientY - rect.top) / rect.height) * size.height,
    };
  };

  const apply = async () => {
    const el = canvas.current;
    if (!el) return;
    setSaving(true);
    try {
      await onApply(el.toDataURL("image/png"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-label="کشیدن ماسک" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>کشیدن ماسک روی خروجی</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="بستن">
            ✕
          </Button>
        </header>
        <div className="modal-body">
          <div className="row" style={{ marginBottom: 8, flexWrap: "wrap" }}>
            <label className="small muted" htmlFor="brush-size">
              اندازهٔ قلم‌مو
            </label>
            <input id="brush-size" type="range" min={10} max={140} value={brushSize} onChange={(e) => setBrushSize(Number(e.target.value))} style={{ width: 160 }} />
            <Button size="sm" variant="ghost" onClick={() => setStrokes((s) => s.slice(0, -1))} disabled={!strokes.length}>
              واگرد ضربه
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setStrokes([])} disabled={!strokes.length}>
              پاک کردن همه
            </Button>
            <span className="grow" />
            <span className="small muted">
              {size.width}×{size.height}
            </span>
          </div>
          <div className="mask-canvas">
            <img src={sourceUrl} alt="خروجی مبدأ برای ماسک" style={{ width: "100%", display: "block" }} />
            <canvas
              ref={canvas}
              width={size.width || 1}
              height={size.height || 1}
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", touchAction: "none", cursor: "crosshair" }}
              onPointerDown={(event) => {
                if (!size.width) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                drawing.current = true;
                setStrokes((current) => [...current, [toCanvasPoint(event)]]);
              }}
              onPointerMove={(event) => {
                if (!drawing.current) return;
                const point = toCanvasPoint(event);
                setStrokes((current) => {
                  const next = [...current];
                  next[next.length - 1] = [...next[next.length - 1], point];
                  return next;
                });
              }}
              onPointerUp={() => {
                drawing.current = false;
              }}
            />
          </div>
          <p className="small muted">ناحیه‌ای که روشن می‌بینید، تنها ناحیه‌ای است که درخواست اصلاح روی آن اعمال می‌شود.</p>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <Button variant="ghost" onClick={onClose}>
              انصراف
            </Button>
            <Button variant="primary" onClick={() => void apply()} disabled={saving || strokes.length === 0 || !size.width}>
              {saving ? "در حال آماده‌سازی…" : "ثبت این ماسک"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
