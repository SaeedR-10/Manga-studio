"use client";

import { useCallback, useEffect, useState } from "react";
import { api, formatDate } from "@/lib/api";
import { useWorkspace } from "@/components/workspace";
import { Badge, Button, Card, Empty, ErrorNote, Notice, Spinner, StatusBadge } from "@/components/ui";
import type { Panel, PanelTake, ReviewReport } from "@/lib/types";

const KIND_LABELS: Record<string, string> = {
  identity: "هویت",
  mark: "نشانهٔ ثابت",
  clothing: "لباس",
  tool: "ابزار",
  scale: "مقیاس",
  position: "موقعیت",
  count: "تعداد افراد",
  location: "مکان",
  lighting: "نور",
  continuity: "پیوستگی",
  readability: "خوانایی",
  other: "سایر",
};

export default function ReviewView() {
  const ctx = useWorkspace();
  const { bundle } = ctx;
  const [panels, setPanels] = useState<Panel[]>([]);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [reviews, setReviews] = useState<ReviewReport[]>([]);
  const [neighbors, setNeighbors] = useState<Panel[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [compareMode, setCompareMode] = useState<"refs" | "neighbors" | "edit">("refs");
  const [takes, setTakes] = useState<PanelTake[]>([]);

  const loadPanels = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ panels: Panel[] }>(`/api/projects/${bundle.project.id}/panels`);
      setPanels(data.panels);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [bundle.project.id]);

  const loadDetail = useCallback(async (panelId: string) => {
    try {
      const data = await api<{ panel: Panel; reviews: ReviewReport[]; takes: PanelTake[]; neighbors: Panel[] }>(`/api/panels/${panelId}?plan=0`);
      setPanel(data.panel);
      setReviews(data.reviews);
      setTakes(data.takes);
      setNeighbors(data.neighbors);
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => {
    void loadPanels();
  }, [loadPanels]);

  useEffect(() => {
    if (panels.length && !panel) {
      const withImage = panels.find((p) => p.imageAssetId) ?? panels[0];
      void loadDetail(withImage.id);
    }
  }, [panels, panel, loadDetail]);

  const runReview = async () => {
    if (!panel) return;
    setBusy(true);
    try {
      await api(`/api/panels/${panel.id}/actions`, { method: "POST", json: { action: "review" } });
      setNotice("بازبینی در پس‌زمینه اجرا می‌شود؛ نتیجه پس از تکمیل همین‌جا دیده می‌شود.");
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        await loadDetail(panel.id);
        const current = await api<{ reviews: ReviewReport[] }>(`/api/panels/${panel.id}?plan=0`);
        if (current.reviews.length > reviews.length) break;
      }
      await loadPanels();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const decide = async (issueId: string, decision: "accepted" | "rejected" | "intentional") => {
    if (!panel) return;
    setBusy(true);
    try {
      await api(`/api/panels/${panel.id}/actions`, { method: "POST", json: { action: "decide-issue", issueId, decision } });
      await loadDetail(panel.id);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const needingReview = panels.filter((p) => p.needsReview);

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
        title="بازبینی تصویر"
        actions={
          <div className="row">
            <Badge tone={needingReview.length ? "warn" : "ok"}>{needingReview.length} پنل نیازمند بازبینی</Badge>
            <Button size="sm" onClick={() => void runReview()} disabled={busy || !panel?.imageAssetId}>
              اجرای بازبینی
            </Button>
          </div>
        }
      >
        <p className="small muted">
          بازبین، تصویر را با مراجع تأییدشده و وضعیت صحنه می‌سنجد. «قابل ارزیابی نیست» یک گزارش معتبر است و به‌جای حدس
          ثبت می‌شود. تأیید نهایی پنل با شماست و چرخهٔ اصلاح خودکار در این نسخه خاموش است.
        </p>
        {loading ? <Spinner /> : null}
        <div className="panel-grid">
          {panels.map((item) => (
            <div key={item.id} className={`panel-card ${panel?.id === item.id ? "active" : ""}`} onClick={() => void loadDetail(item.id)}>
              {item.imageAssetId ? (
                <img src={`/api/assets/${item.imageAssetId}`} alt={item.title} loading="lazy" />
              ) : (
                <div className="card-empty-thumb" aria-hidden>
                  بدون تصویر
                </div>
              )}
              <div className="body">
                <strong className="small">
                  {item.position}. {item.title}
                </strong>
                <div className="row">
                  <StatusBadge status={item.status} />
                  {item.needsReview ? <Badge tone="warn">نیازمند بازبینی</Badge> : null}
                </div>
              </div>
            </div>
          ))}
        </div>
        {panels.length === 0 ? <Empty title="پنلی وجود ندارد." /> : null}
      </Card>

      {panel ? (
        <div className="split">
          <div className="col">
            <Card
              title={`تصویر پنل ${panel.position}`}
              actions={
                <div className="row" style={{ gap: 4 }}>
                  <Button size="sm" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.15).toFixed(2)))} aria-label="کوچک‌نمایی">
                    −
                  </Button>
                  <span className="small muted" style={{ minWidth: 40, textAlign: "center" }}>{Math.round(zoom * 100)}٪</span>
                  <Button size="sm" onClick={() => setZoom((z) => Math.min(2.5, +(z + 0.15).toFixed(2)))} aria-label="بزرگ‌نمایی">
                    +
                  </Button>
                </div>
              }
            >
              {panel.imageAssetId ? (
                <div className="stage-frame" style={{ minHeight: 220 }}>
                  <img
                    src={`/api/assets/${panel.imageAssetId}`}
                    alt={panel.title}
                    style={{ maxHeight: "58vh", width: "auto", transform: `scale(${zoom})`, transformOrigin: "center top", transition: "transform 120ms ease", borderRadius: 8 }}
                  />
                </div>
              ) : (
                <Empty title="این پنل تصویر پذیرفته‌شده ندارد." hint="نخست در بخش تولید یک خروجی را بپذیرید." />
              )}
              <p className="small muted" style={{ marginTop: 6 }}>
                {panel.needsReview ? `نیازمند بازبینی: ${panel.reviewReason}` : "بازبینی به‌روز است."}
              </p>
            </Card>

            <Card
              title="مقایسه"
              actions={
                <div className="row" style={{ gap: 4 }}>
                  <Button size="sm" variant={compareMode === "refs" ? "primary" : "ghost"} onClick={() => setCompareMode("refs")}>
                    مراجع هویت
                  </Button>
                  <Button size="sm" variant={compareMode === "neighbors" ? "primary" : "ghost"} onClick={() => setCompareMode("neighbors")}>
                    پنل‌های همسایه
                  </Button>
                  {takes.some((take) => take.sourceTakeId) ? (
                    <Button size="sm" variant={compareMode === "edit" ? "primary" : "ghost"} onClick={() => setCompareMode("edit")}>
                      قبل/بعد اصلاح
                    </Button>
                  ) : null}
                </div>
              }
            >
              {compareMode === "refs" ? (
                <div className="refstrip">
                  {bundle.references
                    .filter((ref) => ref.status === "approved" && ref.entityIds.some((id) => panel.characters.some((c) => c.entityId === id)))
                    .slice(0, 6)
                    .map((ref) => (
                      <figure key={ref.id}>
                        <img src={ref.thumbUrl} alt={`${ref.title} — مرجع تأییدشده`} loading="lazy" />
                        <figcaption>{ref.title}</figcaption>
                      </figure>
                    ))}
                  {bundle.references.filter((ref) => ref.status === "approved" && ref.entityIds.some((id) => panel.characters.some((c) => c.entityId === id))).length === 0 ? (
                    <p className="small muted">برای حاضران این پنل مرجع تأییدشده‌ای نیست؛ مقایسهٔ هویت ممکن نیست.</p>
                  ) : null}
                </div>
              ) : compareMode === "neighbors" ? (
                <div className="refstrip">
                  {neighbors.length === 0 ? <p className="small muted">پنل همسایه‌ای برای مقایسه نیست.</p> : null}
                  {neighbors.map((item) => (
                    <figure key={item.id}>
                      {item.imageAssetId ? <img src={`/api/assets/${item.imageAssetId}`} alt={item.title} loading="lazy" /> : <span className="small muted">بدون تصویر</span>}
                      <figcaption>
                        {item.position}. {item.title}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              ) : (
                <div className="grid grid-2">
                  {(() => {
                    const edited = takes.find((take) => take.sourceTakeId);
                    const source = edited ? takes.find((take) => take.id === edited.sourceTakeId) : null;
                    return (
                      <>
                        <figure>
                          <figcaption className="small muted">پیش از اصلاح</figcaption>
                          {source ? <img src={source.imageUrl} alt="پیش از اصلاح" style={{ width: "100%", borderRadius: 8 }} /> : <p className="small muted">خروجی مبدأ در دسترس نیست.</p>}
                        </figure>
                        <figure>
                          <figcaption className="small muted">پس از اصلاح (نامزد کنونی)</figcaption>
                          {edited ? <img src={edited.imageUrl} alt="پس از اصلاح" style={{ width: "100%", borderRadius: 8 }} /> : null}
                        </figure>
                      </>
                    );
                  })()}
                </div>
              )}
            </Card>
          </div>

          <div className="col">
            <Card title="گزارش‌ها">
              {reviews.length === 0 ? <Empty title="گزارشی برای این پنل ثبت نشده است." /> : null}
              {reviews.map((report) => (
                <div key={report.id} style={{ marginBottom: 12 }}>
                  <div className="row between">
                    <strong className="small">خلاصه: {report.summary || "—"}</strong>
                    <span className="small muted">{formatDate(report.createdAt)}</span>
                  </div>
                  {report.issues.map((issue) => (
                    <div key={issue.id} className="issue" style={{ marginTop: 6 }}>
                      <div className="row between">
                        <Badge tone={issue.severity === "high" ? "bad" : issue.severity === "medium" ? "warn" : "muted"}>
                          {KIND_LABELS[issue.kind] ?? issue.kind} · {issue.severity}
                        </Badge>
                        <StatusBadge status={issue.decision} />
                      </div>
                      <span className="small">{issue.evaluable ? issue.description : "قابل ارزیابی نیست (جزئیات کافی دیده نمی‌شود)."}</span>
                      {issue.evidence ? <span className="small muted">شاهد: {issue.evidence}</span> : null}
                      {issue.suggestion ? <span className="small muted">پیشنهاد: {issue.suggestion}</span> : null}
                      <span className="small muted">قطعیت: {issue.confidence}</span>
                      <div className="row">
                        <Button size="sm" onClick={() => void decide(issue.id, "accepted")} disabled={busy}>
                          می‌پذیرم
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => void decide(issue.id, "rejected")} disabled={busy}>
                          رد می‌کنم
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => void decide(issue.id, "intentional")} disabled={busy}>
                          تغییر عمدی است
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </Card>
          </div>
        </div>
      ) : null}
    </div>
  );
}
