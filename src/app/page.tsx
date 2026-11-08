"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { api, formatDate, HttpError } from "@/lib/api";
import { Button, ErrorNote, Field, Modal, Notice, Spinner } from "@/components/ui";
import { LanguageToggle, ThemeToggle, usePreferences } from "@/components/preferences";
import type { Project } from "@/lib/types";

interface ProjectSummary {
  project: Project;
  lastScene: { id: string; title: string; chapterTitle: string; updatedAt: string } | null;
  sceneCount: number;
  wordCount: number;
  panelCount: number;
}

const STEPS = [
  { title: "پروژه بسازید", text: "یک عنوان بدهید؛ فصل و صحنهٔ نخست خودکار ساخته می‌شود." },
  { title: "شخصیت را تعریف کنید", text: "در «جهان داستان» نام، توضیح و هویت شخصیت‌ها را ثبت کنید." },
  { title: "مرجع را تأیید کنید", text: "تصویر هویت و مکان را بارگذاری و صریحاً تأیید کنید." },
  { title: "صحنه را بنویسید", text: "در میز نویسنده بنویسید؛ پیش‌نویس روی دیسک می‌ماند." },
  { title: "پنل بسازید", text: "از متن صحنه پنل‌های روایت را بسازید و بعد تصویر تولید کنید." },
];

function coverLetter(title: string): string {
  const clean = title.trim();
  return clean ? [...clean][0] : "؟";
}

