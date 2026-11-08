"use strict";

/**
 * استودیوی روایت — پوستهٔ دسکتاپ ویندوز.
 *
 * سرور Next.js (خروجی standalone) را با خود فایل اجرایی Electron و در حالت
 * Node اجرا می‌کند؛ بنابراین کاربر به Node.js یا npm روی سیستم نیاز ندارد.
 * پنجره فقط به همان سرور محلی (127.0.0.1) دسترسی دارد.
 */

const { app, BrowserWindow, Menu, dialog, session, shell } = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const APP_NAME = "Ravayat Studio";
const APP_DISPLAY_NAME = "استودیوی روایت";
const APP_ID = "ir.ravayat.studio";
const SMOKE = process.argv.includes("--smoke-test") || process.env.RAVAYAT_SMOKE_TEST === "1";
const IS_WINDOWS = process.platform === "win32";
const SERVER_START_TIMEOUT_MS = 120_000;

app.setName(APP_NAME);
app.setAppUserModelId(APP_ID);

let stateRoot;
if (process.env.RAVAYAT_USER_DATA && process.env.RAVAYAT_USER_DATA.trim()) {
  stateRoot = path.resolve(process.env.RAVAYAT_USER_DATA.trim());
} else if (SMOKE) {
  stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ravayat-smoke-"));
} else {
  stateRoot = path.join(app.getPath("appData"), APP_NAME);
}
app.setPath("userData", stateRoot);

const dataDir = process.env.RAVAYAT_DATA_DIR
  ? path.resolve(process.env.RAVAYAT_DATA_DIR)
  : path.join(stateRoot, "data");
const logsDir = path.join(stateRoot, "logs");
const mainLogPath = path.join(logsDir, "main.log");
const serverLogPath = path.join(logsDir, "server.log");
const windowStatePath = path.join(stateRoot, "window-state.json");
fs.mkdirSync(logsDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

let logStream = null;
try {
  const stat = fs.existsSync(mainLogPath) ? fs.statSync(mainLogPath) : null;
  if (stat && stat.size > 2 * 1024 * 1024) fs.renameSync(mainLogPath, `${mainLogPath}.old`);
  logStream = fs.createWriteStream(mainLogPath, { flags: "a" });
} catch {
  logStream = null;
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try {
    logStream?.write(`${line}\n`);
  } catch {
    /* logging must never break the app */
  }
}

const serverDir = app.isPackaged
  ? path.join(process.resourcesPath, "server")
  : path.join(__dirname, "..", "build", "desktop-server");
const iconPath = app.isPackaged
  ? path.join(process.resourcesPath, "icon.ico")
  : path.join(__dirname, "resources", "icon.ico");

let mainWindow = null;
let splashWindow = null;
let serverChild = null;
let serverPort = null;
let serverBaseUrl = null;
let serverExited = false;
let serverStopping = false;
// توکن نشست هر اجرا؛ فقط به موتور برنامه و هدرهای همین پنجره می‌رود.
const sessionToken = crypto.randomBytes(32).toString("hex");
let quitting = false;
const serverTail = [];
let saveStateTimer = null;

function rememberServerLine(line) {
  const text = line.replace(/\s+$/, "");
  if (!text) return;
  serverTail.push(text);
  if (serverTail.length > 80) serverTail.shift();
  try {
    fs.appendFileSync(serverLogPath, `${text}\n`);
  } catch {
    /* ignore */
  }
}

function recentServerOutput() {
  return serverTail.slice(-14).join("\n");
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("پورت آزاد پیدا نشد."))));
    });
  });
}

function childEnv() {
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    HOSTNAME: "127.0.0.1",
    PORT: String(serverPort),
    RAVAYAT_DATA_DIR: dataDir,
    RAVAYAT_DESKTOP_VERSION: app.getVersion(),
    RAVAYAT_SESSION_TOKEN: sessionToken,
    RAVAYAT_APP_ORIGIN: serverBaseUrl,
    NODE_USE_ENV_PROXY: "1",
    NO_PROXY: ["127.0.0.1", "localhost", "::1", process.env.NO_PROXY].filter(Boolean).join(","),
  };
  delete env.ELECTRON_ENABLE_LOGGING;
  return env;
}

