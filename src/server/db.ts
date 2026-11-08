import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * لایهٔ پایگاه دادهٔ «استودیوی روایت».
 *
 * یک پروژه = یک پروندهٔ SQLite در پوشهٔ دادهٔ کاربر. تصاویر بیرون از پایگاه
 * داده و با مسیر نسبی + هش نگه‌داری می‌شوند تا جابه‌جایی پوشه آن‌ها را نشکند.
 * مهاجرت‌ها با user_version انجام می‌شوند و هر مهاجرت در یک تراکنش است.
 */

export const DATA_DIR = process.env.RAVAYAT_DATA_DIR
  ? path.resolve(process.env.RAVAYAT_DATA_DIR)
  : path.join(process.cwd(), "data");

export const ASSET_DIR = path.join(DATA_DIR, "assets");
export const EXPORT_DIR = path.join(DATA_DIR, "exports");
export const BACKUP_DIR = path.join(DATA_DIR, "backups");
export const DB_PATH = path.join(DATA_DIR, "studio.db");

export const SCHEMA_VERSION = 2;

type Global = typeof globalThis & { __ravayatDb?: DatabaseSync };
const g = globalThis as Global;

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return crypto.randomUUID();
}

export function sha256(buf: Buffer | string): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * مهاجرت‌ها: هر خانه یک گام است. برای افزودن تغییر، فقط به انتهای آرایه
 * اضافه کنید و SCHEMA_VERSION را بالا ببرید؛ دادهٔ کاربر حفظ می‌شود.
 */
