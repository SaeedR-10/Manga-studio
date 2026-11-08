import { row } from "./db";
import { AppError } from "./http";
import { getScene, requireProject } from "./repo/projects";

/**
 * سقف‌ها و بودجهٔ محلی.
 *
 * هر سقف دقیقاً یک چیز را می‌شمارد:
 *  - «تولید هر پنل» = خروجی‌های موجود + درخواست‌های پذیرفته‌شده‌ای که هنوز
 *    نتیجه نداده‌اند (صف/ارسال/پردازش). پس با تغییر متن یا صف‌کردن سریع نمی‌شود
 *    از سقف گذشت؛ ظرفیت در همان تراکنش ثبت درخواست رزرو می‌شود.
 *  - «بازبینی هر پنل» = گزارش‌های ساخته‌شده + بازبینی‌های در انتظار.
 *  - «بودجهٔ فصل» = مجموع هزینهٔ همهٔ صحنه‌های همان فصل، شامل اقتباس، بازبینی و
 *    اصلاح؛ نه فقط همان صحنه. هزینهٔ نامشخص صفر حساب نمی‌شود.
 *
 * این سقف محلی است و جای سقف صورتحساب ارائه‌دهنده را نمی‌گیرد.
 */

export const ACTIVE_STATUSES = ["queued", "sending", "processing"] as const;
const ACTIVE_SQL = "'queued','sending','processing'";

export interface PanelUsage {
  /** خروجی‌های ذخیره‌شده (پذیرفته یا نامزد) */
  takes: number;
  /** درخواست‌های تولید پذیرفته‌شده که هنوز نتیجه ندارند */
  active: number;
  reviews: number;
  activeReviews: number;
  admitted: number;
}

export function panelUsage(panelId: string): PanelUsage {
  const count = (sql: string) => Number(row(sql, panelId)?.c ?? 0);
  const takes = count("SELECT COUNT(*) AS c FROM image_takes WHERE panel_id = ?");
  const active = count(
    `SELECT COUNT(*) AS c FROM ai_requests WHERE panel_id = ? AND role = 'prompt_writer' AND status IN (${ACTIVE_SQL})`,
  );
  const reviews = count("SELECT COUNT(*) AS c FROM review_reports WHERE panel_id = ?");
  const activeReviews = count(
    `SELECT COUNT(*) AS c FROM ai_requests WHERE panel_id = ? AND role = 'image_reviewer' AND status IN (${ACTIVE_SQL})`,
  );
  return { takes, active, reviews, activeReviews, admitted: takes + active };
}

export function assertGenerationAdmission(projectId: string, panelId: string): PanelUsage {
  const project = requireProject(projectId);
  const usage = panelUsage(panelId);
  const cap = project.settings.caps.generationsPerPanel;
  if (usage.admitted >= cap) {
    throw new AppError(
      `سقف محلی تولید این پنل (${cap}) پر شده است: ${usage.takes} خروجی و ${usage.active} درخواست در جریان.`,
      409,
      "cap_reached",
      "خروجی موجود را بپذیرید، درخواست در جریان را بررسی کنید، یا سقف را در تنظیمات پروژه بالا ببرید.",
    );
  }
  return usage;
}

export function assertReviewAdmission(projectId: string, panelId: string): PanelUsage {
  const project = requireProject(projectId);
  const usage = panelUsage(panelId);
  const cap = project.settings.caps.reviewsPerPanel;
  if (usage.reviews + usage.activeReviews >= cap) {
    throw new AppError(
      `سقف محلی بازبینی این پنل (${cap}) پر شده است: ${usage.reviews} گزارش و ${usage.activeReviews} در جریان.`,
      409,
      "cap_reached",
      "سقف را در تنظیمات پروژه تغییر دهید یا گزارش موجود را بررسی کنید.",
    );
  }
  return usage;
}

export interface BudgetState {
  budgetUsd: number | null;
  chapterId: string | null;
  /** هزینهٔ قطعی محاسبه‌شده/گزارش‌شدهٔ درخواست‌های تمام‌شده */
  knownUsd: number;
  /** برآورد درخواست‌های در جریان (رزرو) */
  reservedUsd: number;
  /** تعداد درخواست‌هایی که هزینه‌شان نامشخص است (تمام‌شده یا در جریان) */
  unknownCount: number;
  totalUsd: number;
  overBudget: boolean;
  policy: "block" | "allow";
  explanation: string;
}

/**
 * هزینهٔ فصل به تفکیک معلوم/نامشخص/رزرو.
 * `json_extract` ممکن است null بدهد؛ null هرگز به صفر تبدیل نمی‌شود.
 */
