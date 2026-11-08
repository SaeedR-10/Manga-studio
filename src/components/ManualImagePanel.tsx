"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, Card, ErrorNote, Notice } from "./ui";
export default function ManualImagePanel({ panelId, options, onImported }: { panelId: string; options?: Record<string, unknown>; onImported: () => Promise<void> }) {
  const [handoff, setHandoff] = useState<{ handoffId: string; url: string; prompt: string; referenceCount: number } | null>(null); const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [changed, setChanged] = useState(false); const [notice, setNotice] = useState("");
  useEffect(() => { setHandoff(null); setChanged(false); setError(null); setNotice(""); }, [panelId]);
  const prepare = async () => { setBusy(true); setError(null); try { setHandoff(await api(`/api/panels/${panelId}/manual`, { method: "POST", json: { action: "prepare", options } })); } catch (e) { setError(e); } finally { setBusy(false); } };
  const importFile = async (file: File) => {
    if (!handoff) return; setBusy(true); setError(null);
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error("تصویر باید کوچک‌تر از ۲۰ مگابایت باشد.");
      const dataUrl = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(file); });
      await api(`/api/panels/${panelId}/manual`, { method: "POST", json: { action: "import", handoffId: handoff.handoffId, filename: file.name, dataUrl, acknowledgeChanged: changed } });
      setNotice("تصویر به خروجی‌های همین پنل افزوده شد؛ آن را انتخاب و بازبینی کنید."); await onImported();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return <Card title="تولید تصویر با انتقال دستی به ChatGPT"><ErrorNote error={error} />{notice && <Notice tone="ok">{notice}</Notice>}
    <p>۱. بستهٔ پرامپت و مراجع این پنل را آماده و دانلود کنید. ۲. فایل‌ها و متن پرامپت را خودتان در ChatGPT وارد کنید. ۳. تصویر نتیجه را دانلود و اینجا وارد کنید.</p>
    <div className="row"><Button onClick={() => void prepare()} disabled={busy}>آماده‌سازی بستهٔ همین پنل</Button><a href="https://chatgpt.com/" target="_blank" rel="noreferrer">بازکردن ChatGPT</a></div>
    {handoff && <><p><a href={handoff.url} download>دانلود بسته با {handoff.referenceCount} مرجع مرتب‌شده</a></p><details><summary>مشاهده و کپی متن پرامپت</summary><textarea value={handoff.prompt} readOnly dir="auto" rows={8} style={{ width: "100%" }} /><Button onClick={() => void navigator.clipboard.writeText(handoff.prompt).catch(setError)}>کپی پرامپت</Button></details>
      <label className="row"><input type="checkbox" checked={changed} onChange={e => setChanged(e.target.checked)} />اگر منبع تغییر کرده، ورود آگاهانهٔ نتیجهٔ مربوط به نسخهٔ قبلی را تأیید می‌کنم.</label>
      <label className="field"><span>ورود تصویر نتیجه به همین پنل</span><input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={e => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void importFile(f); }} /></label>
    </>}
    <p className="small muted">این مسیر چیزی را خودکار در ChatGPT بارگذاری نمی‌کند و درخواست تولید API ندارد. واردکردن تصویر به معنی تأیید هویت یا مرجع شدن آن نیست.</p>
  </Card>;
}
