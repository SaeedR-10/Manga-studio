"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorText, formatDate } from "@/lib/api";
import { useWorkspace } from "@/components/workspace";
import { Badge, Button, Card, Empty, ErrorNote, Notice, Spinner } from "@/components/ui";

interface ExportItem {
  id: string;
  kind: string;
  filename: string;
  url: string;
  createdAt: string;
}

const KIND_LABELS: Record<string, string> = {
  markdown: "متن Markdown",
  "panel-script": "فیلم‌نامهٔ پنل",
  package: "بستهٔ پروژه",
  pdf: "PDF",
  page_png: "PNG صفحه",
  panel_png: "PNG پنل",
};

export default function ExportView() {
  const ctx = useWorkspace();
  const { bundle } = ctx;
  const [items, setItems] = useState<ExportItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [backup, setBackup] = useState<{ path: string; bytes: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ exports: ExportItem[] }>(`/api/projects/${bundle.project.id}/exports`);
      setItems(data.exports);
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

  const create = async (kind: "markdown" | "script" | "package") => {
    setBusy(kind);
    try {
      await api(`/api/projects/${bundle.project.id}/exports`, { method: "POST", json: { kind } });
      setNotice("خروجی ساخته شد.");
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  const createBackup = async () => {
    setBusy("backup");
    try {
      const data = await api<{ backup: { path: string; bytes: number } }>(`/api/projects/${bundle.project.id}/backup`, { method: "POST" });
      setBackup(data.backup);
      setNotice("پشتیبان یکپارچهٔ SQLite ساخته شد.");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
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

      <Card title="خروجی‌های پروژه">
        <p className="small muted">
          متن با UTF-8 و BOM ذخیره می‌شود تا در ویندوز و ویرایشگرهای فارسی درست باز شود. پنل‌ها و صفحه‌ها از بخش
          «صفحه‌بندی» به PNG/PDF تبدیل می‌شوند.
        </p>
        <div className="row">
          <Button variant="primary" onClick={() => void create("markdown")} disabled={busy !== null}>
            متن رمان (Markdown)
          </Button>
          <Button onClick={() => void create("script")} disabled={busy !== null}>
            فیلم‌نامهٔ پنل‌ها (Markdown)
          </Button>
          <Button onClick={() => void create("package")} disabled={busy !== null}>
            بستهٔ کامل پروژه (ZIP)
          </Button>
          <Button variant="ghost" onClick={() => void createBackup()} disabled={busy !== null}>
            پشتیبان پایگاه داده
          </Button>
        </div>
        {busy ? <Spinner label="در حال ساخت خروجی…" /> : null}
        {backup ? (
          <p className="small muted">
            پشتیبان ذخیره شد: <span className="mono">{backup.path}</span> ({Math.round(backup.bytes / 1024)} کیلوبایت)
          </p>
        ) : null}
        <div className="sep" />
        <p className="small muted">
          بستهٔ پروژه شامل پایگاه داده، متن، نسخه‌ها و تصاویر اصلی است. کلیدهای API در بسته نیستند. برای بازیابی، از صفحهٔ
          نخست «بازیابی بستهٔ پروژه» را بزنید؛ پروژه در یک رکورد تازه و با همان ارتباط‌ها ساخته می‌شود.
        </p>
      </Card>

      <Card title="فایل‌های ساخته‌شده" actions={<Badge>{items.length}</Badge>}>
        {loading ? <Spinner /> : null}
        {items.length === 0 && !loading ? <Empty title="هنوز خروجی‌ای ساخته نشده است." /> : null}
        <div className="list">
          {items.map((item) => (
            <div key={item.id} className="list-item" style={{ cursor: "default" }}>
              <div>
                <strong className="small">{item.filename}</strong>
                <div className="small muted">
                  {KIND_LABELS[item.kind] ?? item.kind} · {formatDate(item.createdAt)}
                </div>
              </div>
              <a className="btn btn-secondary btn-sm" href={item.url} download>
                دریافت
              </a>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
