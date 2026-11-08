import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { DatabaseSync } from "node:sqlite";
import { ASSET_DIR, DB_PATH, DATA_DIR, SCHEMA_VERSION, newId, nowIso, row, rows as dbRows, run, sha256, transaction } from "./db";
import { AppError } from "./http";
import { safeName } from "./storage";
import { requireProject } from "./repo/projects";

/**
 * پشتیبان و بستهٔ پروژه.
 *
 * - از `VACUUM INTO` استفاده می‌شود تا فایل زندهٔ SQLite با WAL نیمه‌نوشته کپی
 *   نشود؛ Snapshot یکپارچه است.
 * - بستهٔ پروژه فقط همان پروژه و بستار وابستگی‌هایش را دارد: پروژه‌های دیگر،
 *   متن/تاریخچه/درخواست/تنظیمات خصوصی آن‌ها بیرون می‌مانند. پشتیبان کاملِ کل نصب
 *   عملیاتی جدا با دامنهٔ صریح است (`backupSnapshot`).
 * - تصاویر اصلی (شامل خروجی‌های جایگزین، ماسک‌ها و تصویر بازبینی) داخل بسته
 *   می‌روند تا خروجی در آینده قابل بازسازی باشد.
 * - بازیابی همهٔ تاریخچه را با نگاشت شناسه‌ها برمی‌گرداند و کار واردشده را
 *   هرگز خودکار اجرا نمی‌کند.
 * - کلیدهای API هرگز داخل بسته نیستند (کلیدها در خزانهٔ سیستم‌اند).
 */

export interface PackageManifest {
  app: "ravayat-studio";
  schemaVersion: number;
  exportedAt: string;
  projectId: string;
  projectTitle: string;
  /** دامنهٔ صریح بسته: فقط همین پروژه، یا کل نصب */
  scope: "project" | "installation";
  assets: Array<{ key: string; sha256: string | null; bytes: number }>;
  secretsIncluded: false;
  notes: string;
}

export interface RestoreResult {
  projectId: string;
  title: string;
  assets: number;
  counts: Record<string, number>;
  note: string;
}

function snapshotDatabase(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ravayat-snap-"));
  const target = path.join(dir, "studio.db");
  const db = new DatabaseSync(DB_PATH);
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  return target;
}

/**
 * همهٔ دارایی‌های وابسته به پروژه: مراجع، خروجی‌های پذیرفته‌شده و نامزدها،
 * ماسک‌های اصلاح، تصویر بازبینی و خروجی‌های تولیدشده. تصویری که فقط در یک
 * take جایگزین/تاریخی یا ماسک آمده باشد نیز داخل بسته می‌رود.
 */
export const PROJECT_ASSET_CLOSURE_SQL = `SELECT id FROM assets WHERE id IN (
    SELECT asset_id FROM reference_assets WHERE project_id = ?
    UNION SELECT image_asset_id FROM panels WHERE project_id = ? AND image_asset_id IS NOT NULL
    UNION SELECT asset_id FROM image_takes WHERE panel_id IN (SELECT id FROM panels WHERE project_id = ?)
    UNION SELECT mask_asset_id FROM image_takes WHERE panel_id IN (SELECT id FROM panels WHERE project_id = ?) AND mask_asset_id IS NOT NULL
    UNION SELECT image_asset_id FROM review_reports WHERE panel_id IN (SELECT id FROM panels WHERE project_id = ?) AND image_asset_id IS NOT NULL
    UNION SELECT asset_id FROM exports WHERE project_id = ? AND asset_id IS NOT NULL
  )`;

const CLOSURE_PARAMS = (projectId: string) => [projectId, projectId, projectId, projectId, projectId, projectId] as const;

export function projectAssetIds(projectId: string): string[] {
  return dbRows(PROJECT_ASSET_CLOSURE_SQL, ...CLOSURE_PARAMS(projectId)).map((r) => String(r.id));
}

export function projectAssetKeys(projectId: string): string[] {
  const keys = new Set<string>();
  for (const r of dbRows(`SELECT * FROM assets WHERE id IN (${PROJECT_ASSET_CLOSURE_SQL})`, ...CLOSURE_PARAMS(projectId))) {
    if (r.storage_key) keys.add(String(r.storage_key));
    if (r.thumb_key) keys.add(String(r.thumb_key));
  }
  return [...keys];
}

/**
 * پایگاه دادهٔ snapshot را به «فقط همین پروژه» محدود می‌کند.
 *
 * پیش از این، کل پایگاه دادهٔ مشترک داخل بسته می‌رفت و پروژه‌های دیگر هم لو
 * می‌رفتند. حالا نسخهٔ موقت حذف و VACUUM می‌شود تا صفحه‌های آزاد هم پاک شوند.
 * پایگاه دادهٔ زنده هرگز دست‌کاری نمی‌شود.
 */
function scopeSnapshotToProject(dbPath: string, projectId: string): void {
  const db = new DatabaseSync(dbPath);
  const stmts = [
    "DELETE FROM works WHERE project_id <> ?",
    "DELETE FROM adaptations WHERE project_id <> ?",
    "DELETE FROM chapters WHERE project_id <> ?",
    "DELETE FROM scenes WHERE project_id <> ?",
    "DELETE FROM scene_versions WHERE scene_id NOT IN (SELECT id FROM scenes)",
    "DELETE FROM entities WHERE project_id <> ?",
    "DELETE FROM entity_versions WHERE entity_id NOT IN (SELECT id FROM entities)",
    "DELETE FROM entity_relations WHERE project_id <> ?",
    "DELETE FROM facts WHERE project_id <> ?",
    "DELETE FROM character_knowledge WHERE project_id <> ?",
    "DELETE FROM scene_state WHERE scene_id NOT IN (SELECT id FROM scenes)",
    "DELETE FROM timeline_events WHERE project_id <> ?",
    "DELETE FROM style_profiles WHERE project_id <> ?",
    "DELETE FROM reference_assets WHERE project_id <> ?",
    "DELETE FROM panels WHERE project_id <> ?",
    "DELETE FROM panel_versions WHERE panel_id NOT IN (SELECT id FROM panels)",
    "DELETE FROM ai_requests WHERE project_id <> ?",
    "DELETE FROM ai_attempts WHERE request_id NOT IN (SELECT id FROM ai_requests)",
    "DELETE FROM image_takes WHERE panel_id NOT IN (SELECT id FROM panels)",
    "DELETE FROM review_reports WHERE panel_id NOT IN (SELECT id FROM panels)",
    "DELETE FROM review_issues WHERE report_id NOT IN (SELECT id FROM review_reports)",
    "DELETE FROM pagination_docs WHERE project_id <> ?",
    "DELETE FROM panel_placements WHERE doc_id NOT IN (SELECT id FROM pagination_docs)",
    "DELETE FROM text_layers WHERE doc_id NOT IN (SELECT id FROM pagination_docs)",
    "DELETE FROM jobs WHERE project_id <> ?",
    "DELETE FROM exports WHERE project_id <> ?",
    "DELETE FROM backups",
    "DELETE FROM settings",
    "DELETE FROM ai_prompts",
    "DELETE FROM cost_rates",
    `DELETE FROM assets WHERE id NOT IN (${PROJECT_ASSET_CLOSURE_SQL})`,
    "DELETE FROM projects WHERE id <> ?",
  ];
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    for (const sql of stmts) {
      const params = Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => projectId);
      db.prepare(sql).run(...(params as never[]));
    }
    // پاک‌سازی صفحه‌های آزاد تا دادهٔ حذف‌شده در فایل باقی نماند.
    db.exec("VACUUM");
    const leaked = db.prepare("SELECT COUNT(*) AS c FROM projects WHERE id <> ?").get(projectId) as { c: number };
    if (Number(leaked.c) !== 0) throw new AppError("محدودسازی بستهٔ پروژه ناتمام ماند.", 500, "scope_failed");
    const requestLeak = db.prepare("SELECT COUNT(*) AS c FROM ai_requests WHERE project_id <> ?").get(projectId) as { c: number };
    if (Number(requestLeak.c) !== 0) throw new AppError("درخواست‌های پروژهٔ دیگر در بسته ماند.", 500, "scope_failed");
  } finally {
    db.close();
  }
}

