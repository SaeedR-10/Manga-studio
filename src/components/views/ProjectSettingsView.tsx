"use client";

import { useEffect, useState } from "react";
import { api, formatUsd } from "@/lib/api";
import { useWorkspace } from "@/components/workspace";
import { Badge, Button, Card, ErrorNote, Field, Notice } from "@/components/ui";
import type { ProjectSettings } from "@/lib/types";

interface ModelInfo {
  id: string;
  label: string;
  provider: string;
  kind: string;
  price: { unit: string; inputUsd: number | null; outputUsd: number | null; imageUsdBySize?: Record<string, number | null>; sourceUrl: string; effectiveDate: string };
}

export default function ProjectSettingsView() {
  const ctx = useWorkspace();
  const { bundle, reload } = ctx;
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [settings, setSettings] = useState<ProjectSettings>(bundle.project.settings);
  const [publishFormat, setPublishFormat] = useState(bundle.project.publishFormat);
  const [title, setTitle] = useState(bundle.project.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void api<{ models: ModelInfo[] }>("/api/settings")
      .then((data) => setModels(data.models))
      .catch(() => undefined);
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/projects/${bundle.project.id}`, {
        method: "PATCH",
        json: { title, publishFormat, settings },
      });
      setNotice("تنظیمات پروژه ذخیره شد.");
      await reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const textModels = models.filter((m) => m.kind === "text" && m.provider === settings.text.provider);
  const imageModels = models.filter((m) => m.kind === "image" && m.provider === settings.image.provider);

  return (
    <div className="col" style={{ gap: 14 }}>
      <ErrorNote error={error} />
      {notice ? <Notice tone="ok">{notice}</Notice> : null}

      <Card title="تنظیمات پروژه">
        <div className="grid grid-2">
          <Field label="نام پروژه">
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="قالب انتشار" hint="ساختار صحنه و پنل مستقل از این انتخاب است.">
            <select value={publishFormat} onChange={(e) => setPublishFormat(e.target.value as "vertical" | "page")}>
              <option value="vertical">اسکرول عمودی (پیش‌فرض)</option>
              <option value="page">صفحهٔ مانگا</option>
            </select>
          </Field>
          <Field label="جهت ترتیب خواندن پنل‌ها">
            <select
              value={settings.readingOrder}
              onChange={(e) => setSettings({ ...settings, readingOrder: e.target.value as "rtl" | "ltr" })}
            >
              <option value="rtl">راست‌به‌چپ</option>
              <option value="ltr">چپ‌به‌راست</option>
            </select>
          </Field>
          <Field label="تعداد پنل پیشنهادی هر صحنه">
            <input
              type="number"
              min={1}
              max={28}
              value={settings.adaptation.panelsPerScene}
              onChange={(e) => setSettings({ ...settings, adaptation: { panelsPerScene: Number(e.target.value) } })}
            />
          </Field>
        </div>
      </Card>

      <Card title="مدل‌های این پروژه">
        <div className="grid grid-2">
          <Field label="مدل متن و بینایی">
            <select value={settings.text.provider} onChange={(e) => setSettings({ ...settings, text: { provider: e.target.value, model: "" } })}>
              <option value="openai">OpenAI</option>
              <option value="google">Google</option>
            </select>
            <select
              value={settings.text.model}
              onChange={(e) => setSettings({ ...settings, text: { ...settings.text, model: e.target.value } })}
            >
              <option value="">— انتخاب مدل —</option>
              {textModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="مدل تصویر">
            <select value={settings.image.provider} onChange={(e) => setSettings({ ...settings, image: { provider: e.target.value, model: "" } })}>
              <option value="openai">OpenAI</option>
              <option value="google">Google</option>
            </select>
            <select
              value={settings.image.model}
              onChange={(e) => setSettings({ ...settings, image: { ...settings.image, model: e.target.value } })}
            >
              <option value="">— انتخاب مدل —</option>
              {imageModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <p className="small muted">
          هزینهٔ تصویر برای مدل انتخابی:{" "}
          {(() => {
            const model = imageModels.find((m) => m.id === settings.image.model);
            if (!model) return "نامشخص";
            const perImage = Object.values(model.price.imageUsdBySize ?? {});
            if (perImage.length) return perImage.map((v) => formatUsd(v)).join(" / ");
            return "نامشخص (ناشر قیمت ثابت هر تصویر منتشر نکرده)";
          })()}
        </p>
      </Card>

      <Card title="سقف محلی هزینه و تعداد">
        <p className="small muted">
          این سقف‌ها فقط محلی‌اند و جای سقف صورتحساب ارائه‌دهنده را نمی‌گیرند. پس از رسیدن به سقف، درخواست بعدی ارسال
          نمی‌شود.
        </p>
        <div className="grid grid-3">
          <Field label="حداکثر تولید هر پنل">
            <input
              type="number"
              min={1}
              max={10}
              value={settings.caps.generationsPerPanel}
              onChange={(e) => setSettings({ ...settings, caps: { ...settings.caps, generationsPerPanel: Number(e.target.value) } })}
            />
          </Field>
          <Field label="حداکثر بازبینی هر پنل">
            <input
              type="number"
              min={0}
              max={5}
              value={settings.caps.reviewsPerPanel}
              onChange={(e) => setSettings({ ...settings, caps: { ...settings.caps, reviewsPerPanel: Number(e.target.value) } })}
            />
          </Field>
          <Field label="بودجهٔ فصل (دلار، خالی = بدون سقف)">
            <input
              type="number"
              min={0}
              step="0.01"
              value={settings.caps.chapterBudgetUsd ?? ""}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  caps: { ...settings.caps, chapterBudgetUsd: e.target.value === "" ? null : Number(e.target.value) },
                })
              }
            />
          </Field>
        </div>
      </Card>

      <div className="row">
        <Button variant="primary" onClick={() => void save()} disabled={busy}>
          ذخیرهٔ تنظیمات
        </Button>
        <Badge tone="muted">{bundle.panelCount} پنل در پروژه</Badge>
      </div>
    </div>
  );
}
