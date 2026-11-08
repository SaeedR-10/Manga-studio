"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { ErrorNote, Spinner } from "@/components/ui";
import { LanguageToggle, ThemeToggle, usePreferences } from "@/components/preferences";
import { hydrateDrafts, listDraftSceneIds } from "@/lib/drafts";
import type { Chapter, Entity, Fact, Job, Project, ReferenceAsset, Scene } from "@/lib/types";

export interface Bundle {
  project: Project;
  chapters: Chapter[];
  scenes: Scene[];
  entities: Entity[];
  facts: Fact[];
  styles: Array<{ id: string; name: string; description: string; palette: string; linework: string; notes: string; isDefault: boolean }>;
  references: ReferenceAsset[];
  panelCount: number;
}

/**
 * بخش‌ها به ترتیب کار نویسنده گروه‌بندی می‌شوند: نوشتن، جهان داستان و مراجع،
 * تولید تصویر، انتشار. هیچ بخشی وزن برابر ندارد و گروه‌ها مسیر کار را نشان می‌دهند.
 */
export type ViewId =
  | "write"
  | "scenes"
  | "world"
  | "refs"
  | "board"
  | "produce"
  | "review"
  | "layout"
  | "export"
  | "settings";

export interface NavItem {
  id: ViewId;
  label: string;
  icon: string;
  hint: string;
}

export const NAV_GROUPS: Array<{ id: string; label: string; items: NavItem[] }> = [
  {
    id: "write",
    label: "نوشتن",
    items: [
      { id: "write", label: "میز نویسنده", icon: "✎", hint: "متن صحنه و پیش‌نویس‌ها" },
      { id: "scenes", label: "صحنه‌ها و پنل‌ها", icon: "▤", hint: "ساخت پنل از متن صحنه" },
    ],
  },
  {
    id: "world",
    label: "جهان داستان",
    items: [
      { id: "world", label: "پروندهٔ شخصیت‌ها و جهان", icon: "◍", hint: "هویت، لباس، دانسته‌ها" },
      { id: "refs", label: "کتابخانهٔ مراجع", icon: "▣", hint: "تصاویر تأییدشدهٔ هویت و مکان" },
    ],
  },
  {
    id: "visual",
    label: "تولید تصویر",
    items: [
      { id: "board", label: "برد پنل‌ها", icon: "▦", hint: "ترتیب روایت و کارگردانی پنل" },
      { id: "produce", label: "تولید و اصلاح", icon: "✦", hint: "ساخت تصویر، ماسک و خروجی‌ها" },
      { id: "review", label: "بازبینی", icon: "◎", hint: "سنجش تصویر با مرجع و تصمیم شما" },
      { id: "layout", label: "صفحه‌بندی و متن‌گذاری", icon: "▭", hint: "صفحه، بالن و آماده‌سازی انتشار" },
    ],
  },
  {
    id: "publish",
    label: "انتشار",
    items: [
      { id: "export", label: "خروجی و پشتیبان", icon: "⇩", hint: "PNG/PDF، بستهٔ پروژه" },
      { id: "settings", label: "تنظیمات پروژه", icon: "⚙", hint: "مدل‌ها، سقف‌ها، قالب انتشار" },
    ],
  },
];

export const VIEWS = NAV_GROUPS.flatMap((group) => group.items);

export interface SaveStatus {
  label: string;
  tone: "ok" | "warn" | "bad" | "muted";
}