const MIGRATIONS: string[] = [
  // ---- v1 ----------------------------------------------------------------
  `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'fa',
  publish_format TEXT NOT NULL DEFAULT 'vertical',
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS works (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  genre TEXT NOT NULL DEFAULT '',
  synopsis TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_works_project ON works(project_id);

CREATE TABLE IF NOT EXISTS chapters (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  story_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chapters_project ON chapters(project_id, position);

CREATE TABLE IF NOT EXISTS scenes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  objective TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  story_date TEXT,
  is_flashback INTEGER NOT NULL DEFAULT 0,
  word_count INTEGER NOT NULL DEFAULT 0,
  current_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scenes_chapter ON scenes(chapter_id, position);

CREATE TABLE IF NOT EXISTS scene_versions (
  id TEXT PRIMARY KEY,
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  text TEXT NOT NULL,
  hash TEXT NOT NULL,
  word_count INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT 'manual',
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_scene_versions_unique ON scene_versions(scene_id, version);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entities_project ON entities(project_id, kind);

CREATE TABLE IF NOT EXISTS entity_versions (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  layer TEXT NOT NULL DEFAULT 'identity',
  payload TEXT NOT NULL DEFAULT '{}',
  fixed_traits INTEGER NOT NULL DEFAULT 0,
  valid_from TEXT,
  valid_to TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  approved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_entity_versions ON entity_versions(entity_id, layer);

CREATE TABLE IF NOT EXISTS entity_relations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL DEFAULT 'entity',
  subject_id TEXT NOT NULL DEFAULT '',
  attribute TEXT NOT NULL,
  value TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'user_decision',
  source_ref TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'proposed',
  scope_start TEXT,
  scope_end TEXT,
  conflict_group TEXT,
  resolution_note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(project_id, subject_id, attribute);

CREATE TABLE IF NOT EXISTS character_knowledge (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  fact_id TEXT REFERENCES facts(id) ON DELETE CASCADE,
  knowledge TEXT NOT NULL DEFAULT 'knows',
  reveal_scene_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scene_state (
  id TEXT PRIMARY KEY,
  scene_id TEXT NOT NULL UNIQUE REFERENCES scenes(id) ON DELETE CASCADE,
  location_id TEXT,
  present_entities TEXT NOT NULL DEFAULT '[]',
  overrides TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS timeline_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_id TEXT,
  label TEXT NOT NULL,
  story_date TEXT,
  kind TEXT NOT NULL DEFAULT 'event',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS style_profiles (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  palette TEXT NOT NULL DEFAULT '',
  linework TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  storage_key TEXT NOT NULL,
  thumb_key TEXT,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  sha256 TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'image',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_hash ON assets(sha256);

CREATE TABLE IF NOT EXISTS reference_assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT 'local_upload',
  license_note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 1,
  supersedes_id TEXT,
  entities TEXT NOT NULL DEFAULT '[]',
  roles TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refs_project ON reference_assets(project_id, status);

CREATE TABLE IF NOT EXISTS adaptations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS panels (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  adaptation_id TEXT NOT NULL REFERENCES adaptations(id) ON DELETE CASCADE,
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  source_scene_version_id TEXT,
  source_excerpt TEXT NOT NULL DEFAULT '',
  narrative_goal TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  characters TEXT NOT NULL DEFAULT '[]',
  location_id TEXT,
  time_label TEXT NOT NULL DEFAULT '',
  shot_size TEXT NOT NULL DEFAULT 'medium',
  camera_angle TEXT NOT NULL DEFAULT 'eye',
  gaze_direction TEXT NOT NULL DEFAULT '',
  movement TEXT NOT NULL DEFAULT '',
  emotion TEXT NOT NULL DEFAULT '',
  lighting TEXT NOT NULL DEFAULT '',
  costumes TEXT NOT NULL DEFAULT '',
  props TEXT NOT NULL DEFAULT '',
  dialogue TEXT NOT NULL DEFAULT '[]',
  style_profile_id TEXT,
  references_used TEXT NOT NULL DEFAULT '[]',
  identity_snapshot TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft',
  needs_review INTEGER NOT NULL DEFAULT 0,
  review_reason TEXT NOT NULL DEFAULT '',
  current_take_id TEXT,
  image_asset_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_panels_scene ON panels(scene_id, position);

CREATE TABLE IF NOT EXISTS panel_versions (
  id TEXT PRIMARY KEY,
  panel_id TEXT NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_prompts (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_prompts_role_version ON ai_prompts(role, version);

CREATE TABLE IF NOT EXISTS ai_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  panel_id TEXT,
  role TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_id TEXT,
  prompt_version INTEGER,
  prompt_text TEXT NOT NULL DEFAULT '',
  inputs TEXT NOT NULL DEFAULT '{}',
  request_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  http_status INTEGER,
  error_code TEXT,
  error_message TEXT,
  provider_request_id TEXT,
  raw_response TEXT,
  parsed TEXT,
  validation_errors TEXT NOT NULL DEFAULT '[]',
  cost_estimate TEXT NOT NULL DEFAULT '{}',
  cost_reported TEXT NOT NULL DEFAULT '{}',
  cost_computed TEXT NOT NULL DEFAULT '{}',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_requests_project ON ai_requests(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_requests_key ON ai_requests(request_key);

CREATE TABLE IF NOT EXISTS ai_attempts (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES ai_requests(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  http_status INTEGER,
  error_code TEXT,
  error_message TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS image_takes (
  id TEXT PRIMARY KEY,
  panel_id TEXT NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL REFERENCES ai_requests(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  variant INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'candidate',
  seed TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  accepted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_takes_panel ON image_takes(panel_id, created_at);

CREATE TABLE IF NOT EXISTS review_reports (
  id TEXT PRIMARY KEY,
  panel_id TEXT NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
  request_id TEXT,
  image_asset_id TEXT,
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_issues (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES review_reports(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',
  description TEXT NOT NULL,
  reference_id TEXT,
  evidence TEXT NOT NULL DEFAULT '',
  confidence TEXT NOT NULL DEFAULT 'medium',
  suggestion TEXT NOT NULL DEFAULT '',
  evaluable INTEGER NOT NULL DEFAULT 1,
  decision TEXT NOT NULL DEFAULT 'pending',
  decision_note TEXT NOT NULL DEFAULT '',
  decided_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pagination_docs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  format TEXT NOT NULL DEFAULT 'vertical',
  title TEXT NOT NULL DEFAULT '',
  page_width INTEGER NOT NULL DEFAULT 1200,
  page_height INTEGER NOT NULL DEFAULT 1800,
  gap INTEGER NOT NULL DEFAULT 16,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS panel_placements (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES pagination_docs(id) ON DELETE CASCADE,
  panel_id TEXT NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
  page_index INTEGER NOT NULL DEFAULT 0,
  x REAL NOT NULL DEFAULT 0,
  y REAL NOT NULL DEFAULT 0,
  w REAL NOT NULL DEFAULT 900,
  h REAL NOT NULL DEFAULT 900,
  reading_index INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_placements_doc ON panel_placements(doc_id, page_index, reading_index);

CREATE TABLE IF NOT EXISTS text_layers (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES pagination_docs(id) ON DELETE CASCADE,
  panel_id TEXT,
  placement_id TEXT,
  kind TEXT NOT NULL DEFAULT 'dialogue',
  speaker TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  x REAL NOT NULL DEFAULT 0.5,
  y REAL NOT NULL DEFAULT 0.1,
  w REAL NOT NULL DEFAULT 0.3,
  h REAL NOT NULL DEFAULT 0.14,
  font_size INTEGER NOT NULL DEFAULT 22,
  direction TEXT NOT NULL DEFAULT 'rtl',
  tail TEXT NOT NULL DEFAULT '',
  z INTEGER NOT NULL DEFAULT 0,
  style TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  payload TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  available_at TEXT NOT NULL,
  locked_until TEXT,
  request_id TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, available_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_dedupe ON jobs(dedupe_key) WHERE status IN ('queued','sending','processing');

CREATE TABLE IF NOT EXISTS cost_rates (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  unit TEXT NOT NULL,
  rate TEXT NOT NULL DEFAULT '{}',
  source_url TEXT NOT NULL,
  effective_date TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  asset_id TEXT,
  filename TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backups (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
`,
  // ---- v2 ----------------------------------------------------------------
  `
-- بازهٔ اعتبار مرجع تصویری: مرجع «پس از زخم» نباید برای فلش‌بک پیش از آن انتخاب شود.
ALTER TABLE reference_assets ADD COLUMN valid_from TEXT;
ALTER TABLE reference_assets ADD COLUMN valid_to TEXT;
CREATE INDEX IF NOT EXISTS idx_refs_validity ON reference_assets(project_id, valid_from, valid_to);

-- مسیر واقعی اصلاح ناحیه‌ای: خروجی ویرایش به خروجی مبدأ و ماسک خودش گره می‌خورد.
ALTER TABLE image_takes ADD COLUMN source_take_id TEXT;
ALTER TABLE image_takes ADD COLUMN mask_asset_id TEXT;
ALTER TABLE image_takes ADD COLUMN edit_kind TEXT;

-- زنجیرهٔ درخواست‌های مرتبط (اصلاح پاسخ، تحلیل تصویر پس از تولید)
ALTER TABLE ai_requests ADD COLUMN parent_request_id TEXT;
ALTER TABLE ai_requests ADD COLUMN usage TEXT NOT NULL DEFAULT '{}';
`,
];