function startServer() {
  return new Promise(async (resolve, reject) => {
    if (!fs.existsSync(path.join(serverDir, "server.js"))) {
      reject(new Error(`فایل‌های موتور برنامه پیدا نشد: ${serverDir}`));
      return;
    }
    try {
      serverPort = await getFreePort();
    } catch (error) {
      reject(error);
      return;
    }
    serverBaseUrl = `http://127.0.0.1:${serverPort}`;
    serverExited = false;
    log(`starting server on ${serverBaseUrl} (data: ${dataDir})`);

    const child = spawn(process.execPath, [path.join(serverDir, "server.js")], {
      cwd: serverDir,
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    serverChild = child;

    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => String(chunk).split(/\r?\n/).forEach(rememberServerLine));
    child.stderr.on("data", (chunk) => String(chunk).split(/\r?\n/).forEach(rememberServerLine));
    child.once("error", (error) => fail(new Error(`اجرای موتور برنامه ناموفق بود: ${error.message}`)));
    child.once("exit", (code) => {
      serverExited = true;
      serverChild = null;
      log(`server exited (code=${code})`);
      if (!settled) fail(new Error(`موتور برنامه پیش از آماده‌شدن بسته شد (کد ${code ?? "?"}).`));
      else if (!quitting && !serverStopping) handleServerCrash();
    });

    const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
    const probe = async () => {
      while (!settled && Date.now() < deadline) {
        if (serverExited) {
          fail(new Error("موتور برنامه هنگام راه‌اندازی بسته شد."));
          return;
        }
        try {
          const res = await fetch(`${serverBaseUrl}/api/status`, { signal: AbortSignal.timeout(2500) });
          if (res.ok) {
            settled = true;
            log(`server ready on ${serverBaseUrl}`);
            resolve({ port: serverPort, baseUrl: serverBaseUrl });
            return;
          }
        } catch {
          /* not ready yet */
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!settled) fail(new Error("زمان آماده‌شدن موتور برنامه به پایان رسید."));
    };
    probe();
  });
}

function stopServer() {
  return new Promise((resolve) => {
    const child = serverChild;
    if (!child || serverExited) {
      resolve();
      return;
    }
    serverStopping = true;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      serverChild = null;
      resolve();
    };
    child.once("exit", finish);
    try {
      if (IS_WINDOWS) {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        killer.once("error", () => {
          try {
            child.kill();
          } catch {
            /* ignore */
          }
        });
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish();
    }, 4000);
  });
}

async function showStartupError(error) {
  log(`startup failed: ${error.message}`);
  if (SMOKE) {
    console.error(`SMOKE_FAIL ${JSON.stringify({ error: error.message, server: recentServerOutput() })}`);
    await shutdown(1);
    return;
  }
  const result = await dialog.showMessageBox({
    type: "error",
    title: `${APP_DISPLAY_NAME} اجرا نشد`,
    message: "موتور برنامه بالا نیامد.",
    detail: `${error.message}\n\nفایل‌های لاگ:\n${logsDir}`,
    buttons: ["باز کردن پوشهٔ لاگ", "بستن"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (result.response === 0) await shell.openPath(logsDir);
  await shutdown(1);
}

function loadWindowState() {
  const fallback = { width: 1440, height: 900 };
  try {
    const parsed = JSON.parse(fs.readFileSync(windowStatePath, "utf8"));
    const bounds = parsed && parsed.bounds ? parsed.bounds : parsed;
    if (bounds && Number.isFinite(bounds.width) && Number.isFinite(bounds.height) && bounds.width >= 900 && bounds.height >= 600) {
      return {
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
        x: Number.isFinite(bounds.x) ? Math.round(bounds.x) : undefined,
        y: Number.isFinite(bounds.y) ? Math.round(bounds.y) : undefined,
      };
    }
  } catch {
    /* first run */
  }
  return fallback;
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const maximized = mainWindow.isMaximized();
    fs.writeFileSync(windowStatePath, JSON.stringify({ bounds: maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds(), maximized }, null, 2));
  } catch {
    /* ignore */
  }
}

function scheduleSaveWindowState() {
  clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(saveWindowState, 400);
}

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 460,
    height: 260,
    frame: false,
    resizable: false,
    movable: false,
    show: true,
    backgroundColor: "#f6f5f2",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const html = `<!DOCTYPE html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8"><style>
  html,body{height:100%;margin:0;background:#f6f5f2;color:#24272b;font-family:Segoe UI,Tahoma,sans-serif;overflow:hidden}
  .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;
    border:1px solid #dedbd4;border-radius:14px;box-sizing:border-box;background:linear-gradient(180deg,#fff,#f0efea)}
  .mark{width:52px;height:64px;border:2px solid #3f5a6b;border-radius:6px;position:relative;background:#fff}
  .mark::before{content:"";position:absolute;inset:8px 10px auto;height:2px;background:#3f5a6b;box-shadow:0 10px 0 #3f5a6b,0 20px 0 #b9cbd6}
  h1{font-size:19px;margin:6px 0 0;font-weight:600}
  p{margin:0;font-size:12px;color:#6c7079}
  .dots{display:flex;gap:5px}
  .dots i{width:5px;height:5px;border-radius:50%;background:#3f5a6b;opacity:.3;animation:p 1.1s infinite}
  .dots i:nth-child(2){animation-delay:.15s}.dots i:nth-child(3){animation-delay:.3s}
  @keyframes p{0%,100%{opacity:.25}50%{opacity:1}}
</style></head><body><div class="wrap"><div class="mark"></div><h1>استودیوی روایت</h1><p>در حال آماده‌سازی میزکار محلی…</p><div class="dots"><i></i><i></i><i></i></div></div></body></html>`;
  splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  splashWindow.once("closed", () => {
    splashWindow = null;
  });
}

function createMainWindow(onLoaded) {
  const win = new BrowserWindow({
    ...loadWindowState(),
    minWidth: 1024,
    minHeight: 660,
    show: false,
    backgroundColor: "#f6f5f2",
    title: `${APP_DISPLAY_NAME} — نوشتن رمان و اقتباس مانگا`,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      webSecurity: true,
    },
  });
  mainWindow = win;
  win.once("ready-to-show", () => {
    win.show();
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
  });
  win.on("resize", scheduleSaveWindowState);
  win.on("move", scheduleSaveWindowState);
  win.on("close", saveWindowState);
  win.on("closed", () => {
    mainWindow = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    try {
      if (new URL(url).origin !== serverBaseUrl) {
        event.preventDefault();
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      }
    } catch {
      event.preventDefault();
    }
  });
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  win.webContents.on("render-process-gone", (_event, details) => {
    log(`renderer gone: ${details.reason}`);
    if (!quitting && !SMOKE) {
      const result = dialog.showMessageBoxSync(win, {
        type: "error",
        title: "پنجرهٔ برنامه بسته شد",
        message: "نمایشگر برنامه متوقف شد.",
        detail: "برای ادامه، پنجره را دوباره بارگذاری کنید.",
        buttons: ["بارگذاری دوباره", "بستن برنامه"],
        defaultId: 0,
        cancelId: 1,
      });
      if (result === 0) win.reload();
      else app.quit();
    }
  });
  if (typeof onLoaded === "function") win.webContents.once("did-finish-load", () => onLoaded(win));
  win.loadURL(serverBaseUrl).catch((error) => log(`loadURL failed: ${error.message}`));
  return win;
}

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: "فایل",
      submenu: [
        { label: "باز کردن پوشهٔ داده‌ها", click: () => shell.openPath(dataDir) },
        { label: "پوشهٔ لاگ‌ها", click: () => shell.openPath(logsDir) },
        { type: "separator" },
        { label: "راه‌اندازی دوباره", accelerator: "CmdOrCtrl+Shift+R", click: () => { app.relaunch(); app.quit(); } },
        { type: "separator" },
        { label: "خروج", accelerator: "Alt+F4", role: "quit" },
      ],
    },
    {
      label: "ویرایش",
      submenu: [
        { label: "واگرد", role: "undo" },
        { label: "ازنو", role: "redo" },
        { type: "separator" },
        { label: "برش", role: "cut" },
        { label: "کپی", role: "copy" },
        { label: "چسباندن", role: "paste" },
        { label: "انتخاب همه", role: "selectAll" },
      ],
    },
    {
      label: "نمایش",
      submenu: [
        { label: "بارگذاری دوباره", role: "reload", accelerator: "CmdOrCtrl+R" },
        { type: "separator" },
        { label: "بزرگ‌نمایی", role: "zoomIn" },
        { label: "کوچک‌نمایی", role: "zoomOut" },
        { label: "اندازهٔ عادی", role: "resetZoom" },
        { type: "separator" },
        { label: "تمام‌صفحه", role: "togglefullscreen" },
        ...(app.isPackaged ? [] : [{ type: "separator" }, { label: "ابزار توسعه‌دهنده", role: "toggleDevTools" }]),
      ],
    },
    {
      label: "راهنما",
      submenu: [
        {
          label: `دربارهٔ ${APP_DISPLAY_NAME}`,
          click: () =>
            dialog.showMessageBox({
              type: "info",
              title: `دربارهٔ ${APP_DISPLAY_NAME}`,
              message: `${APP_DISPLAY_NAME} ${app.getVersion()}`,
              detail: [
                "میزکار محلی نوشتن رمان وب و اقتباس آن به پنل مانگا/مانهوا.",
                "",
                `پوشهٔ داده: ${dataDir}`,
                `لاگ‌ها: ${logsDir}`,
                "",
                `Electron ${process.versions.electron} · Node ${process.versions.node} · Chromium ${process.versions.chrome}`,
                "کلیدهای API در Windows Credential Manager نگه‌داری می‌شوند.",
              ].join("\n"),
              buttons: ["بستن"],
              noLink: true,
            }),
        },
      ],
    },
  ]);
}

