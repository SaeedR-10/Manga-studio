"use strict";

/**
 * کپی سرور standalone به resources برنامه پس از بسته‌بندی.
 * الگوهای files در electron-builder روی extraResources هم اثر می‌گذارند؛
 * این قلاب کپی را کامل و قابل‌بررسی انجام می‌دهد.
 */
const fs = require("node:fs");
const path = require("node:path");

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(abs) : fs.statSync(abs).size;
  }
  return total;
}

function assertNoUserData(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      assertNoUserData(abs);
      continue;
    }
    if (/\.(db|db-wal|db-shm)$/i.test(entry.name)) {
      throw new Error(`فایل دادهٔ کاربر در بستهٔ نصب پیدا شد: ${path.relative(dir, abs)}`);
    }
  }
}

exports.default = async function afterPack(context) {
  const projectDir = context.packager.projectDir;
  const source = path.join(projectDir, "build", "desktop-server");
  const target = path.join(context.appOutDir, "resources", "server");

  if (!fs.existsSync(path.join(source, "server.js"))) {
    throw new Error("build/desktop-server پیدا نشد؛ اول `npm run desktop:prepare` را اجرا کنید.");
  }

  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    throw new Error(`پوشهٔ ${target} در حال استفاده است؛ برنامهٔ در حال اجرا را ببندید.`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });

  for (const required of [
    "server.js",
    path.join(".next", "static"),
    path.join("node_modules", "next"),
    path.join("public", "fonts", "Vazirmatn.woff2"),
  ]) {
    if (!fs.existsSync(path.join(target, required))) throw new Error(`فایل ضروری در بستهٔ نصب نیست: ${required}`);
  }
  assertNoUserData(target);
  console.log(`  • bundled server  ${target} (${(dirSize(target) / (1024 * 1024)).toFixed(1)} MB)`);
};