function migrate(db: DatabaseSync): { from: number; to: number } {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  const from = Number(row?.user_version ?? 0);
  for (let version = from; version < MIGRATIONS.length; version++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* secondary */
      }
      throw error;
    }
  }
  return { from, to: MIGRATIONS.length };
}

export function openDatabaseAt(filePath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  migrate(db);
  return db;
}

export function getDb(): DatabaseSync {
  if (!g.__ravayatDb) {
    fs.mkdirSync(ASSET_DIR, { recursive: true });
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    g.__ravayatDb = openDatabaseAt(DB_PATH);
  }
  return g.__ravayatDb;
}

export function closeDb(): void {
  if (g.__ravayatDb) {
    try {
      g.__ravayatDb.close();
    } catch {
      /* ignore */
    }
    g.__ravayatDb = undefined;
  }
}

type Row = Record<string, unknown>;

export function rows(sql: string, ...params: unknown[]): Row[] {
  return getDb().prepare(sql).all(...(params as never[])) as Row[];
}

export function row(sql: string, ...params: unknown[]): Row | undefined {
  return getDb().prepare(sql).get(...(params as never[])) as Row | undefined;
}

export function run(sql: string, ...params: unknown[]) {
  return getDb().prepare(sql).run(...(params as never[])) as { changes: number; lastInsertRowid: number | bigint };
}

export function transaction<T>(fn: () => T): T {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw error;
  }
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function getSetting(key: string): string | undefined {
  const found = row("SELECT value FROM settings WHERE key = ?", key);
  return found ? String(found.value) : undefined;
}

export function setSetting(key: string, value: string): void {
  run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    value,
    nowIso(),
  );
}

export function getAllSettings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows("SELECT key, value FROM settings")) out[String(r.key)] = String(r.value);
  return out;
}