/**
 * تست دودی نسخهٔ بسته‌بندی‌شده:
 * ساخت پروژهٔ نمونه، بررسی ۱۲ پنل، خروجی Markdown و نبود کلید در داده‌ها.
 * این آزمون هیچ درخواست AI ارسال نمی‌کند.
 */
function apiFetch(pathname, init = {}) {
  return fetch(`${serverBaseUrl}${pathname}`, {
    ...init,
    headers: { ...(init.headers ?? {}), "x-ravayat-session": sessionToken },
  });
}

async function runSmokeTest(win) {
  const result = { ok: false, appVersion: app.getVersion(), electron: process.versions.electron, node: process.versions.node, dataDir, checks: {} };
  try {
    const page = await win.webContents.executeJavaScript(
      `({ title: document.title, dir: document.documentElement.dir, lang: document.documentElement.lang, text: (document.body.innerText||"").slice(0,120) })`,
    );
    result.page = page;
    const statusRes = await fetch(`${serverBaseUrl}/api/status`);
    const status = await statusRes.json();
    result.checks.status = statusRes.ok && status.ok === true;
    result.checks.rtl = page.dir === "rtl";
    result.checks.brand = page.title.includes("روایت");
    const fontRes = await fetch(`${serverBaseUrl}/fonts/Vazirmatn.woff2`);
    result.checks.font = fontRes.status === 200;

    const sampleRes = await apiFetch(`/api/sample`, { method: "POST" });
    const sample = await sampleRes.json();
    result.checks.sampleCreated = sampleRes.status === 201 && Boolean(sample.projectId);
    if (sample.projectId) {
      const panelsRes = await apiFetch(`/api/projects/${sample.projectId}/panels`);
      const panels = await panelsRes.json();
      result.samplePanels = Array.isArray(panels.panels) ? panels.panels.length : 0;
      result.checks.samplePanelsOk = result.samplePanels === 12;
      const mdRes = await apiFetch(`/api/projects/${sample.projectId}/exports`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "markdown" }),
      });
      const md = await mdRes.json();
      result.checks.markdownExport = mdRes.status === 201 && Boolean(md.export?.url);
      if (md.export?.url) {
        const fileRes = await apiFetch(md.export.url);
        const buf = Buffer.from(await fileRes.arrayBuffer());
        result.checks.markdownUtf8 = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf && buf.toString("utf8").includes("آریا");
      }
      const settingsRes = await apiFetch(`/api/settings`);
      const settings = await settingsRes.json();
      result.checks.noKeyValueLeaked = !JSON.stringify(settings).includes("sk-");
      result.checks.secretStore = settings.secrets?.mode ?? null;
      await apiFetch(`/api/projects/${sample.projectId}`, { method: "DELETE" });
    }

    // `secretStore` فقط یک گزارش وضعیت (رشته) است، نه شرط موفقیت.
    result.ok = Object.entries(result.checks).every(([key, value]) => key === "secretStore" || value === true);
    const outPath = process.env.RAVAYAT_SMOKE_OUT ? path.resolve(process.env.RAVAYAT_SMOKE_OUT) : path.join(stateRoot, "smoke.json");
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    if (result.ok) console.log(`SMOKE_OK ${JSON.stringify(result)}`);
    else console.error(`SMOKE_FAIL ${JSON.stringify(result)}`);
    await shutdown(result.ok ? 0 : 1);
  } catch (error) {
    console.error(`SMOKE_FAIL ${JSON.stringify({ error: error.message, server: recentServerOutput() })}`);
    await shutdown(1);
  }
}