export default function HomePage() {
  const { preferences } = usePreferences();
  const en = preferences.language === "en";
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [restored, setRestored] = useState<{ projectId: string; title: string } | null>(null);
  const restoreInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ projects: ProjectSummary[] }>("/api/projects");
      setProjects(data.projects);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    if (!title.trim()) return;
    setBusy("create");
    try {
      const data = await api<{ project: Project }>("/api/projects", {
        method: "POST",
        json: { title: title.trim(), subtitle: subtitle.trim() },
      });
      window.location.href = `/p/${data.project.id}?view=write`;
    } catch (err) {
      setError(err);
      setBusy(null);
    }
  };

  const createSample = async () => {
    setBusy("sample");
    try {
      const data = await api<{ projectId: string; title: string }>("/api/sample", { method: "POST" });
      setNotice(`پروژهٔ نمونهٔ «${data.title}» ساخته شد؛ بدون هیچ درخواست پولی.`);
      await load();
      window.location.href = `/p/${data.projectId}?view=write`;
    } catch (err) {
      setError(err);
      setBusy(null);
    }
  };

  const restore = async (file: File) => {
    setBusy("restore");
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/projects/restore", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new HttpError(res.status, data.error ?? { message: "بازیابی ناموفق بود." });
      setRestored({ projectId: data.projectId, title: data.title });
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
      if (restoreInput.current) restoreInput.current.value = "";
    }
  };

  const filtered = useMemo(() => {
    const query = search.trim();
    if (!query) return projects;
    return projects.filter((item) => {
      const haystack = [item.project.title, item.project.subtitle, item.project.description, item.lastScene?.title ?? ""].join(" ");
      return haystack.toLowerCase().includes(query.toLowerCase());
    });
  }, [projects, search]);

  const recent = projects[0] ?? null;
  const isEmpty = !loading && projects.length === 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <span>{en ? "Ravayat Studio" : "استودیوی روایت"}</span>
          <small>{en ? "Local workspace" : "میزکار محلی"}</small>
        </div>
        <div className="grow" />
        <LanguageToggle />
        <ThemeToggle />
        <Link href="/settings" className="btn btn-secondary btn-sm">
          {en ? "Connection settings" : "تنظیمات اتصال‌ها"}
        </Link>
      </header>

      <main className="main" id="main" style={{ maxWidth: 1180 }}>
        <div className="hero">
          <h1>{en ? "From novel to comic panels" : "از متن رمان تا پنل مانهوا"}</h1>
          <p>
            {en ? "Write stories, organize canon and references, and plan visual panels on your computer. Writing and export work offline without an API key." : "نوشتن فارسی، مرجع قطعی داستان، کتابخانهٔ مراجع و پنل‌های تصویری — همه روی همین رایانه. نوشتن و خروجی بدون اینترنت و بدون کلید API کار می‌کند."}
          </p>
          <div className="row" style={{ marginTop: 14 }}>
            <Button variant="primary" onClick={() => setCreating(true)}>
              {en ? "New project" : "پروژهٔ تازه"}
            </Button>
            <Button onClick={() => restoreInput.current?.click()} disabled={busy === "restore"}>
              {busy === "restore" ? (en ? "Restoring…" : "در حال بازیابی…") : (en ? "Restore project package" : "بازیابی بستهٔ پروژه")}
            </Button>
            <input
              ref={restoreInput}
              type="file"
              accept=".zip,.ravayat.zip,application/zip"
              style={{ display: "none" }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void restore(file);
              }}
            />
            <span className="grow" />
            <label className="search-field" style={{ maxWidth: 260 }}>
              <span className="sr-only">جست‌وجوی پروژه</span>
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={en ? "Search projects…" : "جست‌وجو در عنوان‌ها…"} />
            </label>
          </div>
        </div>

        {en ? <Notice tone="info">English support is partial: project navigation and the library are translated, while editing, AI settings and some messages remain in Persian.</Notice> : null}
        <ErrorNote error={error} onRetry={() => void load()} />
        {notice ? <Notice tone="ok">{notice}</Notice> : null}
        {restored ? (
          <Notice tone="ok">
            بسته بازیابی شد: «{restored.title}». <Link href={`/p/${restored.projectId}?view=write`}>باز کردن پروژه</Link>
          </Notice>
        ) : null}

        {isEmpty ? (
          <section className="firstrun" style={{ marginTop: 18 }}>
            <div className="row between">
              <h2 style={{ fontSize: "var(--fs-md)" }}>{en ? "Get started in five steps" : "شروع کار در پنج قدم"}</h2>
              <Button size="sm" variant="ghost" onClick={createSample} disabled={busy === "sample"}>
                {busy === "sample" ? (en ? "Creating…" : "در حال ساخت…") : (en ? "Create sample project" : "دیدن یک نمونهٔ کامل")}
              </Button>
            </div>
            <p className="small muted" style={{ marginTop: 6 }}>
              {en ? "The sample contains two characters, a location, 12 panels and a flashback. No API key is needed." : "نمونه دو شخصیت، یک مکان، یک صحنهٔ ۱۲ پنلی و یک فلش‌بک دارد و بدون کلید API ساخته می‌شود."}
            </p>
            <ol className="steps">
              {(en ? [{ title: "Create a project", text: "Give your story a title." }, { title: "Define characters", text: "Describe your characters and their identities." }, { title: "Approve references", text: "Add identity and location images." }, { title: "Write a scene", text: "Draft your story in the writer workspace." }, { title: "Make panels", text: "Turn your scene into panels and generate images." }] : STEPS).map((step, index) => (
                <li key={step.title}>
                  <span className="step-num">{en ? "Step" : "قدم"} {index + 1}</span>
                  <strong>{step.title}</strong>
                  <span className="small muted">{step.text}</span>
                </li>
              ))}
            </ol>
            <Button variant="primary" style={{ marginTop: 16 }} onClick={() => setCreating(true)}>
              {en ? "Create your first project" : "ساخت نخستین پروژه"}
            </Button>
          </section>
        ) : null}

        {recent && recent.lastScene && !search ? (
          <section
            style={{
              marginTop: 18,
              border: "1px solid var(--border)",
              borderRadius: "var(--r-md)",
              background: "var(--surface)",
              padding: "var(--s-5)",
              display: "flex",
              gap: "var(--s-4)",
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <div className="grow">
              <span className="xs muted">{en ? "Continue writing" : "ادامهٔ نوشتن"}</span>
              <h2 style={{ fontSize: "var(--fs-lg)" }}>{recent.lastScene.title}</h2>
              <p className="small muted" style={{ margin: 0 }}>
                {recent.project.title} · {recent.lastScene.chapterTitle} · آخرین تغییر {formatDate(recent.lastScene.updatedAt)}
              </p>
            </div>
            <Link className="btn btn-primary btn-md" href={`/p/${recent.project.id}?view=write&scene=${recent.lastScene.id}`}>
              {en ? "Continue writing" : "ادامهٔ نوشتن"}
            </Link>
          </section>
        ) : null}

        <section style={{ marginTop: 24 }}>
          <div className="row between" style={{ marginBottom: 10 }}>
            <h2 style={{ fontSize: "var(--fs-md)" }}>{search ? (en ? `Search results (${filtered.length})` : `نتیجهٔ جست‌وجو (${filtered.length})`) : (en ? "Projects" : "پروژه‌ها")}</h2>
            <Button size="sm" variant="ghost" onClick={() => void load()}>
              {en ? "Refresh" : "به‌روزرسانی"}
            </Button>
          </div>
          {loading ? (
            <Spinner />
          ) : filtered.length === 0 ? (
            <p className="muted small">{search ? (en ? "No projects found." : "پروژه‌ای با این عنوان پیدا نشد.") : (en ? "No projects yet." : "هنوز پروژه‌ای نیست.")}</p>
          ) : (
            <div className="grid grid-3">
              {filtered.map(({ project, lastScene, wordCount, panelCount, sceneCount }) => (
                <article className="project-card" key={project.id}>
                  <div className="row" style={{ gap: 12, alignItems: "flex-start" }}>
                    <div
                      aria-hidden
                      style={{
                        width: 46,
                        height: 60,
                        borderRadius: 6,
                        border: "1px solid var(--border-strong)",
                        background: "linear-gradient(180deg, var(--surface-2), var(--surface-3))",
                        display: "grid",
                        placeItems: "center",
                        fontSize: 20,
                        color: "var(--muted)",
                        flex: "none",
                      }}
                    >
                      {coverLetter(project.title)}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <h3 style={{ fontSize: "var(--fs-md)" }}>{project.title}</h3>
                      {project.subtitle ? <p className="small muted" style={{ margin: 0 }}>{project.subtitle}</p> : null}
                      <div className="meta" style={{ marginTop: 6 }}>
                        <span>{project.publishFormat === "page" ? "صفحه‌ای" : "اسکرول عمودی"}</span>
                        <span>·</span>
                        <span>{sceneCount.toLocaleString("fa-IR")} صحنه</span>
                        <span>·</span>
                        <span>{wordCount.toLocaleString("fa-IR")} واژه</span>
                        {panelCount ? (
                          <>
                            <span>·</span>
                            <span>{panelCount.toLocaleString("fa-IR")} پنل</span>
                          </>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  <p className="small muted" style={{ margin: "4px 0 0" }}>
                    {lastScene ? `آخرین صحنه: ${lastScene.title} — ${formatDate(lastScene.updatedAt)}` : "هنوز صحنه‌ای ندارد."}
                  </p>
                  <div className="row" style={{ marginTop: "auto" }}>
                    <Link
                      href={`/p/${project.id}?view=write${lastScene ? `&scene=${lastScene.id}` : ""}`}
                      className="btn btn-primary btn-sm"
                    >
                      {lastScene ? (en ? "Continue writing" : "ادامهٔ نوشتن") : (en ? "Start writing" : "شروع نوشتن")}
                    </Link>
                    <Link href={`/p/${project.id}?view=board`} className="btn btn-secondary btn-sm">
                      {en ? "Panel board" : "برد پنل‌ها"}
                    </Link>
                    <Link href={`/p/${project.id}?view=export`} className="btn btn-ghost btn-sm">
                      {en ? "Export" : "خروجی"}
                    </Link>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </main>

      {creating ? (
        <Modal title={en ? "New project" : "پروژهٔ تازه"} onClose={() => setCreating(false)}>
          <Field label={en ? "Project title" : "نام پروژه"}>
            <input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus placeholder={en ? "For example: Sea and Shadow" : "مثلاً: دریا و سایه"} />
          </Field>
          <Field label={en ? "Subtitle (optional)" : "زیرعنوان (اختیاری)"}>
            <input value={subtitle} onChange={(event) => setSubtitle(event.target.value)} />
          </Field>
          <p className="small muted">
            {en ? "A chapter, empty scene and vertical layout will be created. You can change the publication format later." : "پروژه با یک فصل/صحنهٔ خالی، نسخهٔ اقتباس و سند صفحه‌بندی عمودی ساخته می‌شود. قالب انتشار بعداً قابل تغییر است."}
          </p>
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 8 }}>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              {en ? "Cancel" : "انصراف"}
            </Button>
            <Button variant="primary" onClick={() => void create()} disabled={!title.trim() || busy === "create"}>
              {busy === "create" ? (en ? "Creating…" : "در حال ساخت…") : (en ? "Create project" : "ساخت پروژه")}
            </Button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