export async function createProjectPackage(projectId: string): Promise<{ buffer: Buffer; manifest: PackageManifest }> {
  const project = requireProject(projectId);
  const snapshot = snapshotDatabase();
  try {
    scopeSnapshotToProject(snapshot, projectId);
    const zip = new JSZip();
    zip.file("studio.db", fs.readFileSync(snapshot));
    const manifest: PackageManifest = {
      app: "ravayat-studio",
      schemaVersion: SCHEMA_VERSION,
      exportedAt: nowIso(),
      projectId,
      projectTitle: project.title,
      scope: "project",
      assets: [],
      secretsIncluded: false,
      notes:
        "دامنه: فقط همین پروژه با متن، نسخه‌ها، تاریخچهٔ درخواست، خروجی‌ها، بازبینی‌ها و صفحه‌بندی. پروژه‌های دیگر، تنظیمات خصوصی برنامه و کلیدهای API در بسته نیستند.",
    };
    const root = path.resolve(path.dirname(ASSET_DIR));
    for (const key of projectAssetKeys(projectId)) {
      const abs = path.resolve(root, key);
      if (!abs.startsWith(root + path.sep)) {
        throw new AppError("مسیر دارایی نامعتبر است.", 500, "invalid_asset_key");
      }
      if (!fs.existsSync(abs)) {
        throw new AppError(
          `فایل تصویر «${key}» روی دیسک نیست؛ بستهٔ ناقص ساخته نمی‌شود.`,
          409,
          "asset_file_missing",
          "تصویر گم‌شده را برگردانید یا مرجع/خروجی وابسته را حذف کنید.",
        );
      }
      const data = fs.readFileSync(abs);
      zip.file(`files/${key}`, data);
      manifest.assets.push({ key, sha256: sha256(data), bytes: data.byteLength });
    }
    zip.file("manifest.json", JSON.stringify(manifest, null, 2));
    zip.file(
      "README.txt",
      [
        "بستهٔ پروژهٔ استودیوی روایت",
        `پروژه: ${project.title}`,
        `تاریخ: ${manifest.exportedAt}`,
        `دامنه: فقط این پروژه (${manifest.assets.length} فایل تصویری)`,
        "",
        "این بسته شامل متن، نسخه‌ها، تاریخچهٔ درخواست‌ها، خروجی‌ها و تصاویر اصلی همین پروژه است.",
        "پروژه‌های دیگر و تنظیمات خصوصی برنامه در بسته نیستند.",
        "کلیدهای API در بسته نیستند؛ پس از بازیابی باید دوباره در تنظیمات اتصال‌ها وارد شوند.",
      ].join("\r\n"),
    );
    const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
    return { buffer, manifest };
  } finally {
    fs.rmSync(path.dirname(snapshot), { recursive: true, force: true });
  }
}

function safeEntryName(name: string): string {
  const normalized = name.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new AppError(`مسیر مطلق در بسته مجاز نیست: ${name}`, 400, "unsafe_entry");
  }
  const parts = normalized.split("/");
  if (parts.some((p) => p === "..")) {
    throw new AppError(`مسیر خروج از پوشه در بسته پیدا شد: ${name}`, 400, "unsafe_entry");
  }
  return normalized;
}

/** بازبینی کامل بسته پیش از نوشتن چیزی: manifest، هش فایل‌ها و پوشش دارایی‌ها. */
async function verifyPackage(zip: JSZip, manifest: PackageManifest, source: DatabaseSync): Promise<Map<string, Buffer>> {
  const buffers = new Map<string, Buffer>();
  const declared = new Set<string>();
  for (const entry of manifest.assets) {
    safeEntryName(`files/${entry.key}`);
    const file = zip.file(`files/${entry.key}`);
    if (!file) {
      throw new AppError(
        `فایل «${entry.key}» که manifest وعده داده در بسته نیست؛ بستهٔ ناقص پذیرفته نمی‌شود.`,
        400,
        "asset_missing_in_package",
      );
    }
    const data = Buffer.from(await file.async("nodebuffer"));
    if (entry.sha256 && sha256(data) !== entry.sha256) {
      throw new AppError(`هش تصویر با manifest نمی‌خواند: ${entry.key}`, 400, "asset_hash_mismatch");
    }
    if (entry.bytes && data.byteLength !== entry.bytes) {
      throw new AppError(`حجم تصویر با manifest نمی‌خواند: ${entry.key}`, 400, "asset_size_mismatch");
    }
    buffers.set(entry.key, data);
    declared.add(entry.key);
  }

  // هر داراییِ موردنیاز پایگاه داده باید در بسته باشد (یا از قبل روی دیسک با همان کلید).
  const required = source
    .prepare(`SELECT storage_key, thumb_key FROM assets WHERE id IN (${PROJECT_ASSET_CLOSURE_SQL})`)
    .all(...(CLOSURE_PARAMS(manifest.projectId) as unknown as never[])) as Array<{ storage_key: string; thumb_key: string | null }>;
  const root = path.resolve(path.dirname(ASSET_DIR));
  const missing: string[] = [];
  for (const asset of required) {
    for (const key of [asset.storage_key, asset.thumb_key]) {
      if (!key) continue;
      if (declared.has(key)) continue;
      const abs = path.resolve(root, key);
      if (abs.startsWith(root + path.sep) && fs.existsSync(abs)) continue;
      missing.push(key);
    }
  }
  if (missing.length) {
    throw new AppError(
      `بستهٔ ناقص است: ${missing.length} فایل تصویری لازم در آن نیست.`,
      400,
      "incomplete_package",
      missing.slice(0, 5).join("، "),
    );
  }
  return buffers;
}