function handleServerCrash() {
  if (quitting || SMOKE) return;
  log("server crashed unexpectedly");
  const choice = dialog.showMessageBoxSync(mainWindow ?? undefined, {
    type: "error",
    title: "موتور برنامه متوقف شد",
    message: "ارتباط با موتور داخلی برنامه قطع شد.",
    detail: `جزئیات در فایل لاگ ثبت شد:\n${serverLogPath}\n\n${recentServerOutput()}`,
    buttons: ["راه‌اندازی دوباره", "بستن برنامه"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (choice === 0) {
    app.relaunch();
    app.quit();
  } else {
    app.quit();
  }
}

async function shutdown(code) {
  if (quitting) return;
  quitting = true;
  saveWindowState();
  await stopServer();
  try {
    logStream?.end();
  } catch {
    /* ignore */
  }
  if (SMOKE) {
    process.exitCode = code;
    app.exit(code);
  } else {
    if (code !== 0) process.exitCode = code;
    app.quit();
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.on("before-quit", (event) => {
    if (quitting) return;
    if (serverChild && !serverExited) {
      event.preventDefault();
      shutdown(0);
      return;
    }
    quitting = true;
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverBaseUrl) createMainWindow();
  });

  app.whenReady().then(async () => {
    log(`app ready ${app.getVersion()} (packaged=${app.isPackaged}, smoke=${SMOKE})`);
    Menu.setApplicationMenu(buildMenu());
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      log(`permission denied: ${permission}`);
      callback(false);
    });
    session.defaultSession.on("will-download", (event, item) => {
      if (SMOKE) return;
      const target = dialog.showSaveDialogSync(mainWindow ?? undefined, {
        title: "ذخیرهٔ فایل",
        defaultPath: path.join(app.getPath("downloads"), item.getFilename()),
      });
      if (!target) {
        event.preventDefault();
        return;
      }
      item.setSavePath(target);
    });
    if (!SMOKE) createSplash();
    try {
      await startServer();
      // هر درخواست این نشست به موتور داخلی، توکن نشست را در هدر می‌گیرد؛
      // توکن در صفحه یا localStorage قرار نمی‌گیرد.
      session.defaultSession.webRequest.onBeforeSendHeaders(
        { urls: [`${serverBaseUrl}/*`] },
        (details, callback) => {
          details.requestHeaders["x-ravayat-session"] = sessionToken;
          callback({ requestHeaders: details.requestHeaders });
        },
      );
      createMainWindow(SMOKE ? (win) => void runSmokeTest(win) : undefined);
    } catch (error) {
      await showStartupError(error);
    }
  });
}
