"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorText } from "@/lib/api";
import { useWorkspace } from "@/components/workspace";
import { Badge, Button, Card, Empty, ErrorNote, Field, Notice, Spinner, Modal } from "@/components/ui";
import { canvasToPngDataUrl, pageCount, renderPage, renderPanelImage } from "@/lib/render";
import type { PaginationDoc, Panel, Placement, TextLayer } from "@/lib/types";

export default function LayoutView() {
  const ctx = useWorkspace();
  const { bundle } = ctx;
  const [doc, setDoc] = useState<PaginationDoc | null>(null);
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [layers, setLayers] = useState<TextLayer[]>([]);
  const [panels, setPanels] = useState<Panel[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pageWidth, setPageWidth] = useState(1200);
  const [pageHeight, setPageHeight] = useState(1800);
  const [gap, setGap] = useState(16);
  const [selectedPanel, setSelectedPanel] = useState<string | null>(null);
  const [balloonText, setBalloonText] = useState("");
  const [zoom, setZoom] = useState(1);
  const [showReader, setShowReader] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ doc: PaginationDoc; placements: Placement[]; layers: TextLayer[]; panels: Panel[] }>(
        `/api/projects/${bundle.project.id}/layout`,
      );
      setDoc(data.doc);
      setPlacements(data.placements);
      setLayers(data.layers);
      setPanels(data.panels);
      setPageWidth(data.doc.pageWidth);
      setPageHeight(data.doc.pageHeight);
      setGap(data.doc.gap);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [bundle.project.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const panelMap = useMemo(() => new Map(panels.map((p) => [p.id, p])), [panels]);

  const saveDoc = async (patch: Partial<PaginationDoc>) => {
    setBusy(true);
    try {
      const data = await api<{ doc: PaginationDoc; placements: Placement[]; layers: TextLayer[] }>(
        `/api/projects/${bundle.project.id}/layout`,
        { method: "PATCH", json: patch },
      );
      setDoc(data.doc);
      setPlacements(data.placements);
      setLayers(data.layers);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const autoLayout = async () => {
    setBusy(true);
    try {
      const data = await api<{ placements: Placement[] }>(`/api/projects/${bundle.project.id}/layout`, {
        method: "POST",
        json: { action: "auto-layout" },
      });
      setPlacements(data.placements);
      setNotice("چیدمان خودکار اعمال شد. قالب صفحه و ترتیب خواندن را می‌توانید تغییر دهید.");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const addBalloon = async () => {
    if (!balloonText.trim()) return;
    setBusy(true);
    try {
      const data = await api<{ layer: TextLayer }>(`/api/projects/${bundle.project.id}/layers`, {
        method: "POST",
        json: {
          kind: "dialogue",
          body: balloonText,
          panelId: selectedPanel,
          x: 0.08,
          y: 0.06,
          w: 0.4,
          h: 0.12,
          fontSize: 24,
          direction: ctx.textDirection,
          tail: "bottom",
        },
      });
      setLayers((list) => [...list, data.layer]);
      setBalloonText("");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const balloonsFromDialogue = async () => {
    if (!panels.length) return;
    setBusy(true);
    try {
      const created: TextLayer[] = [];
      for (const panel of panels) {
        for (const [index, line] of panel.dialogue.entries()) {
          const data = await api<{ layer: TextLayer }>(`/api/projects/${bundle.project.id}/layers`, {
            method: "POST",
            json: {
              kind: line.kind === "narration" ? "narration" : line.kind,
              speaker: line.speaker,
              body: line.text,
              panelId: panel.id,
              x: 0.06 + (index % 2) * 0.5,
              y: 0.04 + Math.floor(index / 2) * 0.1,
              w: 0.36,
              h: 0.11,
              fontSize: 22,
              direction: ctx.textDirection,
            },
          });
          created.push(data.layer);
        }
      }
      setLayers((list) => [...list, ...created]);
      setNotice(`${created.length} بالن از دیالوگ پنل‌ها ساخته شد؛ متن‌ها مستقل از تصویر و قابل ویرایش‌اند.`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const updateLayer = async (layer: TextLayer, patch: Partial<TextLayer>) => {
    try {
      const data = await api<{ layer: TextLayer }>(`/api/layers/${layer.id}`, { method: "PATCH", json: patch });
      setLayers((list) => list.map((l) => (l.id === layer.id ? data.layer : l)));
    } catch (err) {
      setError(err);
    }
  };

  const removeLayer = async (layer: TextLayer) => {
    try {
      await api(`/api/layers/${layer.id}`, { method: "DELETE" });
      setLayers((list) => list.filter((l) => l.id !== layer.id));
    } catch (err) {
      setError(err);
    }
  };

  const exportPng = async () => {
    if (!doc) return;
    setBusy(true);
    try {
      const count = pageCount(placements);
      for (let pageIndex = 0; pageIndex < count; pageIndex++) {
        const canvas = await renderPage(
          {
            pageIndex,
            pageWidth: doc.pageWidth,
            pageHeight: doc.pageHeight,
            placements: placements.filter((p) => p.pageIndex === pageIndex),
            layers,
            panels: panelMap,
          },
          2,
        );
        await api(`/api/projects/${bundle.project.id}/exports`, {
          method: "POST",
          json: { kind: "page", pageIndex, dataUrl: canvasToPngDataUrl(canvas) },
        });
      }
      setNotice(`${count} صفحه PNG با فونت فارسی ساخته و ذخیره شد. فایل‌ها در بخش «خروجی» قابل دریافت‌اند.`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const exportPdf = async () => {
    if (!doc) return;
    setBusy(true);
    try {
      const count = pageCount(placements);
      if (count > 60) throw new Error("خروجی PDF در هر بار حداکثر ۶۰ صفحه است.");
      const pages: Array<{ base64: string; width: number; height: number }> = [];
      for (let pageIndex = 0; pageIndex < count; pageIndex++) {
        const canvas = await renderPage(
          {
            pageIndex,
            pageWidth: doc.pageWidth,
            pageHeight: doc.pageHeight,
            placements: placements.filter((p) => p.pageIndex === pageIndex),
            layers,
            panels: panelMap,
          },
          2,
        );
        pages.push({ base64: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height });
      }
      await api(`/api/projects/${bundle.project.id}/exports`, { method: "POST", json: { kind: "pdf", pages } });
      setNotice("PDF ساخته شد. متن داخل PDF تصویری است (متن انتخاب‌پذیر در نقشهٔ توسعه ثبت شده).");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const exportPanel = async (panelId: string) => {
    const panel = panelMap.get(panelId);
    if (!panel) return;
    setBusy(true);
    try {
      const canvas = await renderPanelImage(panel, layers.filter((l) => l.panelId === panelId));
      await api(`/api/projects/${bundle.project.id}/exports`, {
        method: "POST",
        json: { kind: "panel", panelId, dataUrl: canvasToPngDataUrl(canvas) },
      });
      setNotice(`پنل ${panel.position} به‌صورت PNG ذخیره شد.`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (loading || !doc) {
    return (
      <main>
        <ErrorNote error={error} />
        <Spinner />
      </main>
    );
  }

  const totalPages = pageCount(placements);
  const viewWidth = Math.round(360 * zoom);
  const scale = viewWidth / doc.pageWidth;
  const missingImages = placements.filter((placement) => !panelMap.get(placement.panelId)?.imageAssetId).length;

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
        title="سند صفحه‌بندی"
        actions={
          <div className="row">
            <Badge>{totalPages} صفحه · {placements.length} جای‌گذاری</Badge>
            <Button size="sm" onClick={() => void autoLayout()} disabled={busy}>
              چیدمان خودکار
            </Button>
          </div>
        }
      >
        <div className="row">
          <Field label="قالب">
            <select value={doc.format} onChange={(e) => void saveDoc({ format: e.target.value as PaginationDoc["format"] })}>
              <option value="vertical">اسکرول عمودی</option>
              <option value="page">صفحهٔ مانگا</option>
            </select>
          </Field>
          <Field label="عرض صفحه">
            <input type="number" value={pageWidth} onChange={(e) => setPageWidth(Number(e.target.value))} onBlur={() => void saveDoc({ pageWidth })} style={{ width: 100 }} />
          </Field>
          <Field label="ارتفاع صفحه">
            <input type="number" value={pageHeight} onChange={(e) => setPageHeight(Number(e.target.value))} onBlur={() => void saveDoc({ pageHeight })} style={{ width: 100 }} />
          </Field>
          <Field label="فاصله">
            <input type="number" value={gap} onChange={(e) => setGap(Number(e.target.value))} onBlur={() => void saveDoc({ gap })} style={{ width: 80 }} />
          </Field>
        </div>
        <p className="small muted">
          پنل‌ها مستقل از جای‌گیری ذخیره می‌شوند و سند صفحه‌بندی ترتیب خواندن خودش را دارد. تغییر قالب، پنل‌ها را تغییر
          نمی‌دهد. تبدیل صفحه‌ای/عمودی به صفحه‌بندی مجدد نیاز دارد.
        </p>
      </Card>

      <div className="split">
        <Card
          title="پیش‌نمایش صفحه‌ها"
          actions={
            <div className="row" style={{ gap: 6 }}>
              <span className="small muted">پنل‌ها را برای انتخاب کلیک کنید</span>
              <Button size="sm" onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.15).toFixed(2)))} aria-label="کوچک‌نمایی">
                −
              </Button>
              <span className="small muted" style={{ minWidth: 38, textAlign: "center" }}>{Math.round(zoom * 100)}٪</span>
              <Button size="sm" onClick={() => setZoom((z) => Math.min(2, +(z + 0.15).toFixed(2)))} aria-label="بزرگ‌نمایی">
                +
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowReader(true)}>
                نمای خواننده
              </Button>
            </div>
          }
        >
          {missingImages ? <Notice tone="warn">{missingImages} پنل در این چیدمان تصویر ندارد و در خروجی خالی می‌ماند.</Notice> : null}
          <div className="canvas-wrap" dir={ctx.panelOrder}>
            {Array.from({ length: totalPages }).map((_, pageIndex) => (
              <div
                key={pageIndex}
                className="layout-page"
                style={{ width: viewWidth, height: Math.round(doc.pageHeight * scale) }}
              >
                {placements
                  .filter((p) => p.pageIndex === pageIndex)
                  .map((placement) => {
                    const panel = panelMap.get(placement.panelId);
                    return (
                      <div
                        key={placement.id}
                        className="layout-panel"
                        style={{
                          left: placement.x * scale,
                          top: placement.y * scale,
                          width: placement.w * scale,
                          height: placement.h * scale,
                          outline: selectedPanel === placement.panelId ? "2px solid #4b7a93" : "none",
                        }}
                        onClick={() => setSelectedPanel(placement.panelId)}
                        title={panel?.action?.slice(0, 120)}
                      >
                        {panel?.imageAssetId ? <img src={`/api/assets/${panel.imageAssetId}`} alt={panel.title} loading="lazy" /> : <span>{panel?.position}. {panel?.title ?? "پنل"}</span>}
                      </div>
                    );
                  })}
                {layers
                  .filter((layer) => layer.panelId && placements.some((p) => p.panelId === layer.panelId && p.pageIndex === pageIndex))
                  .map((layer) => (
                    <div
                      key={layer.id}
                      className="balloon"
                      style={{
                        left: layer.x * viewWidth,
                        top: layer.y * doc.pageHeight * scale,
                        width: layer.w * viewWidth,
                        height: layer.h * doc.pageHeight * scale,
                        direction: layer.direction,
                      }}
                    >
                      {layer.body}
                    </div>
                  ))}
              </div>
            ))}
            {placements.length === 0 ? <Empty title="هنوز جای‌گذاری‌ای نیست." hint="چیدمان خودکار را بزنید." /> : null}
          </div>
        </Card>

        <div className="col">
          <Card title="بالن و لایهٔ متن">
            <p className="small muted">متن دیالوگ مستقل از تصویر است؛ می‌توانید محل، اندازه و جهت آن را تغییر دهید.</p>
            <div className="row">
              <input value={balloonText} onChange={(e) => setBalloonText(e.target.value)} placeholder="متن بالن" />
              <Button size="sm" onClick={() => void addBalloon()} disabled={busy || !balloonText.trim()}>
                افزودن
              </Button>
            </div>
            <Button size="sm" variant="ghost" onClick={() => void balloonsFromDialogue()} disabled={busy} style={{ marginTop: 6 }}>
              ساخت بالن از دیالوگ همهٔ پنل‌ها
            </Button>
            <div className="sep" />
            <div className="col" style={{ gap: 8, maxHeight: 320, overflow: "auto" }}>
              {layers.map((layer) => (
                <div key={layer.id} className="issue">
                  <div className="row between">
                    <Badge tone="muted">
                      {layer.kind === "dialogue" ? "گفت‌وگو" : layer.kind === "narration" ? "راوی" : layer.kind}
                    </Badge>
                    <Button size="sm" variant="ghost" onClick={() => void removeLayer(layer)}>
                      ✕
                    </Button>
                  </div>
                  <textarea rows={2} defaultValue={layer.body} onBlur={(e) => void updateLayer(layer, { body: e.target.value })} dir={layer.direction} />
                  <div className="row">
                    <input
                      type="number"
                      defaultValue={layer.fontSize}
                      onBlur={(e) => void updateLayer(layer, { fontSize: Number(e.target.value) })}
                      style={{ width: 70 }}
                      aria-label="اندازهٔ قلم"
                    />
                    <select value={layer.direction} onChange={(e) => void updateLayer(layer, { direction: e.target.value as "rtl" | "ltr" })} style={{ width: 90 }}>
                      <option value="rtl">راست‌به‌چپ</option>
                      <option value="ltr">چپ‌به‌راست</option>
                    </select>
                    <input
                      type="number"
                      step="0.01"
                      defaultValue={layer.y}
                      onBlur={(e) => void updateLayer(layer, { y: Number(e.target.value) })}
                      style={{ width: 70 }}
                      aria-label="جای عمودی"
                    />
                  </div>
                </div>
              ))}
              {layers.length === 0 ? <p className="small muted">لایه‌ای نیست.</p> : null}
            </div>
          </Card>

          <Card title="خروجی صفحه">
            <div className="row">
              <Button onClick={() => void exportPng()} disabled={busy}>
                PNG همهٔ صفحه‌ها
              </Button>
              <Button onClick={() => void exportPdf()} disabled={busy}>
                PDF
              </Button>
            </div>
            {selectedPanel ? (
              <Button size="sm" variant="ghost" onClick={() => void exportPanel(selectedPanel)} disabled={busy}>
                PNG پنل انتخاب‌شده
              </Button>
            ) : null}
            <p className="small muted">
              رندر با فونت Vazirmatn و جهت متن انجام می‌شود؛ فایل واقعی را در بخش خروجی دریافت و بررسی کنید.
            </p>
          </Card>
        </div>
      </div>

      {showReader ? (
        <Modal title="نمای خواننده" onClose={() => setShowReader(false)} wide>
          <p className="small muted">همان ترتیب خواندن سند، در عرض مطالعه. این نما فقط پیش‌نمایش است و چیزی را تغییر نمی‌دهد.</p>
          <div className="reader" dir={ctx.panelOrder}>
            {placements.length === 0 ? <p className="small muted">چیدمانی ثبت نشده است.</p> : null}
            {[...placements]
              .sort((a, b) => a.pageIndex - b.pageIndex || a.y - b.y || a.x - b.x)
              .map((placement) => {
                const item = panelMap.get(placement.panelId);
                if (!item) return null;
                return (
                  <figure key={placement.id}>
                    {item.imageAssetId ? <img src={`/api/assets/${item.imageAssetId}`} alt={item.title} loading="lazy" /> : <div className="reader-missing">بدون تصویر</div>}
                    {layers.filter((layer) => layer.panelId === item.id).map((layer) => (
                      <figcaption key={layer.id} className="reader-balloon" style={{ direction: layer.direction }}>
                        {layer.body}
                      </figcaption>
                    ))}
                  </figure>
                );
              })}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