export async function restorePackage(buffer: Buffer): Promise<RestoreResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new AppError("فایل بسته خوانده نشد یا ZIP معتبر نیست.", 400, "invalid_package");
  }
  for (const name of Object.keys(zip.files)) safeEntryName(name);
  const manifestFile = zip.file("manifest.json");
  const dbFile = zip.file("studio.db");
  if (!manifestFile || !dbFile) throw new AppError("بستهٔ پروژه فاقد manifest.json یا studio.db است.", 400, "invalid_package");
  let manifest: PackageManifest;
  try {
    manifest = JSON.parse(await manifestFile.async("string")) as PackageManifest;
  } catch {
    throw new AppError("manifest.json خوانده نشد.", 400, "invalid_package");
  }
  if (manifest.app !== "ravayat-studio") throw new AppError("این بسته متعلق به استودیوی روایت نیست.", 400, "wrong_app");
  if (typeof manifest.schemaVersion !== "number" || manifest.schemaVersion > SCHEMA_VERSION) {
    throw new AppError("این بسته با نسخهٔ جدیدتری از برنامه ساخته شده است.", 400, "newer_schema");
  }
  if (!Array.isArray(manifest.assets)) throw new AppError("فهرست دارایی‌های بسته معتبر نیست.", 400, "invalid_package");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ravayat-restore-"));
  try {
    const dbPath = path.join(dir, "studio.db");
    fs.writeFileSync(dbPath, Buffer.from(await dbFile.async("nodebuffer")));
    const source = new DatabaseSync(dbPath, { readOnly: true } as never);
    try {
      const projectRow = source.prepare("SELECT id FROM projects WHERE id = ?").get(manifest.projectId) as { id?: string } | undefined;
      if (!projectRow) throw new AppError("پروژهٔ داخل بسته پیدا نشد.", 400, "project_missing_in_package");
      const files = await verifyPackage(zip, manifest, source);

      // نوشتن فایل‌ها پس از بازبینی کامل؛ محتوای یکسان روی دیسک دست نمی‌خورد.
      const root = path.resolve(path.dirname(ASSET_DIR));
      for (const [key, data] of files) {
        const abs = path.resolve(root, key);
        if (!abs.startsWith(root + path.sep)) throw new AppError("مسیر دارایی نامعتبر است.", 400, "unsafe_entry");
        if (!fs.existsSync(abs)) {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, data);
        }
      }

      const result = importProjectFrom(source, manifest.projectId);
      const integrity = verifyRestoredIntegrity(result.projectId);
      if (integrity.problems.length) {
        throw new AppError(
          "بازیابی با نقص ارجاع متوقف شد.",
          400,
          "restore_integrity_failed",
          integrity.problems.join(" · "),
        );
      }
      return {
        ...result,
        note:
          manifest.scope === "installation"
            ? "این بسته از پشتیبان کامل نصب بود؛ فقط پروژهٔ انتخاب‌شده بازیابی شد."
            : "بازیابی کامل انجام شد. کارهای نیمه‌کاره به‌صورت تاریخچه/نامشخص وارد شدند و خودکار اجرا نمی‌شوند.",
      };
    } finally {
      source.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** بررسی ارجاع‌ها پس از بازیابی؛ بستهٔ ناسالم نباید بی‌صدا نیمه‌کاره بماند. */
export function verifyRestoredIntegrity(projectId: string): { problems: string[]; counts: Record<string, number> } {
  const problems: string[] = [];
  const count = (sql: string, ...params: unknown[]) => Number(row(sql, ...params)?.c ?? 0);
  const checks: Array<[string, string]> = [
    ["panels بدون صحنه", "SELECT COUNT(*) AS c FROM panels p LEFT JOIN scenes s ON s.id = p.scene_id WHERE p.project_id = ? AND s.id IS NULL"],
    ["پنل بدون اقتباس", "SELECT COUNT(*) AS c FROM panels p LEFT JOIN adaptations a ON a.id = p.adaptation_id WHERE p.project_id = ? AND a.id IS NULL"],
    ["خروجی بدون پنل", "SELECT COUNT(*) AS c FROM image_takes t LEFT JOIN panels p ON p.id = t.panel_id WHERE t.panel_id IN (SELECT id FROM panels WHERE project_id = ?) AND p.id IS NULL"],
    ["خروجی بدون فایل", "SELECT COUNT(*) AS c FROM image_takes t LEFT JOIN assets a ON a.id = t.asset_id WHERE t.panel_id IN (SELECT id FROM panels WHERE project_id = ?) AND a.id IS NULL"],
    ["پنل با خروجی ناموجود", "SELECT COUNT(*) AS c FROM panels p LEFT JOIN image_takes t ON t.id = p.current_take_id WHERE p.project_id = ? AND p.current_take_id IS NOT NULL AND t.id IS NULL"],
    ["نسخهٔ متن ناموجود", "SELECT COUNT(*) AS c FROM scenes s LEFT JOIN scene_versions v ON v.id = s.current_version_id WHERE s.project_id = ? AND s.current_version_id IS NOT NULL AND v.id IS NULL"],
    ["درخواست بدون پنل", "SELECT COUNT(*) AS c FROM ai_requests r LEFT JOIN panels p ON p.id = r.panel_id WHERE r.project_id = ? AND r.panel_id IS NOT NULL AND p.id IS NULL"],
    ["بازبینی بدون درخواست", "SELECT COUNT(*) AS c FROM review_reports rr LEFT JOIN ai_requests r ON r.id = rr.request_id WHERE rr.panel_id IN (SELECT id FROM panels WHERE project_id = ?) AND rr.request_id IS NOT NULL AND r.id IS NULL"],
    ["جای‌گذاری بدون پنل", "SELECT COUNT(*) AS c FROM panel_placements pl LEFT JOIN panels p ON p.id = pl.panel_id WHERE pl.doc_id IN (SELECT id FROM pagination_docs WHERE project_id = ?) AND p.id IS NULL"],
    ["لایهٔ متنی بدون جای‌گذاری", "SELECT COUNT(*) AS c FROM text_layers tl LEFT JOIN panel_placements pl ON pl.id = tl.placement_id WHERE tl.doc_id IN (SELECT id FROM pagination_docs WHERE project_id = ?) AND tl.placement_id IS NOT NULL AND pl.id IS NULL"],
  ];
  for (const [label, sql] of checks) {
    const n = count(sql, projectId);
    if (n > 0) problems.push(`${label}: ${n}`);
  }
  const counts = {
    scenes: count("SELECT COUNT(*) AS c FROM scenes WHERE project_id = ?", projectId),
    sceneVersions: count("SELECT COUNT(*) AS c FROM scene_versions WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)", projectId),
    entities: count("SELECT COUNT(*) AS c FROM entities WHERE project_id = ?", projectId),
    references: count("SELECT COUNT(*) AS c FROM reference_assets WHERE project_id = ?", projectId),
    panels: count("SELECT COUNT(*) AS c FROM panels WHERE project_id = ?", projectId),
    takes: count("SELECT COUNT(*) AS c FROM image_takes WHERE panel_id IN (SELECT id FROM panels WHERE project_id = ?)", projectId),
    requests: count("SELECT COUNT(*) AS c FROM ai_requests WHERE project_id = ?", projectId),
    reviews: count("SELECT COUNT(*) AS c FROM review_reports WHERE panel_id IN (SELECT id FROM panels WHERE project_id = ?)", projectId),
    placements: count("SELECT COUNT(*) AS c FROM panel_placements WHERE doc_id IN (SELECT id FROM pagination_docs WHERE project_id = ?)", projectId),
    textLayers: count("SELECT COUNT(*) AS c FROM text_layers WHERE doc_id IN (SELECT id FROM pagination_docs WHERE project_id = ?)", projectId),
  };
  return { problems, counts };
}

function parseArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]")) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * بازیابی کامل یک پروژه از پایگاه دادهٔ بسته، با شناسه‌های تازه.
 *
 * - متن، نسخه‌ها و اشاره‌گر نسخهٔ جاری
 * - موجودیت‌ها، نسخه‌های هویت/لباس، واقعیت‌ها، دانش شخصیت‌ها، وضعیت صحنه، خط زمان
 * - مراجع با بازهٔ اعتبار و supersedes
 * - اقتباس/پنل با نسخهٔ منبع، تاریخچهٔ پنل، همهٔ خروجی‌ها (پذیرفته/جایگزین/رد‌شده)
 * - درخواست‌ها، تلاش‌ها، پارس پاسخ، بازبینی‌ها با تصمیم‌ها
 * - سند صفحه‌بندی، جای‌گذاری‌ها و لایه‌های متن با اشاره‌گر جای‌گذاری
 * کارهای واردشده هرگز خودکار اجرا نمی‌شوند.
 */
