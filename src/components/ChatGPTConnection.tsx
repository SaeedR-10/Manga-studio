"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Badge, Button, Card, ErrorNote, Field, Notice } from "./ui";
type State = { connected: boolean; sharing: boolean; email: string | null; pending: boolean; error: string | null; storage: string; models: { id: string; label: string }[]; imageWorkflow: string; analysisSource: string; model: string };
export default function ChatGPTConnection() {
  const [state, setState] = useState<State | null>(null); const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [url, setUrl] = useState(""); const [selected, setSelected] = useState("");
  const load = useCallback(async () => { try { const s = await api<State>("/api/settings/chatgpt"); setState(s); if (s.model) setSelected(s.model); } catch (e) { setError(e); } }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!state?.pending) return; const timer = setInterval(() => void load(), 2000); return () => clearInterval(timer); }, [state?.pending, load]);
  const action = async (payload: Record<string, unknown>) => { setBusy(true); setError(null); try { const response = await api<{ url?: string }>("/api/settings/chatgpt", { method: "POST", json: payload }); if (response.url) { setUrl(response.url); window.open(response.url, "_blank", "noopener,noreferrer"); } await load(); } catch (e) { setError(e); } finally { setBusy(false); } };
  return <Card title="اشتراک ChatGPT و روش تولید تصویر">
    <ErrorNote error={error} />
    <p>تحلیل متن و تصاویر مرجع می‌تواند از اشتراک واجد شرایط ChatGPT استفاده کند. تولید تصویر از این اتصال پشتیبانی نمی‌شود؛ روش آن را جدا انتخاب کنید.</p>
    {state && <>
      <div className="row"><Badge tone={state.sharing ? "ok" : "warn"}>{state.sharing ? "مجوز استفاده از اشتراک فعال است" : state.connected ? "وارد شده؛ مجوز اشتراک فعال نیست" : "متصل نیست"}</Badge><span dir="ltr">{state.email}</span></div>
      {state.error && <Notice tone="warn">{state.error}</Notice>}
      {state.connected && state.storage === "session_memory" && <Notice tone="warn">ذخیره در خزانهٔ ویندوز ممکن نشد؛ اتصال فقط تا بستن برنامه در حافظه می‌ماند.</Notice>}
      <div className="row" style={{ marginBlock: 12 }}>
        <Button data-oai-siwc-button onClick={() => void action({ action: "login" })} disabled={busy || state.pending}>{state.pending ? "در انتظار تکمیل ورود…" : "ادامه با ChatGPT"}</Button>
        <Button onClick={() => void action({ action: "refresh-models" })} disabled={busy || !state.sharing}>دریافت مدل‌های حساب</Button>
        {(state.connected || state.pending) && <Button variant="ghost" onClick={() => { setUrl(""); void action({ action: "logout" }); }} disabled={busy}>قطع اتصال / لغو ورود</Button>}
        <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">مدیریت مصرف اشتراک</a>
      </div>
      {url && state.pending && <Notice><a href={url} target="_blank" rel="noreferrer">بازکردن صفحهٔ رسمی ورود در مرورگر</a><p className="small">رمز حساب را فقط در صفحهٔ رسمی وارد کنید. پس از تأیید، به برنامه برگردید.</p></Notice>}
      <div className="grid grid-2">
        <Field label="منبع تحلیل در همهٔ پروژه‌ها"><select value={state.analysisSource} disabled={busy} onChange={e => void action({ action: "analysis", source: e.target.value, model: selected })}><option value="project">مدل و API انتخاب‌شده در تنظیمات هر پروژه</option><option value="chatgpt" disabled={!state.sharing || !selected}>اشتراک ChatGPT</option></select></Field>
        <Field label="مدل تحلیل از فهرست همین حساب"><select value={selected} disabled={busy || !state.sharing} onChange={e => { setSelected(e.target.value); if (state.analysisSource === "chatgpt") void action({ action: "analysis", source: "chatgpt", model: e.target.value }); }}><option value="">ابتدا فهرست مدل‌ها را دریافت و یک مدل انتخاب کنید</option>{state.models.map(m => <option value={m.id} key={m.id}>{m.label}</option>)}</select></Field>
        <Field label="روش تولید تصویر"><select value={state.imageWorkflow} disabled={busy} onChange={e => void action({ action: "workflow", mode: e.target.value })}><option value="api">تولید خودکار با API، با هزینهٔ جدا</option><option value="manual_chatgpt">انتقال دستی به ChatGPT و ورود تصویر نتیجه</option></select></Field>
      </div>
      <p className="small muted">ورود به حساب، تضمین دسترسی به همهٔ مدل‌ها یا سهمیهٔ نامحدود نیست. در خطای اشتراک، برنامه خودکار به API پولی تغییر مسیر نمی‌دهد. در حالت دستی، بستهٔ مراجع را از بخش تولید بگیرید.</p>
    </>}
  </Card>;
}
