"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { LanguageToggle, usePreferences } from "@/components/preferences";
import ChatGPTConnection from "@/components/ChatGPTConnection";
import { api, errorText, formatUsd } from "@/lib/api";
import { Badge, Button, Card, ErrorNote, Field, Modal, Notice, Spinner } from "@/components/ui";

interface ModelInfo {
  provider: string;
  id: string;
  label: string;
  kind: string;
  capabilities: { imageInput: boolean; maxReferenceImages: number; mask: boolean; seed: boolean; sizes: string[]; notes: string };
  price: { unit: string; inputUsd: number | null; outputUsd: number | null; imageUsdBySize?: Record<string, number | null>; sourceUrl: string; effectiveDate: string; note?: string };
}

interface SettingsResponse {
  settings: Record<string, string>;
  providers: Array<{ id: string; label: string; capabilities: { vision: boolean; imageGeneration: boolean; maxReferenceImages: number; mask: boolean } }>;
  models: ModelInfo[];
  catalogVerifiedAt: string;
  secrets: { mode: string; note: string };
  keys: { openai: boolean; google: boolean };
  appVersion: string;
  dataDir: string | null;
}

export default function SettingsPage() {
  const { preferences } = usePreferences();
  const en = preferences.language === "en";
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({ openai: "", google: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [confirmImageTest, setConfirmImageTest] = useState<{ provider: string; model: string; note: string; usd: number | null } | null>(null);
  const [status, setStatus] = useState<{ queue: { queued: number; running: boolean; started: boolean }; schemaVersion: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await api<SettingsResponse>("/api/settings");
      setData(response);
      setError(null);
      const queue = await api<{ queue: { queued: number; running: boolean; started: boolean }; schemaVersion: number }>("/api/status");
      setStatus(queue);
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveSettings = async (patch: Record<string, unknown>) => {
    setBusy("settings");
    try {
      await api("/api/settings", { method: "PATCH", json: patch });
      await load();
      setNotice("تنظیمات ذخیره شد.");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  const saveKey = async (provider: "openai" | "google") => {
    const value = keyInputs[provider];
    if (!value.trim()) return;
    setBusy(`key-${provider}`);
    try {
      await api("/api/settings/key", { method: "POST", json: { provider, key: value } });
      // ورودی بلافاصله پاک می‌شود و کلید هرگز به رابط برنمی‌گردد.
      setKeyInputs((current) => ({ ...current, [provider]: "" }));
      setNotice("کلید در خزانهٔ سیستم ذخیره شد. برای آزمون اتصال، دکمهٔ آزمون متنی را بزنید.");
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  const deleteKey = async (provider: "openai" | "google") => {
    if (!window.confirm("کلید این ارائه‌دهنده حذف شود؟")) return;
    setBusy(`key-${provider}`);
    try {
      await api(`/api/settings/key?provider=${provider}`, { method: "DELETE" });
      setNotice("کلید حذف شد.");
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  const testText = async (provider: "openai" | "google") => {
    const model = provider === "openai" ? data?.settings.textProvider === "openai" ? data?.settings.textModel : "gpt-6.1-sol" : "gemini-3.8-flash";
    setBusy(`test-${provider}`);
    setTestResult(null);
    try {
      const result = await api<{ latencyMs: number; sample: string; tokensIn: number | null; tokensOut: number | null }>(
        "/api/settings/test",
        { method: "POST", json: { provider, kind: "text", model } },
      );
      setTestResult(`${provider}: اتصال برقرار است (${result.latencyMs} میلی‌ثانیه، ${result.tokensIn ?? "?"} توکن ورودی). نمونه: ${result.sample || "—"}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  const askImageTest = async (provider: "openai" | "google") => {
    const model = provider === "openai" ? "gpt-image-2.5-flare" : "gemini-nano-banana-2.1";
    setBusy(`test-${provider}`);
    try {
      const result = await api<{ needsConfirmation?: boolean; estimate?: { usd: number | null; basis: string }; message?: string }>(
        "/api/settings/test",
        { method: "POST", json: { provider, kind: "image", model } },
      );
      if (result.needsConfirmation) {
        setConfirmImageTest({ provider, model, note: result.message ?? "", usd: result.estimate?.usd ?? null });
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  const runImageTest = async () => {
    if (!confirmImageTest) return;
    setBusy("image-test");
    try {
      const result = await api<{ ok: boolean; latencyMs: number; images: number }>("/api/settings/test", {
        method: "POST",
        json: { provider: confirmImageTest.provider, kind: "image", model: confirmImageTest.model, confirmImageCost: true },
      });
      setTestResult(`آزمون تصویری انجام شد: ${result.images} تصویر در ${result.latencyMs} میلی‌ثانیه. تصویر ذخیره نشد.`);
      setConfirmImageTest(null);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  if (!data) {
    return (
      <main className="main">
        <ErrorNote error={error} onRetry={() => void load()} />
        <Spinner />
      </main>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          {en ? "Connection settings" : "تنظیمات اتصال‌ها"} <small>{en ? "Ravayat Studio" : "استودیوی روایت"} {data.appVersion}</small>
        </div>
        <div className="grow" />
        <LanguageToggle />
        <Link href="/" className="btn btn-secondary btn-md">
          {en ? "Back to projects" : "بازگشت به پروژه‌ها"}
        </Link>
      </header>
      <main className="main" style={{ maxWidth: 1000, margin: "0 auto", width: "100%" }}>
        {en ? <Notice tone="info">English support is partial. Connection settings and AI controls are currently in Persian.</Notice> : null}
        <ErrorNote error={error} />
        {notice ? <Notice tone="ok">{notice}</Notice> : null}
        {testResult ? <Notice tone="ok">{testResult}</Notice> : null}

        <Notice tone="info">
          <div>
            <strong>حریم خصوصی:</strong> {data.secrets.note} کلیدها در پایگاه داده، فایل پروژه، خروجی، بستهٔ پشتیبان یا لاگ
            نوشته نمی‌شوند. برنامه بدون کلید هم می‌نویسد، ذخیره می‌کند و خروجی می‌گیرد؛ فقط تولید و بازبینی AI به کلید نیاز
            دارد.
          </div>
        </Notice>

        <ChatGPTConnection />
        <Card title="کلیدهای API">
          {(["openai", "google"] as const).map((provider) => {
            const providerInfo = data.providers.find((p) => p.id === provider);
            return (
              <div key={provider} className="issue" style={{ marginBottom: 10 }}>
                <div className="row between">
                  <strong>{providerInfo?.label ?? provider}</strong>
                  <Badge tone={data.keys[provider] ? "ok" : "warn"}>{data.keys[provider] ? "کلید تنظیم شده" : "بدون کلید"}</Badge>
                </div>
                <div className="row">
                  <input
                    type="password"
                    autoComplete="off"
                    placeholder={data.keys[provider] ? "کلید تازه برای جایگزینی…" : "کلید API را وارد کنید"}
                    value={keyInputs[provider]}
                    onChange={(e) => setKeyInputs((current) => ({ ...current, [provider]: e.target.value }))}
                  />
                  <Button size="sm" variant="primary" onClick={() => void saveKey(provider)} disabled={!keyInputs[provider].trim() || busy !== null}>
                    ذخیره
                  </Button>
                  {data.keys[provider] ? (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => void deleteKey(provider)} disabled={busy !== null}>
                        حذف
                      </Button>
                      <Button size="sm" onClick={() => void testText(provider)} disabled={busy !== null}>
                        آزمون متنی
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void askImageTest(provider)} disabled={busy !== null}>
                        آزمون تصویری
                      </Button>
                    </>
                  ) : null}
                </div>
                <span className="small muted">
                  پشتیبانی: بینایی {providerInfo?.capabilities.vision ? "دارد" : "ندارد"} · تولید تصویر{" "}
                  {providerInfo?.capabilities.imageGeneration ? "دارد" : "ندارد"} · حداکثر مرجع{" "}
                  {providerInfo?.capabilities.maxReferenceImages ?? 0} · ماسک {providerInfo?.capabilities.mask ? "دارد" : "ندارد"}
                </span>
              </div>
            );
          })}
          <p className="small muted">
            آزمون متنی ارزان‌ترین روش معتبر است. آزمون تصویری یک تصویر واقعی می‌سازد و پیش از اجرا برآورد هزینه را نشان
            می‌دهد؛ نتیجهٔ آزمون به هیچ پنلی متصل نمی‌شود.
          </p>
        </Card>

        <Card title="مدل‌های پیش‌فرض">
          <div className="grid grid-2">
            <Field label="مدل متن و بینایی">
              <select
                value={`${data.settings.textProvider}:${data.settings.textModel}`}
                onChange={(e) => {
                  const [provider, model] = e.target.value.split(":");
                  void saveSettings({ text: { provider, model } });
                }}
              >
                {data.models
                  .filter((m) => m.kind === "text")
                  .map((m) => (
                    <option key={`${m.provider}:${m.id}`} value={`${m.provider}:${m.id}`}>
                      {m.label}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="مدل تصویر">
              <select
                value={`${data.settings.imageProvider}:${data.settings.imageModel}`}
                onChange={(e) => {
                  const [provider, model] = e.target.value.split(":");
                  void saveSettings({ image: { provider, model } });
                }}
              >
                {data.models
                  .filter((m) => m.kind === "image")
                  .map((m) => (
                    <option key={`${m.provider}:${m.id}`} value={`${m.provider}:${m.id}`}>
                      {m.label}
                    </option>
                  ))}
              </select>
            </Field>
          </div>
        </Card>

        <Card title="جهت رابط، جهت متن و ترتیب پنل‌ها">
          <p className="small muted">این سه تنظیم مستقل‌اند: زبان داستان با جهت رابط یکی فرض نمی‌شود.</p>
          <div className="grid grid-3">
            <Field label="جهت رابط">
              <select value={data.settings.uiDirection} onChange={(e) => void saveSettings({ uiDirection: e.target.value })}>
                <option value="rtl">راست‌به‌چپ</option>
                <option value="ltr">چپ‌به‌راست</option>
              </select>
            </Field>
            <Field label="جهت متن ویرایشگر">
              <select value={data.settings.textDirection} onChange={(e) => void saveSettings({ textDirection: e.target.value })}>
                <option value="rtl">راست‌به‌چپ</option>
                <option value="ltr">چپ‌به‌راست</option>
              </select>
            </Field>
            <Field label="ترتیب پنل‌ها">
              <select value={data.settings.panelOrder} onChange={(e) => void saveSettings({ panelOrder: e.target.value })}>
                <option value="rtl">راست‌به‌چپ</option>
                <option value="ltr">چپ‌به‌راست</option>
              </select>
            </Field>
          </div>
        </Card>

        <Card title={`کاتالوگ مدل‌ها (بازبینی: ${data.catalogVerifiedAt})`}>
          <p className="small muted">
            شناسهٔ مدل، قیمت و محدودیت‌ها از مستندات رسمی ثبت شده‌اند. قیمت‌ها ممکن است تغییر کنند؛ تاریخ و منبع هر ردیف
            نگه‌داری می‌شود.
          </p>
          <div className="col" style={{ gap: 8 }}>
            {data.models.map((model) => (
              <div key={`${model.provider}:${model.id}`} className="issue">
                <div className="row between">
                  <strong className="small">{model.label}</strong>
                  <Badge tone="muted">{model.kind === "image" ? "تصویر" : "متن/بینایی"}</Badge>
                </div>
                <span className="mono">{model.id}</span>
                <span className="small muted">{model.capabilities.notes}</span>
                <span className="small">
                  قیمت:{" "}
                  {model.price.unit === "per_image"
                    ? Object.entries(model.price.imageUsdBySize ?? {}).map(([size, usd]) => `${size}: ${formatUsd(usd)}`).join(" · ") || "نامشخص"
                    : `${formatUsd(model.price.inputUsd)} ورودی / ${formatUsd(model.price.outputUsd)} خروجی به‌ازای یک‌میلیون توکن`}
                </span>
                <span className="small muted">
                  منبع: <span className="mono">{model.price.sourceUrl}</span> · تاریخ نرخ: {model.price.effectiveDate}
                </span>
              </div>
            ))}
          </div>
        </Card>

        <Card title="وضعیت برنامه">
          <div className="kv">
            <dt>نسخه</dt>
            <dd>{data.appVersion}</dd>
            <dt>نسخهٔ پایگاه داده</dt>
            <dd>{status?.schemaVersion ?? "—"}</dd>
            <dt>پوشهٔ داده</dt>
            <dd className="mono">{data.dataDir ?? "پیش‌فرض برنامه"}</dd>
            <dt>خزانهٔ کلید</dt>
            <dd>{data.secrets.mode === "credential_manager" ? "Windows Credential Manager" : data.secrets.mode === "session_memory" ? "فقط حافظهٔ نشست" : "در دسترس نیست"}</dd>
            <dt>صف</dt>
            <dd>
              {status?.queue.started ? "فعال" : "غیرفعال"} · {status?.queue.queued ?? 0} کار در انتظار
            </dd>
          </div>
          <p className="small muted">
            ذخیرهٔ محلی به‌معنای پردازش کاملاً آفلاین نیست: متن و تصاویر روی دستگاه می‌مانند، اما تولید و بازبینی AI فقط با
            اتصال و کلید شما انجام می‌شود.
          </p>
        </Card>
      </main>

      {confirmImageTest ? (
        <Modal title="تأیید آزمون تصویری" onClose={() => setConfirmImageTest(null)}>
          <p className="small">
            این آزمون یک تصویر واقعی از {confirmImageTest.provider} می‌سازد. هزینه ممکن است اعمال شود.
          </p>
          <p className="small">
            برآورد منتشرشده: <strong>{formatUsd(confirmImageTest.usd)}</strong>
          </p>
          <p className="small muted">{confirmImageTest.note}</p>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <Button variant="ghost" onClick={() => setConfirmImageTest(null)}>
              انصراف
            </Button>
            <Button variant="primary" onClick={() => void runImageTest()} disabled={busy !== null}>
              {busy ? "در حال اجرا…" : "هزینه را می‌پذیرم و آزمون کن"}
            </Button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