interface WorkspaceContextValue {
  bundle: Bundle;
  reload: () => Promise<void>;
  /** پس از ذخیرهٔ متن، نمای مشترک را با متن تأییدشده هم‌راستا می‌کند */
  patchScene: (sceneId: string, patch: Partial<Scene>) => void;
  view: ViewId;
  setView: (view: ViewId) => void;
  selectedSceneId: string | null;
  setSelectedSceneId: (id: string | null) => void;
  selectedPanelId: string | null;
  setSelectedPanelId: (id: string | null) => void;
  uiDirection: "rtl" | "ltr";
  textDirection: "rtl" | "ltr";
  panelOrder: "rtl" | "ltr";
  /** وضعیت ذخیرهٔ نما؛ نوار بالای میزکار آن را نشان می‌دهد */
  saveStatus: SaveStatus | null;
  reportSaveStatus: (status: SaveStatus | null) => void;
  /** پیش‌نویس‌های بازیابی‌نشده */
  draftCount: number;
  refreshDrafts: () => void;
  refreshTick: number;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("Workspace context missing");
  return ctx;
}

const VIEW_LABELS = new Map(VIEWS.map((item) => [item.id, item.label]));

export function WorkspaceShell({ projectId }: { projectId: string }) {
  const { preferences, setPreference } = usePreferences();
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [view, setViewState] = useState<ViewId>("write");
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);
  const [selectedPanelId, setSelectedPanelId] = useState<string | null>(null);
  const [dirs, setDirs] = useState({ uiDirection: "rtl" as "rtl" | "ltr", textDirection: "rtl" as "rtl" | "ltr", panelOrder: "rtl" as "rtl" | "ltr" });
  const [saveStatus, setSaveStatus] = useState<SaveStatus | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [focusMode, setFocusMode] = useState(false);
  const [draftCount, setDraftCount] = useState(0);
  const [refreshTick, setRefreshTick] = useState(0);
  const dragging = useRef(false);

  const load = useCallback(async () => {
    try {
      // پیش‌نویس‌ها پیش از نمایش هر صحنه خوانده می‌شوند تا بازیابی از دست نرود.
      await hydrateDrafts();
      const data = await api<Bundle>(`/api/projects/${projectId}`);
      setBundle(data);
      setError(null);
      setSelectedSceneId((current) => current ?? data.scenes[0]?.id ?? null);
      setDraftCount(listDraftSceneIds().length);
    } catch (err) {
      setError(err);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("view") as ViewId | null;
    if (requested && VIEWS.some((v) => v.id === requested)) setViewState(requested);
    const scene = params.get("scene");
    if (scene) setSelectedSceneId(scene);
    const panel = params.get("panel");
    if (panel) setSelectedPanelId(panel);
    void api<{ settings: Record<string, string> }>("/api/settings")
      .then((data) => {
        setDirs({
          uiDirection: data.settings.uiDirection === "ltr" ? "ltr" : "rtl",
          textDirection: data.settings.textDirection === "ltr" ? "ltr" : "rtl",
          panelOrder: data.settings.panelOrder === "ltr" ? "ltr" : "rtl",
        });
      })
      .catch(() => undefined);
  }, []);

  // نشانگر کارهای پس‌زمینه در تمام میزکار دیده می‌شود، نه فقط در یک نما.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await api<{ jobs: Job[] }>(`/api/projects/${projectId}/jobs`);
        if (!cancelled) setJobs(data.jobs);
      } catch {
        /* خطای موقت شبکه نباید کار نویسنده را متوقف کند */
      }
    };
    void poll();
    const timer = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectId]);

  useEffect(() => {
    document.documentElement.dir = preferences.language === "en" ? "ltr" : dirs.uiDirection;
  }, [dirs.uiDirection, preferences.language]);

  const setView = useCallback((next: ViewId) => {
    setViewState(next);
    const url = new URL(window.location.href);
    url.searchParams.set("view", next);
    window.history.replaceState({}, "", url.toString());
  }, []);

  const patchScene = useCallback((sceneId: string, patch: Partial<Scene>) => {
    setBundle((current) =>
      current ? { ...current, scenes: current.scenes.map((scene) => (scene.id === sceneId ? { ...scene, ...patch } : scene)) } : current,
    );
  }, []);

  const refreshDrafts = useCallback(() => {
    setDraftCount(listDraftSceneIds().length);
    setRefreshTick((tick) => tick + 1);
  }, []);

  // میان‌برهای صفحه‌کلید عمداً Ctrl+Alt دارند تا با تایپ فارسی و ویرایش متن
  // معمولی (Ctrl+S/Ctrl+Z/Ctrl+Z+Shift) تضاد نکنند.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.altKey) return;
      const order = VIEWS.map((item) => item.id);
      if (event.key === "b") {
        event.preventDefault();
        setPreference("navCollapsed", !preferences.navCollapsed);
        return;
      }
      if (event.key === "f") {
        event.preventDefault();
        setFocusMode((current) => !current);
        return;
      }
      const current = order.indexOf(view);
      if (event.key === "ArrowRight") {
        event.preventDefault();
        setView(order[(current + (dirs.uiDirection === "rtl" ? -1 : 1) + order.length) % order.length]);
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setView(order[(current + (dirs.uiDirection === "rtl" ? 1 : -1) + order.length) % order.length]);
        return;
      }
      const index = Number(event.key);
      if (Number.isInteger(index) && index >= 1 && index <= order.length) {
        event.preventDefault();
        setView(order[index - 1]);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [view, setView, setPreference, preferences.navCollapsed, dirs.uiDirection]);

  // تغییر عرض نوار کنار با کشیدن دستگیره و ذخیرهٔ آن در پوشهٔ داده.
  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      if (!dragging.current) return;
      const next = dirs.uiDirection === "rtl" ? event.clientX : window.innerWidth - event.clientX;
      setPreference("navWidth", Math.min(360, Math.max(190, next)));
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [setPreference, dirs.uiDirection]);

  const value = useMemo<WorkspaceContextValue | null>(
    () =>
      bundle
        ? {
            bundle,
            reload: load,
            patchScene,
            view,
            setView,
            selectedSceneId,
            setSelectedSceneId,
            selectedPanelId,
            setSelectedPanelId,
            ...dirs,
            saveStatus,
            reportSaveStatus: setSaveStatus,
            draftCount,
            refreshDrafts,
            refreshTick,
          }
        : null,
    [bundle, load, patchScene, view, setView, selectedSceneId, selectedPanelId, dirs, saveStatus, draftCount, refreshDrafts, refreshTick],
  );

  if (!bundle || !value) {
    return (
      <div className="main" id="main">
        <ErrorNote error={error} onRetry={() => void load()} />
        {!error ? <Spinner label="در حال آماده‌سازی میزکار…" /> : null}
      </div>
    );
  }

  const en = preferences.language === "en";
  const englishLabels: Record<string, string> = {write: "Writer", scenes: "Scenes and panels", world: "Characters and world", refs: "Reference library", board: "Panel board", produce: "Generate and edit", review: "Review", layout: "Layout and lettering", export: "Export and backup", settings: "Project settings", visual: "Image production", publish: "Publish"};
  const activeJobs = jobs.filter((job) => ["queued", "sending", "processing", "unknown"].includes(job.status));
  const next = nextAction(bundle, selectedSceneId);
  const scene = bundle.scenes.find((item) => item.id === selectedSceneId) ?? null;
  const chapter = scene ? bundle.chapters.find((item) => item.id === scene.chapterId) ?? null : null;

  return (
    <WorkspaceContext.Provider value={value}>
      <div
        className="shell"
        data-nav={preferences.navCollapsed ? "collapsed" : "expanded"}
        data-focus={focusMode ? "true" : "false"}
        style={
          {
            "--nav-w": `${preferences.navCollapsed ? 72 : preferences.navWidth}px`,
            "--inspector-w": `${preferences.inspectorWidth}px`,
            "--editor-fs": `${preferences.editorFontSize}px`,
            "--editor-lh": `${preferences.editorLineHeight}`,
            "--reading-w": `${preferences.readingWidth}ch`,
          } as React.CSSProperties
        }
      >
        <nav className="sidebar" aria-label="بخش‌های پروژه">
          <div className="nav-project">
            <strong title={bundle.project.title}>{bundle.project.title}</strong>
            <span className="small muted">{bundle.project.publishFormat === "page" ? "قالب صفحه‌ای" : "اسکرول عمودی"}</span>
          </div>
          {NAV_GROUPS.map((group) => (
            <div className="navgroup" key={group.id}>
              <span className="navgroup-title">{en ? ({write: "Writing", world: "Story world", visual: "Image production", publish: "Publish"} as Record<string, string>)[group.id] : group.label}</span>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  className={`navbtn ${view === item.id ? "active" : ""}`}
                  onClick={() => {
                    setView(item.id);
                    setFocusMode(false);
                  }}
                  aria-current={view === item.id ? "page" : undefined}
                  title={en ? englishLabels[item.id] : `${item.label} — ${item.hint}`}
                >
                  <span className="navicon" aria-hidden>
                    {item.icon}
                  </span>
                  <span>{en ? englishLabels[item.id] : item.label}</span>
                  {item.id === "write" && draftCount ? <span className="navmeta">{draftCount} پیش‌نویس</span> : null}
                  {item.id === "board" || item.id === "scenes" ? <span className="navmeta">{bundle.panelCount}</span> : null}
                </button>
              ))}
            </div>
          ))}
          <div className="nav-foot">
            {draftCount ? (
              <button className="navbtn" onClick={() => setView("write")} title="پیش‌نویس بازیابی‌نشده دارید">
                <span className="navicon" aria-hidden>
                  ●
                </span>
                <span>{draftCount} پیش‌نویس بازنشده</span>
              </button>
            ) : null}
            <Link className="navbtn" href="/">
              <span className="navicon" aria-hidden>
                ⌂
              </span>
              <span>{en ? "Project library" : "کتابخانهٔ پروژه‌ها"}</span>
            </Link>
            <Link className="navbtn" href="/settings">
              <span className="navicon" aria-hidden>
                ⚙
              </span>
              <span>{en ? "Connection settings" : "تنظیمات اتصال‌ها"}</span>
            </Link>
            <button
              className="navbtn"
              onClick={() => setPreference("navCollapsed", !preferences.navCollapsed)}
              title="جمع/باز کردن نوار کنار (Ctrl+Alt+B)"
            >
              <span className="navicon" aria-hidden>
                {preferences.navCollapsed ? "»" : "«"}
              </span>
              <span>جمع کردن نوار کنار</span>
            </button>
          </div>
          <div
            className="nav-resize"
            role="separator"
            aria-orientation="vertical"
            aria-label="تغییر عرض نوار کنار"
            onMouseDown={() => {
              dragging.current = true;
              document.body.style.cursor = "col-resize";
            }}
            onDoubleClick={() => setPreference("navWidth", 248)}
          />
        </nav>

        <div className="col" style={{ gap: 0, minWidth: 0 }}>
          <div className="workbar">
            <nav className="crumbs" aria-label="مسیر جاری">
              <Link href="/">{en ? "Projects" : "پروژه‌ها"}</Link>
              <span className="sep-dot">›</span>
              <strong title={bundle.project.title}>{bundle.project.title}</strong>
              {chapter ? (
                <>
                  <span className="sep-dot">›</span>
                  <span>{chapter.title}</span>
                </>
              ) : null}
              {scene ? (
                <>
                  <span className="sep-dot">›</span>
                  <select
                    value={scene.id}
                    onChange={(event) => setSelectedSceneId(event.target.value)}
                    aria-label="تغییر صحنه"
                    title="تغییر صحنه"
                  >
                    {bundle.scenes.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.title}
                      </option>
                    ))}
                  </select>
                </>
              ) : null}
            </nav>
            <span className="grow" />
            {saveStatus ? (
              <span className="savebar" aria-live="polite">
                <span className={`badge ${saveStatus.tone}`}>{saveStatus.label}</span>
              </span>
            ) : null}
            <span className="badge" title="بخش جاری">
              {en ? englishLabels[view] : VIEW_LABELS.get(view)}
            </span>
            {activeJobs.length ? (
              <button
                className="badge warn"
                onClick={() => setView("produce")}
                title="کار پس‌زمینه در جریان است؛ از هر بخشی قابل دیدن است"
              >
                ⟳ {activeJobs.length} کار در جریان
              </button>
            ) : null}
            <button className="iconbtn" onClick={() => setFocusMode((current) => !current)} title="حالت تمرکز (Ctrl+Alt+F)" aria-pressed={focusMode}>
              <span aria-hidden>{focusMode ? "◱" : "◳"}</span>
              <span className="small">تمرکز</span>
            </button>
            <LanguageToggle />
            <ThemeToggle />
          </div>

          {next && !focusMode && !en ? (
            <div className="main" style={{ paddingBottom: 0, maxWidth: 1440 }}>
              <button className="alert alert-info" style={{ width: "100%", textAlign: "start", cursor: "pointer" }} onClick={() => setView(next.view)}>
                <span>
                  <strong>قدم بعدی: </strong>
                  {next.text}
                </span>
                <span className="small">باز کردن {VIEW_LABELS.get(next.view)}</span>
              </button>
            </div>
          ) : null}

          <div className="main" id="main">
            <ViewRouter />
          </div>
        </div>
      </div>
    </WorkspaceContext.Provider>
  );
}

