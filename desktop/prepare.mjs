/**
 * آماده‌سازی سرور تولیدی برای نسخهٔ دسکتاپ.
 *
 * `next build` با output:"standalone" فقط فایل‌های ضروری سرور را در
 * `.next/standalone` می‌گذارد؛ فایل‌های استاتیک و public باید دستی کنار آن
 * کپی شوند. خروجی در `build/desktop-server` قرار می‌گیرد.
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const nextDir = path.join(root, ".next");
const standalone = path.join(nextDir, "standalone");
const outDir = path.join(root, "build", "desktop-server");
const staticDir = path.join(nextDir, "static");
const publicDir = path.join(root, "public");

function fail(message) {
  console.error(`[prepare] ${message}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(standalone, "server.js"))) fail("`.next/standalone/server.js` پیدا نشد. اول `npm run build` را اجرا کنید.");
if (!fs.existsSync(staticDir)) fail("`.next/static` پیدا نشد. اول `npm run build` را اجرا کنید.");

try {
  fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {
  fail("پوشهٔ build/desktop-server در حال استفاده است؛ برنامهٔ در حال اجرا را ببندید و دوباره تلاش کنید.");
}
fs.mkdirSync(outDir, { recursive: true });

/**
 * ردیاب فایل Next چون مسیرهای ذخیره‌سازی به‌صورت پویا ساخته می‌شوند، گاهی کل
 * ریشهٔ پروژه را داخل standalone کپی می‌کند. این فهرست مانع ورود خروجی‌های ساخت،
 * دادهٔ کاربر و فایل‌های توسعه به بستهٔ نصب می‌شود.
 */
const SKIP_TOP_LEVEL = new Set([
  ".devdata",
  "build",
  "release",
  "data",
  "src",
  "tests",
  "docs",
  "desktop",
  ".git",
  ".freebuff",
  ".next",
]);

function copyFilter(source) {
  if (source === standalone) return true;
  const rel = path.relative(standalone, source);
  const [first, second] = rel.split(path.sep);
  // خودِ .next لازم است؛ فقط آرشیوهای ساخت قبلی کنار گذاشته می‌شوند.
  if (first === ".next") return second === undefined || !/^(cache|standalone|trace)$/.test(second);
  return !SKIP_TOP_LEVEL.has(first);
}

fs.cpSync(standalone, outDir, { recursive: true, filter: copyFilter });

const nested = path.join(outDir, ".next", "standalone", "server.js");
if (!fs.existsSync(path.join(outDir, "server.js")) && fs.existsSync(nested)) {
  const tmp = `${outDir}-tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.renameSync(path.join(outDir, ".next", "standalone"), tmp);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.renameSync(tmp, outDir);
} else if (!fs.existsSync(path.join(outDir, "server.js"))) {
  fail("ساختار خروجی standalone غیرمنتظره است: server.js در ریشهٔ خروجی نیست.");
}

fs.cpSync(staticDir, path.join(outDir, ".next", "static"), { recursive: true });
if (fs.existsSync(publicDir)) fs.cpSync(publicDir, path.join(outDir, "public"), { recursive: true });

// دادهٔ کاربر و خروجی‌های ساخت هرگز نباید داخل بستهٔ نصب برود.
for (const unwanted of [
  "data",
  ".devdata",
  "build",
  "release",
  "src",
  "tests",
  "docs",
  "desktop",
  ".env",
  ".env.local",
  ".env.production",
  "tsconfig.tsbuildinfo",
  "next.config.ts",
]) {
  fs.rmSync(path.join(outDir, unwanted), { recursive: true, force: true });
}
for (const entry of fs.readdirSync(outDir)) {
  if (/\.(db|db-wal|db-shm|log|tsbuildinfo)$/i.test(entry)) fs.rmSync(path.join(outDir, entry), { recursive: true, force: true });
}

const pkg = JSON.parse(fs.readFileSync(path.join(outDir, "package.json"), "utf8"));
fs.writeFileSync(
  path.join(outDir, "package.json"),
  JSON.stringify({ name: pkg.name, version: pkg.version, private: true, dependencies: pkg.dependencies ?? {} }, null, 2),
);

let removedMaps = 0;
function stripMaps(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) stripMaps(abs);
    else if (entry.name.endsWith(".map")) {
      fs.rmSync(abs, { force: true });
      removedMaps++;
    }
  }
}
stripMaps(outDir);

for (const required of ["server.js", path.join(".next", "static"), path.join("public", "fonts", "Vazirmatn.woff2")]) {
  if (!fs.existsSync(path.join(outDir, required))) fail(`فایل ضروری سرور پیدا نشد: ${required}`);
}

function assertNoUserData(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      assertNoUserData(abs);
      continue;
    }
    if (/\.(db|db-wal|db-shm|png|jpg|webp)$/i.test(entry.name) && !abs.includes(`${path.sep}public${path.sep}`)) {
      fail(`فایل دادهٔ کاربر در بستهٔ دسکتاپ پیدا شد: ${path.relative(outDir, abs)}`);
    }
  }
}
assertNoUserData(outDir);

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(abs) : fs.statSync(abs).size;
  }
  return total;
}

const sizeMb = dirSize(outDir) / (1024 * 1024);
fs.writeFileSync(
  path.join(outDir, "desktop-build.json"),
  JSON.stringify({ preparedAt: new Date().toISOString(), sizeMb: Number(sizeMb.toFixed(1)), removedMaps }, null, 2),
);
console.log(`[prepare] سرور دسکتاپ آماده شد: build/desktop-server (${sizeMb.toFixed(1)} مگابایت)`);