export function chapterBudget(projectId: string, sceneId: string | null): BudgetState {
  const project = requireProject(projectId);
  const budgetUsd = project.settings.caps.chapterBudgetUsd;
  const policy = project.settings.caps.unknownCostPolicy === "allow" ? "allow" : "block";
  if (!sceneId || budgetUsd == null) {
    return {
      budgetUsd,
      chapterId: null,
      knownUsd: 0,
      reservedUsd: 0,
      unknownCount: 0,
      totalUsd: 0,
      overBudget: false,
      policy,
      explanation: budgetUsd == null ? "سقف بودجه تعیین نشده است." : "",
    };
  }
  const scene = getScene(sceneId);
  if (!scene) {
    return {
      budgetUsd,
      chapterId: null,
      knownUsd: 0,
      reservedUsd: 0,
      unknownCount: 0,
      totalUsd: 0,
      overBudget: false,
      policy,
      explanation: "صحنه پیدا نشد؛ بودجه محاسبه نشد.",
    };
  }

  const scopeSql = `r.project_id = ? AND r.provider NOT IN ('chatgpt', 'manual_chatgpt') AND (
      r.panel_id IN (SELECT p.id FROM panels p JOIN scenes s ON s.id = p.scene_id WHERE s.chapter_id = ?)
      OR (r.panel_id IS NULL AND json_extract(r.inputs, '$.sceneId') IN (SELECT id FROM scenes WHERE chapter_id = ?))
    )`;
  const known = row(
    `SELECT COALESCE(SUM(COALESCE(
        json_extract(r.cost_computed, '$.usd'),
        json_extract(r.cost_reported, '$.usd')
      )), 0) AS total
       FROM ai_requests r
      WHERE ${scopeSql}
        AND r.status IN ('succeeded','failed','unknown','cancelled')
        AND COALESCE(json_extract(r.cost_computed, '$.usd'), json_extract(r.cost_reported, '$.usd')) IS NOT NULL`,
    projectId,
    scene.chapterId,
    scene.chapterId,
  );
  const unknown = row(
    `SELECT COUNT(*) AS c FROM ai_requests r
      WHERE ${scopeSql}
        AND r.status IN ('succeeded','failed','unknown','cancelled')
        AND json_extract(r.cost_computed, '$.usd') IS NULL
        AND json_extract(r.cost_reported, '$.usd') IS NULL`,
    projectId,
    scene.chapterId,
    scene.chapterId,
  );
  const reserved = row(
    `SELECT COALESCE(SUM(json_extract(r.cost_estimate, '$.usd')), 0) AS total,
            SUM(CASE WHEN json_extract(r.cost_estimate, '$.usd') IS NULL THEN 1 ELSE 0 END) AS unknown_c
       FROM ai_requests r
      WHERE ${scopeSql} AND r.status IN (${ACTIVE_SQL})`,
    projectId,
    scene.chapterId,
    scene.chapterId,
  );

  const knownUsd = Number(known?.total ?? 0);
  const reservedUsd = Number(reserved?.total ?? 0);
  const unknownCount = Number(unknown?.c ?? 0) + Number(reserved?.unknown_c ?? 0);
  const totalUsd = knownUsd + reservedUsd;
  return {
    budgetUsd,
    chapterId: scene.chapterId,
    knownUsd,
    reservedUsd,
    unknownCount,
    totalUsd,
    overBudget: budgetUsd != null && totalUsd >= budgetUsd,
    policy,
    explanation:
      unknownCount > 0
        ? `${unknownCount} درخواست هزینهٔ نامشخث دارد؛ سقف دلاری نمی‌تواند هزینهٔ آن‌ها را محدود کند.`
        : "هزینه‌ها بر پایهٔ مصرف گزارش‌شده محاسبه شده‌اند.",
  };
}

/** پذیرش درخواست تازه با احتساب رزرو درخواست‌های در جریان. */
export function assertBudgetAdmits(projectId: string, sceneId: string | null, nextEstimateUsd: number | null): BudgetState {
  const state = chapterBudget(projectId, sceneId);
  if (state.budgetUsd == null) return state;

  if (state.unknownCount > 0 && state.policy === "block") {
    throw new AppError(
      "در این فصل درخواست‌هایی با هزینهٔ نامشخص وجود دارد؛ سقف دلاری آن‌ها را محدود نمی‌کند.",
      409,
      "unknown_cost_blocks_budget",
      "در تنظیمات پروژه می‌توانید «اجازهٔ هزینهٔ نامشخص زیر سقف» را روشن کنید یا سقف را بردارید. سقف محلی جای سقف صورتحساب ارائه‌دهنده را نمی‌گیرد.",
    );
  }

  const next = nextEstimateUsd ?? 0;
  if (state.totalUsd + next > state.budgetUsd) {
    throw new AppError(
      `بودجهٔ این فصل (${state.budgetUsd} دلار) با احتساب هزینه‌های ثبت‌شده (${state.totalUsd.toFixed(4)}) و برآورد این درخواست کافی نیست.`,
      409,
      "budget_reached",
      "سقف را در تنظیمات پروژه بالا ببرید. این سقف فقط محلی است.",
    );
  }
  if (nextEstimateUsd == null) {
    throw new AppError(
      "هزینهٔ این درخواست نامشخص است و با سقف دلاری فصل قابل سنجش نیست.",
      409,
      "unknown_cost_requires_policy",
      "برای ادامه، سیاست «اجازهٔ هزینهٔ نامشخص» را در تنظیمات پروژه روشن کنید یا سقف فصل را بردارید.",
    );
  }
  return state;
}