/**
 * قدم بعدی بر پایهٔ وضعیت واقعی داده پیشنهاد می‌شود؛ هیچ عدد یا آماری ساخته نمی‌شود.
 */
function nextAction(bundle: Bundle, sceneId: string | null): { text: string; view: ViewId } | null {
  if (bundle.scenes.length === 0) return { text: "هنوز صحنه‌ای ندارید؛ نخستین فصل و صحنه را بسازید.", view: "write" };
  const scene = bundle.scenes.find((item) => item.id === sceneId);
  if (bundle.entities.length === 0) return { text: "شخصیت‌ها و مکان‌های داستان را تعریف کنید.", view: "world" };
  if (bundle.references.length === 0) return { text: "تصویر مرجع هویت و مکان را بارگذاری و تأیید کنید.", view: "refs" };
  if (bundle.panelCount === 0 && scene) return { text: `از متن «${scene.title}» پنل بسازید.`, view: "scenes" };
  if (bundle.panelCount > 0 && bundle.references.some((ref) => ref.status !== "approved")) {
    return { text: "چند مرجع هنوز تأیید نشده‌اند؛ پیش از تولید آن‌ها را بررسی کنید.", view: "refs" };
  }
  return null;
}

function ViewRouter() {
  const ctx = useWorkspace();
  const { view } = ctx;
  const [module, setModule] = useState<React.ComponentType | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const map: Record<ViewId, () => Promise<{ default: React.ComponentType }>> = {
        write: () => import("@/components/views/WriteView"),
        world: () => import("@/components/views/WorldView"),
        refs: () => import("@/components/views/RefsView"),
        scenes: () => import("@/components/views/ScenesView"),
        board: () => import("@/components/views/BoardView"),
        produce: () => import("@/components/views/ProduceView"),
        review: () => import("@/components/views/ReviewView"),
        layout: () => import("@/components/views/LayoutView"),
        export: () => import("@/components/views/ExportView"),
        settings: () => import("@/components/views/ProjectSettingsView"),
      };
      const mod = await map[view]();
      if (!cancelled) setModule(() => mod.default);
    };
    setModule(null);
    void load();
    return () => {
      cancelled = true;
    };
  }, [view]);

  if (!module) {
    return <Spinner label="در حال بارگذاری بخش…" />;
  }
  const View = module;
  return <View />;
}