function importProjectFrom(source: DatabaseSync, sourceProjectId: string): Omit<RestoreResult, "note"> {
  const all = <T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] =>
    source.prepare(sql).all(...(params as never[])) as T[];
  const one = <T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined =>
    source.prepare(sql).get(...(params as never[])) as T | undefined;

  const project = one("SELECT * FROM projects WHERE id = ?", sourceProjectId);
  if (!project) throw new AppError("پروژهٔ داخل بسته پیدا نشد.", 400, "project_missing_in_package");

  const title = `${String(project.title)} (بازیابی ${new Date().toLocaleDateString("fa-IR")})`;
  const newProjectId = newId();
  const now = nowIso();
  const maps = {
    assets: new Map<string, string>(),
    works: new Map<string, string>(),
    adaptations: new Map<string, string>(),
    chapters: new Map<string, string>(),
    scenes: new Map<string, string>(),
    sceneVersions: new Map<string, string>(),
    entities: new Map<string, string>(),
    facts: new Map<string, string>(),
    styles: new Map<string, string>(),
    refs: new Map<string, string>(),
    panels: new Map<string, string>(),
    docs: new Map<string, string>(),
    placements: new Map<string, string>(),
    requests: new Map<string, string>(),
    takes: new Map<string, string>(),
    reports: new Map<string, string>(),
  };

  const idOf = (map: Map<string, string>, old: unknown): string | null => {
    if (old == null || old === "") return null;
    return map.get(String(old)) ?? null;
  };
  const remapList = (list: string[], map: Map<string, string>): string[] => list.map((id) => map.get(id) ?? "").filter(Boolean);
  const remapSnapshot = (snapshot: Record<string, unknown>): Record<string, unknown> => {
    const next: Record<string, unknown> = { ...snapshot };
    if (Array.isArray(snapshot.attachments)) {
      next.attachments = (snapshot.attachments as Array<Record<string, unknown>>).map((entry) => ({
        ...entry,
        referenceId: idOf(maps.refs, entry.referenceId),
        assetId: idOf(maps.assets, entry.assetId),
      }));
    }
    next.requestId = idOf(maps.requests, snapshot.requestId);
    return next;
  };

  const expected = {
    sceneVersions: Number(
      one("SELECT COUNT(*) AS c FROM scene_versions WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)", sourceProjectId)?.c ?? 0,
    ),
    panels: Number(one("SELECT COUNT(*) AS c FROM panels WHERE project_id = ?", sourceProjectId)?.c ?? 0),
    takes: Number(
      one("SELECT COUNT(*) AS c FROM image_takes WHERE panel_id IN (SELECT id FROM panels WHERE project_id = ?)", sourceProjectId)?.c ?? 0,
    ),
    requests: Number(one("SELECT COUNT(*) AS c FROM ai_requests WHERE project_id = ?", sourceProjectId)?.c ?? 0),
    reviews: Number(
      one("SELECT COUNT(*) AS c FROM review_reports WHERE panel_id IN (SELECT id FROM panels WHERE project_id = ?)", sourceProjectId)?.c ?? 0,
    ),
    placements: Number(
      one("SELECT COUNT(*) AS c FROM panel_placements WHERE doc_id IN (SELECT id FROM pagination_docs WHERE project_id = ?)", sourceProjectId)?.c ?? 0,
    ),
    textLayers: Number(
      one("SELECT COUNT(*) AS c FROM text_layers WHERE doc_id IN (SELECT id FROM pagination_docs WHERE project_id = ?)", sourceProjectId)?.c ?? 0,
    ),
  };

  const pendingRequestInputs: Array<{ requestId: string; inputs: Record<string, unknown> }> = [];

  transaction(() => {
    run(
      `INSERT INTO projects (id, title, subtitle, description, language, publish_format, settings, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newProjectId,
      title,
      String(project.subtitle ?? ""),
      String(project.description ?? ""),
      String(project.language ?? "fa"),
      String(project.publish_format ?? "vertical"),
      String(project.settings ?? "{}"),
      String(project.created_at ?? now),
      now,
    );

    // ---- دارایی‌ها: بایت یکسان به رکورد موجود وصل می‌شود (اشتراک ایمن فایل).
    for (const a of all(`SELECT * FROM assets WHERE id IN (${PROJECT_ASSET_CLOSURE_SQL})`, ...CLOSURE_PARAMS(sourceProjectId))) {
      const hash = String(a.sha256);
      const existing = row("SELECT * FROM assets WHERE sha256 = ? LIMIT 1", hash);
      if (existing) {
        maps.assets.set(String(a.id), String(existing.id));
        continue;
      }
      const id = newId();
      maps.assets.set(String(a.id), id);
      run(
        `INSERT INTO assets (id, storage_key, thumb_key, filename, mime, bytes, width, height, sha256, kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        String(a.storage_key),
        a.thumb_key ? String(a.thumb_key) : null,
        String(a.filename),
        String(a.mime),
        Number(a.bytes),
        a.width == null ? null : Number(a.width),
        a.height == null ? null : Number(a.height),
        hash,
        String(a.kind ?? "image"),
        String(a.created_at ?? now),
      );
    }

    // ---- اثر و اقتباس
    for (const w of all("SELECT * FROM works WHERE project_id = ?", sourceProjectId)) {
      const id = newId();
      maps.works.set(String(w.id), id);
      run(
        `INSERT INTO works (id, project_id, title, genre, synopsis, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id,
        newProjectId,
        String(w.title),
        String(w.genre ?? ""),
        String(w.synopsis ?? ""),
        String(w.created_at ?? now),
        String(w.updated_at ?? now),
      );
    }
    for (const a of all("SELECT * FROM adaptations WHERE project_id = ?", sourceProjectId)) {
      const newWork = idOf(maps.works, a.work_id);
      if (!newWork) continue;
      const id = newId();
      maps.adaptations.set(String(a.id), id);
      run(
        `INSERT INTO adaptations (id, project_id, work_id, title, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id,
        newProjectId,
        newWork,
        String(a.title),
        String(a.notes ?? ""),
        String(a.created_at ?? now),
        String(a.updated_at ?? now),
      );
    }

    // ---- فصل و صحنه (متن و اشاره‌گر نسخه در پایان همین بخش)
    for (const c of all("SELECT * FROM chapters WHERE project_id = ? ORDER BY position", sourceProjectId)) {
      const id = newId();
      maps.chapters.set(String(c.id), id);
      run(
        `INSERT INTO chapters (id, project_id, position, title, summary, story_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        newProjectId,
        Number(c.position),
        String(c.title),
        String(c.summary ?? ""),
        c.story_date ? String(c.story_date) : null,
        String(c.created_at ?? now),
        String(c.updated_at ?? now),
      );
    }
    for (const s of all("SELECT * FROM scenes WHERE project_id = ?", sourceProjectId)) {
      const chapterId = idOf(maps.chapters, s.chapter_id);
      if (!chapterId) continue;
      const id = newId();
      maps.scenes.set(String(s.id), id);
      run(
        `INSERT INTO scenes (id, project_id, chapter_id, position, title, text, objective, status, story_date, is_flashback, word_count, current_version_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        id,
        newProjectId,
        chapterId,
        Number(s.position),
        String(s.title),
        String(s.text ?? ""),
        String(s.objective ?? ""),
        String(s.status ?? "draft"),
        s.story_date ? String(s.story_date) : null,
        Number(s.is_flashback ?? 0),
        Number(s.word_count ?? 0),
        String(s.created_at ?? now),
        String(s.updated_at ?? now),
      );
    }
    for (const v of all(
      "SELECT * FROM scene_versions WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?) ORDER BY version",
      sourceProjectId,
    )) {
      const sceneId = idOf(maps.scenes, v.scene_id);
      if (!sceneId) continue;
      const id = newId();
      maps.sceneVersions.set(String(v.id), id);
      run(
        `INSERT INTO scene_versions (id, scene_id, version, text, hash, word_count, reason, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        sceneId,
        Number(v.version),
        String(v.text),
        String(v.hash),
        Number(v.word_count ?? 0),
        String(v.reason ?? "restore"),
        String(v.meta ?? "{}"),
        String(v.created_at ?? now),
      );
    }
    // اشاره‌گر نسخهٔ جاری حفظ می‌شود (پیش‌تر صفر می‌شد).
    for (const s of all("SELECT id, current_version_id FROM scenes WHERE project_id = ?", sourceProjectId)) {
      const sceneId = idOf(maps.scenes, s.id);
      const versionId = idOf(maps.sceneVersions, s.current_version_id);
      if (sceneId && versionId) run("UPDATE scenes SET current_version_id = ? WHERE id = ?", versionId, sceneId);
    }

    // ---- جهان داستان
    for (const e of all("SELECT * FROM entities WHERE project_id = ?", sourceProjectId)) {
      const id = newId();
      maps.entities.set(String(e.id), id);
      run(
        `INSERT INTO entities (id, project_id, kind, name, summary, details, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        newProjectId,
        String(e.kind),
        String(e.name),
        String(e.summary ?? ""),
        String(e.details ?? "{}"),
        String(e.created_at ?? now),
        String(e.updated_at ?? now),
      );
    }
    for (const v of all(
      "SELECT * FROM entity_versions WHERE entity_id IN (SELECT id FROM entities WHERE project_id = ?) ORDER BY version",
      sourceProjectId,
    )) {
      const entityId = idOf(maps.entities, v.entity_id);
      if (!entityId) continue;
      run(
        `INSERT INTO entity_versions (id, entity_id, version, label, layer, payload, fixed_traits, valid_from, valid_to, notes, created_at, approved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(),
        entityId,
        Number(v.version),
        String(v.label ?? ""),
        String(v.layer ?? "identity"),
        String(v.payload ?? "{}"),
        Number(v.fixed_traits ?? 0),
        v.valid_from ? String(v.valid_from) : null,
        v.valid_to ? String(v.valid_to) : null,
        String(v.notes ?? ""),
        String(v.created_at ?? now),
        v.approved_at ? String(v.approved_at) : null,
      );
    }
    for (const rel of all("SELECT * FROM entity_relations WHERE project_id = ?", sourceProjectId)) {
      const from = idOf(maps.entities, rel.from_entity_id);
      const to = idOf(maps.entities, rel.to_entity_id);
      if (!from || !to) continue;
      run(
        "INSERT INTO entity_relations (id, project_id, from_entity_id, to_entity_id, kind, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        newId(),
        newProjectId,
        from,
        to,
        String(rel.kind),
        String(rel.note ?? ""),
        String(rel.created_at ?? now),
      );
    }
    for (const f of all("SELECT * FROM facts WHERE project_id = ?", sourceProjectId)) {
      const subject = f.subject_type === "project" ? "" : idOf(maps.entities, f.subject_id) ?? "";
      const id = newId();
      maps.facts.set(String(f.id), id);
      run(
        `INSERT INTO facts (id, project_id, subject_type, subject_id, attribute, value, source_type, source_ref, status, scope_start, scope_end, conflict_group, resolution_note, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        newProjectId,
        String(f.subject_type ?? "entity"),
        subject,
        String(f.attribute),
        String(f.value),
        String(f.source_type),
        String(f.source_ref ?? ""),
        String(f.status),
        f.scope_start ? String(f.scope_start) : null,
        f.scope_end ? String(f.scope_end) : null,
        f.conflict_group ? String(f.conflict_group) : null,
        String(f.resolution_note ?? ""),
        String(f.created_by ?? "user"),
        String(f.created_at ?? now),
        String(f.updated_at ?? now),
      );
    }
    for (const k of all("SELECT * FROM character_knowledge WHERE project_id = ?", sourceProjectId)) {
      const characterId = idOf(maps.entities, k.character_id);
      if (!characterId) continue;
      run(
        `INSERT INTO character_knowledge (id, project_id, character_id, fact_id, knowledge, reveal_scene_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(),
        newProjectId,
        characterId,
        idOf(maps.facts, k.fact_id),
        String(k.knowledge ?? "knows"),
        idOf(maps.scenes, k.reveal_scene_id),
        String(k.note ?? ""),
        String(k.created_at ?? now),
      );
    }
    for (const s of all("SELECT * FROM scene_state WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)", sourceProjectId)) {
      const sceneId = idOf(maps.scenes, s.scene_id);
      if (!sceneId) continue;
      run(
        `INSERT INTO scene_state (id, scene_id, location_id, present_entities, overrides, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        newId(),
        sceneId,
        idOf(maps.entities, s.location_id),
        JSON.stringify(remapList(parseArray(s.present_entities), maps.entities)),
        String(s.overrides ?? "{}"),
        String(s.updated_at ?? now),
      );
    }
    for (const t of all("SELECT * FROM timeline_events WHERE project_id = ?", sourceProjectId)) {
      run(
        `INSERT INTO timeline_events (id, project_id, scene_id, label, story_date, kind, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(),
        newProjectId,
        idOf(maps.scenes, t.scene_id),
        String(t.label),
        t.story_date ? String(t.story_date) : null,
        String(t.kind ?? "event"),
        String(t.note ?? ""),
        String(t.created_at ?? now),
      );
    }
    for (const st of all("SELECT * FROM style_profiles WHERE project_id = ?", sourceProjectId)) {
      const id = newId();
      maps.styles.set(String(st.id), id);
      run(
        `INSERT INTO style_profiles (id, project_id, name, description, palette, linework, notes, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        newProjectId,
        String(st.name),
        String(st.description ?? ""),
        String(st.palette ?? ""),
        String(st.linework ?? ""),
        String(st.notes ?? ""),
        Number(st.is_default ?? 0),
        String(st.created_at ?? now),
        String(st.updated_at ?? now),
      );
    }

    // ---- مراجع (نسخهٔ تأییدشده، بازهٔ اعتبار و زنجیرهٔ supersedes حفظ می‌شود)
    for (const r of all("SELECT * FROM reference_assets WHERE project_id = ? ORDER BY version", sourceProjectId)) {
      const assetId = idOf(maps.assets, r.asset_id);
      if (!assetId) throw new AppError("مرجع بدون فایل تصویری در بسته است.", 400, "reference_asset_missing");
      const id = newId();
      maps.refs.set(String(r.id), id);
      run(
        `INSERT INTO reference_assets (id, project_id, asset_id, title, description, origin, license_note, status, version, supersedes_id, entities, roles, tags, approved_at, valid_from, valid_to, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        newProjectId,
        assetId,
        String(r.title),
        String(r.description ?? ""),
        String(r.origin ?? "imported"),
        String(r.license_note ?? ""),
        String(r.status ?? "draft"),
        Number(r.version ?? 1),
        // zنجیره در گذر دوم وصل می‌شود (نسخهٔ قبلی ممکن است بعداً بیاید).
        null,
        JSON.stringify(remapList(parseArray(r.entities), maps.entities)),
        String(r.roles ?? "[]"),
        String(r.tags ?? "[]"),
        r.approved_at ? String(r.approved_at) : null,
        r.valid_from ? String(r.valid_from) : null,
        r.valid_to ? String(r.valid_to) : null,
        String(r.created_at ?? now),
        String(r.updated_at ?? now),
      );
    }
    for (const r of all("SELECT id, supersedes_id FROM reference_assets WHERE project_id = ?", sourceProjectId)) {
      const newIdValue = idOf(maps.refs, r.id);
      const prev = idOf(maps.refs, r.supersedes_id);
      if (newIdValue && prev) run("UPDATE reference_assets SET supersedes_id = ? WHERE id = ?", prev, newIdValue);
    }

    // ---- درخواست‌ها (بدون اجرای خودکار؛ کار نیمه‌کاره «نامشخص» می‌شود)
    for (const r of all("SELECT * FROM ai_requests WHERE project_id = ? ORDER BY created_at", sourceProjectId)) {
      const id = newId();
      maps.requests.set(String(r.id), id);
      const status = String(r.status ?? "queued");
      const importedStatus =
        status === "sending" || status === "processing" ? "unknown" : status === "queued" ? "cancelled" : status;
      const noteParts = [String(r.note ?? "").trim()].filter(Boolean);
      if (status !== importedStatus) {
        noteParts.push(
          status === "queued"
            ? "از بستهٔ پشتیبان وارد شد و اجرا نشد."
            : "هنگام تهیهٔ پشتیبان در جریان بود؛ نتیجه در سرویس نامشخص است.",
        );
      }
      const inputs = JSON.parse(String(r.inputs ?? "{}")) as Record<string, unknown>;
      // شناسه‌های تکی در گذر دوم (پس از ساخت خروجی‌ها) کامل می‌شوند.
      pendingRequestInputs.push({ requestId: id, inputs });
      run(
        `INSERT INTO ai_requests (id, project_id, panel_id, role, provider, model, prompt_id, prompt_version, prompt_text, inputs, request_key,
           status, attempts, http_status, error_code, error_message, provider_request_id, raw_response, parsed, validation_errors,
           cost_estimate, cost_reported, cost_computed, note, created_at, updated_at, sent_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        newProjectId,
        idOf(maps.panels, r.panel_id),
        String(r.role),
        String(r.provider),
        String(r.model),
        r.prompt_version == null ? null : Number(r.prompt_version),
        String(r.prompt_text ?? ""),
        JSON.stringify({ ...inputs, _imported: true }),
        `${String(r.request_key ?? "restored")}:${id}`,
        importedStatus,
        Number(r.attempts ?? 0),
        r.http_status == null ? null : Number(r.http_status),
        r.error_code ? String(r.error_code) : null,
        r.error_message ? String(r.error_message) : null,
        r.provider_request_id ? String(r.provider_request_id) : null,
        r.raw_response ? String(r.raw_response) : null,
        r.parsed ? String(r.parsed) : "null",
        String(r.validation_errors ?? "[]"),
        String(r.cost_estimate ?? "{}"),
        String(r.cost_reported ?? "{}"),
        String(r.cost_computed ?? "{}"),
        noteParts.join(" · "),
        String(r.created_at ?? now),
        String(r.updated_at ?? now),
        r.sent_at ? String(r.sent_at) : null,
        r.finished_at ? String(r.finished_at) : null,
      );
    }
    for (const a of all(
      "SELECT * FROM ai_attempts WHERE request_id IN (SELECT id FROM ai_requests WHERE project_id = ?) ORDER BY created_at",
      sourceProjectId,
    )) {
      const requestId = idOf(maps.requests, a.request_id);
      if (!requestId) continue;
      run(
        `INSERT INTO ai_attempts (id, request_id, attempt, status, http_status, error_code, error_message, tokens_in, tokens_out, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(),
        requestId,
        Number(a.attempt),
        String(a.status),
        a.http_status == null ? null : Number(a.http_status),
        a.error_code ? String(a.error_code) : null,
        a.error_message ? String(a.error_message) : null,
        a.tokens_in == null ? null : Number(a.tokens_in),
        a.tokens_out == null ? null : Number(a.tokens_out),
        a.duration_ms == null ? null : Number(a.duration_ms),
        String(a.created_at ?? now),
      );
    }

    // ---- پنل‌ها (اشاره‌گر خروجی در گذر دوم)
    for (const p of all("SELECT * FROM panels WHERE project_id = ? ORDER BY position", sourceProjectId)) {
      const sceneId = idOf(maps.scenes, p.scene_id);
      const adaptationId = idOf(maps.adaptations, p.adaptation_id);
      if (!sceneId || !adaptationId) throw new AppError("پنلی بدون صحنه/اقتباس در بسته است.", 400, "orphan_panel_in_package");
      const id = newId();
      maps.panels.set(String(p.id), id);
      let characters: unknown[] = [];
      try {
        characters = (JSON.parse(String(p.characters ?? "[]")) as Array<Record<string, unknown>>).map((c) => ({
          ...c,
          entityId: c.entityId ? idOf(maps.entities, c.entityId) ?? null : null,
        }));
      } catch {
        characters = [];
      }
      run(
        `INSERT INTO panels (id, project_id, adaptation_id, scene_id, position, title, source_scene_version_id, source_excerpt,
           narrative_goal, action, characters, location_id, time_label, shot_size, camera_angle, gaze_direction, movement,
           emotion, lighting, costumes, props, dialogue, style_profile_id, references_used, identity_snapshot, status,
           needs_review, review_reason, current_take_id, image_asset_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        id,
        newProjectId,
        adaptationId,
        sceneId,
        Number(p.position),
        String(p.title ?? ""),
        idOf(maps.sceneVersions, p.source_scene_version_id),
        String(p.source_excerpt ?? ""),
        String(p.narrative_goal ?? ""),
        String(p.action ?? ""),
        JSON.stringify(characters),
        idOf(maps.entities, p.location_id),
        String(p.time_label ?? ""),
        String(p.shot_size ?? "medium"),
        String(p.camera_angle ?? "eye"),
        String(p.gaze_direction ?? ""),
        String(p.movement ?? ""),
        String(p.emotion ?? ""),
        String(p.lighting ?? ""),
        String(p.costumes ?? ""),
        String(p.props ?? ""),
        String(p.dialogue ?? "[]"),
        idOf(maps.styles, p.style_profile_id),
        JSON.stringify(remapList(parseArray(p.references_used), maps.refs)),
        String(p.identity_snapshot ?? "{}"),
        String(p.status ?? "draft"),
        Number(p.needs_review ?? 0),
        String(p.review_reason ?? ""),
        idOf(maps.assets, p.image_asset_id),
        String(p.created_at ?? now),
        String(p.updated_at ?? now),
      );
    }
    for (const v of all(
      "SELECT * FROM panel_versions WHERE panel_id IN (SELECT id FROM panels WHERE project_id = ?) ORDER BY version",
      sourceProjectId,
    )) {
      const panelId = idOf(maps.panels, v.panel_id);
      if (!panelId) continue;
      run(
        `INSERT INTO panel_versions (id, panel_id, version, payload, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        newId(),
        panelId,
        Number(v.version),
        String(v.payload ?? "{}"),
        String(v.reason ?? "restore"),
        String(v.created_at ?? now),
      );
    }

    // ---- خروجی‌ها: همهٔ نامزدها/پذیرفته‌ها/ردشده‌ها با خروجی مبدأ و ماسک
    for (const t of all(
      "SELECT * FROM image_takes WHERE panel_id IN (SELECT id FROM panels WHERE project_id = ?) ORDER BY created_at",
      sourceProjectId,
    )) {
      const panelId = idOf(maps.panels, t.panel_id);
      const requestId = idOf(maps.requests, t.request_id);
      const assetId = idOf(maps.assets, t.asset_id);
      if (!panelId || !requestId || !assetId) throw new AppError("خروجی تصویری ناقص در بسته است.", 400, "take_incomplete");
      const id = newId();
      maps.takes.set(String(t.id), id);
      let meta: Record<string, unknown>;
      try {
        meta = JSON.parse(String(t.meta ?? "{}")) as Record<string, unknown>;
      } catch {
        meta = {};
      }
      if (Array.isArray(meta.attachments)) {
        meta.attachments = (meta.attachments as Array<Record<string, unknown>>).map((entry) => ({
          ...entry,
          referenceId: idOf(maps.refs, entry.referenceId),
        }));
      }
      run(
        `INSERT INTO image_takes (id, panel_id, request_id, asset_id, variant, status, seed, meta, created_at, accepted_at, source_take_id, mask_asset_id, edit_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        id,
        panelId,
        requestId,
        assetId,
        Number(t.variant ?? 0),
        String(t.status ?? "candidate"),
        t.seed ? String(t.seed) : null,
        JSON.stringify(meta),
        String(t.created_at ?? now),
        t.accepted_at ? String(t.accepted_at) : null,
        idOf(maps.assets, t.mask_asset_id),
        t.edit_kind ? String(t.edit_kind) : null,
      );
    }
    for (const t of all(
      "SELECT id, source_take_id FROM image_takes WHERE panel_id IN (SELECT id FROM panels WHERE project_id = ?)",
      sourceProjectId,
    )) {
      const takeId = idOf(maps.takes, t.id);
      const sourceId = idOf(maps.takes, t.source_take_id);
      if (takeId && sourceId) run("UPDATE image_takes SET source_take_id = ? WHERE id = ?", sourceId, takeId);
    }
    for (const p of all("SELECT id, current_take_id, identity_snapshot FROM panels WHERE project_id = ?", sourceProjectId)) {
      const panelId = idOf(maps.panels, p.id);
      if (!panelId) continue;
      const takeId = idOf(maps.takes, p.current_take_id);
      if (takeId) run("UPDATE panels SET current_take_id = ? WHERE id = ?", takeId, panelId);
      let snapshot: Record<string, unknown> = {};
      try {
        snapshot = JSON.parse(String(p.identity_snapshot ?? "{}")) as Record<string, unknown>;
      } catch {
        snapshot = {};
      }
      if (Object.keys(snapshot).length) {
        run("UPDATE panels SET identity_snapshot = ? WHERE id = ?", JSON.stringify(remapSnapshot(snapshot)), panelId);
      }
    }

    // ---- بازبینی‌ها با تصمیم کاربر و ارجاع مرجع
    for (const rr of all(
      "SELECT * FROM review_reports WHERE panel_id IN (SELECT id FROM panels WHERE project_id = ?) ORDER BY created_at",
      sourceProjectId,
    )) {
      const panelId = idOf(maps.panels, rr.panel_id);
      if (!panelId) continue;
      const id = newId();
      maps.reports.set(String(rr.id), id);
      run(
        `INSERT INTO review_reports (id, panel_id, request_id, image_asset_id, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        panelId,
        idOf(maps.requests, rr.request_id),
        idOf(maps.assets, rr.image_asset_id),
        String(rr.summary ?? ""),
        String(rr.created_at ?? now),
      );
    }
    for (const i of all(
      "SELECT * FROM review_issues WHERE report_id IN (SELECT id FROM review_reports WHERE panel_id IN (SELECT id FROM panels WHERE project_id = ?)) ORDER BY created_at",
      sourceProjectId,
    )) {
      const reportId = idOf(maps.reports, i.report_id);
      if (!reportId) continue;
      run(
        `INSERT INTO review_issues (id, report_id, kind, severity, description, reference_id, evidence, confidence, suggestion, evaluable, decision, decision_note, decided_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(),
        reportId,
        String(i.kind),
        String(i.severity ?? "medium"),
        String(i.description),
        idOf(maps.refs, i.reference_id),
        String(i.evidence ?? ""),
        String(i.confidence ?? "medium"),
        String(i.suggestion ?? ""),
        Number(i.evaluable ?? 1),
        String(i.decision ?? "pending"),
        String(i.decision_note ?? ""),
        i.decided_at ? String(i.decided_at) : null,
        String(i.created_at ?? now),
      );
    }

    // ---- صفحه‌بندی، جای‌گذاری و لایه‌های متن
    for (const d of all("SELECT * FROM pagination_docs WHERE project_id = ?", sourceProjectId)) {
      const id = newId();
      maps.docs.set(String(d.id), id);
      run(
        `INSERT INTO pagination_docs (id, project_id, format, title, page_width, page_height, gap, settings, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        newProjectId,
        String(d.format ?? "vertical"),
        String(d.title ?? "صفحه‌بندی"),
        Number(d.page_width ?? 1200),
        Number(d.page_height ?? 1800),
        Number(d.gap ?? 16),
        String(d.settings ?? "{}"),
        String(d.created_at ?? now),
        String(d.updated_at ?? now),
      );
    }
    for (const pl of all("SELECT * FROM panel_placements WHERE doc_id IN (SELECT id FROM pagination_docs WHERE project_id = ?)", sourceProjectId)) {
      const docId = idOf(maps.docs, pl.doc_id);
      const panelId = idOf(maps.panels, pl.panel_id);
      if (!docId || !panelId) throw new AppError("جای‌گذاری پنل ناقص در بسته است.", 400, "placement_incomplete");
      const id = newId();
      maps.placements.set(String(pl.id), id);
      run(
        `INSERT INTO panel_placements (id, doc_id, panel_id, page_index, x, y, w, h, reading_index, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        docId,
        panelId,
        Number(pl.page_index),
        Number(pl.x),
        Number(pl.y),
        Number(pl.w),
        Number(pl.h),
        Number(pl.reading_index),
        String(pl.created_at ?? now),
        String(pl.updated_at ?? now),
      );
    }
    for (const tl of all("SELECT * FROM text_layers WHERE doc_id IN (SELECT id FROM pagination_docs WHERE project_id = ?)", sourceProjectId)) {
      const docId = idOf(maps.docs, tl.doc_id);
      if (!docId) continue;
      run(
        `INSERT INTO text_layers (id, doc_id, panel_id, placement_id, kind, speaker, body, x, y, w, h, font_size, direction, tail, z, style, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(),
        docId,
        idOf(maps.panels, tl.panel_id),
        idOf(maps.placements, tl.placement_id),
        String(tl.kind ?? "dialogue"),
        String(tl.speaker ?? ""),
        String(tl.body ?? ""),
        Number(tl.x ?? 0.5),
        Number(tl.y ?? 0.1),
        Number(tl.w ?? 0.3),
        Number(tl.h ?? 0.14),
        Number(tl.font_size ?? 22),
        String(tl.direction ?? "rtl"),
        String(tl.tail ?? ""),
        Number(tl.z ?? 0),
        String(tl.style ?? "{}"),
        String(tl.created_at ?? now),
        String(tl.updated_at ?? now),
      );
    }

    // ---- کارها: تاریخچه، هرگز خودکار اجرا نمی‌شوند
    for (const j of all("SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at", sourceProjectId)) {
      const active = ["queued", "sending", "processing"].includes(String(j.status));
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(String(j.payload ?? "{}")) as Record<string, unknown>;
      } catch {
        payload = {};
      }
      const remapped = {
        ...payload,
        panelId: idOf(maps.panels, payload.panelId),
        requestId: idOf(maps.requests, payload.requestId),
        sceneId: idOf(maps.scenes, payload.sceneId),
        _imported: true,
      };
      run(
        `INSERT INTO jobs (id, project_id, type, status, payload, dedupe_key, attempts, max_attempts, available_at, locked_until, request_id, error_code, error_message, created_at, updated_at, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
        newId(),
        newProjectId,
        String(j.type),
        active ? (String(j.status) === "queued" ? "cancelled" : "unknown") : String(j.status),
        JSON.stringify(remapped),
        `${String(j.dedupe_key ?? "job")}:restored:${newId()}`,
        Number(j.attempts ?? 0),
        Number(j.max_attempts ?? 1),
        now,
        idOf(maps.requests, j.request_id),
        active ? "restored_incomplete" : (j.error_code ? String(j.error_code) : null),
        active ? "کار هنگام پشتیبان‌گیری نیمه‌کاره بود؛ وارد تاریخچه شد و اجرا نمی‌شود." : (j.error_message ? String(j.error_message) : null),
        String(j.created_at ?? now),
        String(j.updated_at ?? now),
        j.started_at ? String(j.started_at) : null,
        j.finished_at ? String(j.finished_at) : null,
      );
    }

    // ---- گذر دوم: ورودی درخواست‌ها و پاسخ پارس‌شده با شناسه‌های تازه
    for (const { requestId, inputs } of pendingRequestInputs) {
      const next: Record<string, unknown> = { ...inputs, _imported: true };
      next.sceneId = idOf(maps.scenes, inputs.sceneId);
      next.panelId = idOf(maps.panels, inputs.panelId);
      next.imageAssetId = idOf(maps.assets, inputs.imageAssetId);
      next.sourceAssetId = idOf(maps.assets, inputs.sourceAssetId);
      next.maskAssetId = idOf(maps.assets, inputs.maskAssetId);
      next.takeId = idOf(maps.takes, inputs.takeId);
      next.sourceTakeId = idOf(maps.takes, inputs.sourceTakeId);
      if (Array.isArray(inputs.attachments)) {
        next.attachments = (inputs.attachments as Array<Record<string, unknown>>).map((entry) => ({
          ...entry,
          referenceId: idOf(maps.refs, entry.referenceId),
          assetId: idOf(maps.assets, entry.assetId),
        }));
      }
      run("UPDATE ai_requests SET inputs = ? WHERE id = ?", JSON.stringify(next), requestId);
    }
    for (const r of all("SELECT id, parsed FROM ai_requests WHERE project_id = ? AND parsed IS NOT NULL", sourceProjectId)) {
      const requestId = idOf(maps.requests, r.id);
      if (!requestId) continue;
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(String(r.parsed));
      } catch {
        parsed = null;
      }
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as { takeIds?: string[] }).takeIds)) {
        const takeIds = remapList((parsed as { takeIds: string[] }).takeIds, maps.takes);
        parsed = { ...(parsed as object), takeIds };
      }
      run("UPDATE ai_requests SET parsed = ? WHERE id = ?", JSON.stringify(parsed), requestId);
    }

    // ---- بازبینی شمارش‌ها پیش از commit؛ کم‌بودن یعنی بسته ناقص است.
    const actual = {
      sceneVersions: Number(
        row("SELECT COUNT(*) AS c FROM scene_versions WHERE scene_id IN (SELECT id FROM scenes WHERE project_id = ?)", newProjectId)?.c ?? 0,
      ),
      panels: Number(row("SELECT COUNT(*) AS c FROM panels WHERE project_id = ?", newProjectId)?.c ?? 0),
      takes: Number(
        row("SELECT COUNT(*) AS c FROM image_takes WHERE panel_id IN (SELECT id FROM panels WHERE project_id = ?)", newProjectId)?.c ?? 0,
      ),
      requests: Number(row("SELECT COUNT(*) AS c FROM ai_requests WHERE project_id = ?", newProjectId)?.c ?? 0),
      reviews: Number(
        row("SELECT COUNT(*) AS c FROM review_reports WHERE panel_id IN (SELECT id FROM panels WHERE project_id = ?)", newProjectId)?.c ?? 0,
      ),
      placements: Number(
        row("SELECT COUNT(*) AS c FROM panel_placements WHERE doc_id IN (SELECT id FROM pagination_docs WHERE project_id = ?)", newProjectId)?.c ?? 0,
      ),
      textLayers: Number(
        row("SELECT COUNT(*) AS c FROM text_layers WHERE doc_id IN (SELECT id FROM pagination_docs WHERE project_id = ?)", newProjectId)?.c ?? 0,
      ),
    };
    for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
      if (actual[key] !== expected[key]) {
        throw new AppError(
          `بازیابی کامل نبود: ${key} انتظار ${expected[key]} داشت و ${actual[key]} وارد شد.`,
          400,
          "restore_count_mismatch",
          "بسته ناقص یا ناسازگار است؛ هیچ تغییری ذخیره نشد.",
        );
      }
    }
  });

  const counts = {
    scenes: Number(row("SELECT COUNT(*) AS c FROM scenes WHERE project_id = ?", newProjectId)?.c ?? 0),
    sceneVersions: expected.sceneVersions,
    entities: Number(row("SELECT COUNT(*) AS c FROM entities WHERE project_id = ?", newProjectId)?.c ?? 0),
    references: Number(row("SELECT COUNT(*) AS c FROM reference_assets WHERE project_id = ?", newProjectId)?.c ?? 0),
    panels: expected.panels,
    takes: expected.takes,
    requests: expected.requests,
    reviews: expected.reviews,
    placements: expected.placements,
    textLayers: expected.textLayers,
  };
  return { projectId: newProjectId, title, assets: maps.assets.size, counts };
}

/** پشتیبان کامل پایگاه داده (بدون کلید) برای snapshot پیش از مهاجرت. */
export function backupSnapshot(projectId: string, note = ""): { path: string; bytes: number } {
  const target = snapshotDatabase();
  const fileName = `ravayat-full-backup-${Date.now()}.db`;
  const dest = path.join(DATA_DIR, "backups", safeName(fileName, "backup.db"));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(target, dest);
  fs.rmSync(path.dirname(target), { recursive: true, force: true });
  const bytes = fs.statSync(dest).size;
  run(
    "INSERT INTO backups (id, project_id, path, bytes, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    newId(),
    projectId,
    path.relative(DATA_DIR, dest).replace(/\\/g, "/"),
    bytes,
    note || "پشتیبان کامل نصب (همهٔ پروژه‌ها) — دامنه: کل نصب",
    nowIso(),
  );
  return { path: dest, bytes };
}

export function listBackups(projectId: string) {
  return dbRows("SELECT * FROM backups WHERE project_id = ? ORDER BY created_at DESC", projectId).map((r) => ({
    id: String(r.id),
    path: String(r.path),
    bytes: Number(r.bytes),
    note: String(r.note ?? ""),
    createdAt: String(r.created_at),
  }));
}

export function projectHasAssets(projectId: string): boolean {
  return projectAssetKeys(projectId).length > 0;
}

export function rowExists(table: string, id: string): boolean {
  return Boolean(row(`SELECT 1 AS x FROM ${table} WHERE id = ?`, id));
}
