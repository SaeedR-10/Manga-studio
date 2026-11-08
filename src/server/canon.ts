/**
 * مرجع قطعی (Canon) با منطق زمانی.
 *
 * قواعد پیاده‌شده:
 *  ۱) پیشنهاد AI تا وقتی وضعیتش «تأییدشده» نشود در تصمیم‌ها استفاده نمی‌شود.
 *  ۲) هر واقعیت/نسخهٔ ظاهری یک بازهٔ اعتبار دارد؛ زمان صحنه تعیین می‌کند کدام
 *     نسخه معتبر است. ترتیب فصل‌ها با زمان وقوع یکی فرض نمی‌شود.
 *  ۳) اگر چند واقعیت تأییدشده در همان بازه با مقدار متفاوت باشند، «تعارض»
 *     گزارش می‌شود و هیچ‌کدام بی‌صدا انتخاب نمی‌شوند.
 *  ۴) اگر چیزی پیدا نشود، «نامشخص» است؛ حدس زده نمی‌شود.
 *  ۵) دانستهٔ شخصیت از دانستهٔ نویسنده جدا است و افشا بر اساس ترتیب روایت
 *     کنترل می‌شود، نه ترتیب زمانی.
 */

export type FactStatus = "proposed" | "confirmed" | "rejected" | "retired";

export interface FactLike {
  id: string;
  subjectId: string;
  attribute: string;
  value: string;
  status: FactStatus;
  sourceType: string;
  sourceRef: string;
  scopeStart: string | null;
  scopeEnd: string | null;
  createdAt: string;
  updatedAt: string;
  conflictGroup?: string | null;
  createdBy?: string;
}

export interface VersionLike {
  id: string;
  entityId: string;
  layer: string;
  label: string;
  payload: Record<string, unknown>;
  validFrom: string | null;
  validTo: string | null;
  approvedAt: string | null;
}

/** بازهٔ اعتبار «[from, to)» با مقایسهٔ رشتهٔ ISO؛ خالی یعنی بی‌کران. */
export function inScope(
  item: { scopeStart?: string | null; scopeEnd?: string | null; validFrom?: string | null; validTo?: string | null },
  at: string | null,
): boolean {
  const start = item.scopeStart ?? item.validFrom ?? null;
  const end = item.scopeEnd ?? item.validTo ?? null;
  if (!at) return start == null && end == null;
  if (start && at < start) return false;
  if (end && at >= end) return false;
  return true;
}

export type ResolveStatus = "resolved" | "conflict" | "unknown";

export interface Resolution<T> {
  status: ResolveStatus;
  chosen: T | null;
  candidates: T[];
  conflicts: T[];
  reason: string;
}

/**
 * انتخاب واقعیت مؤثر برای یک ویژگی در یک زمان داستانی.
 * واقعیت‌های تأییدشده‌ای که بازهٔ اعتبارشان شامل زمان صحنه است کاندید می‌شوند.
 */
export function resolveFact(
  facts: FactLike[],
  query: { subjectId: string; attribute: string; at: string | null },
): Resolution<FactLike> {
  const confirmed = facts.filter(
    (f) =>
      f.status === "confirmed" &&
      f.subjectId === query.subjectId &&
      f.attribute === query.attribute &&
      inScope(f, query.at),
  );
  if (confirmed.length === 0) {
    const proposed = facts.some(
      (f) => f.status === "proposed" && f.subjectId === query.subjectId && f.attribute === query.attribute,
    );
    return {
      status: "unknown",
      chosen: null,
      candidates: [],
      conflicts: [],
      reason: proposed
        ? "تنها پیشنهاد تأییدنشده وجود دارد؛ تا تأیید کاربر در تولید استفاده نمی‌شود."
        : "برای این ویژگی در زمان صحنه، واقعیت تأییدشده‌ای ثبت نشده است.",
    };
  }
  const values = new Set(confirmed.map((f) => f.value.trim()));
  if (values.size > 1) {
    return {
      status: "conflict",
      chosen: null,
      candidates: confirmed,
      conflicts: confirmed,
      reason: "چند واقعیت تأییدشده با مقدار متفاوت در همین بازه وجود دارد.",
    };
  }
  const chosen = [...confirmed].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return {
    status: "resolved",
    chosen,
    candidates: confirmed,
    conflicts: [],
    reason: `از واقعیت تأییدشده (${chosen.sourceType}) انتخاب شد.`,
  };
}

export function resolveVersion(
  versions: VersionLike[],
  query: { entityId: string; layer: string; at: string | null },
): Resolution<VersionLike> {
  const approved = versions.filter(
    (v) => v.entityId === query.entityId && v.layer === query.layer && v.approvedAt && inScope(v, query.at),
  );
  if (approved.length === 0) {
    return {
      status: "unknown",
      chosen: null,
      candidates: [],
      conflicts: [],
      reason: "نسخهٔ تأییدشده‌ای از این لایه برای زمان صحنه وجود ندارد.",
    };
  }
  if (approved.length > 1) {
    const fresh = [...approved].sort((a, b) => b.approvedAt!.localeCompare(a.approvedAt!));
    return {
      status: "conflict",
      chosen: null,
      candidates: approved,
      conflicts: approved.slice(0, 4),
      reason: "چند نسخهٔ تأییدشده در همان بازه اعتبار دارند؛ انتخاب باید صریح باشد.",
    };
  }
  return {
    status: "resolved",
    chosen: approved[0],
    candidates: approved,
    conflicts: [],
    reason: "نسخهٔ معتبر همین بازهٔ زمانی.",
  };
}

/** خصیصه‌های مادرزادی/ثابت از وضعیت متغیر جدا می‌شوند. */
export function isIntrinsicLayer(layer: string): boolean {
  return layer === "identity" || layer === "face" || layer === "body" || layer === "birthmark";
}

export type KnowledgeState = "knows" | "suspects" | "unaware";

export interface KnowledgeLike {
  characterId: string;
  factId: string;
  knowledge: KnowledgeState;
  revealScenePosition: number | null;
}

/**
 * واقعیت‌هایی که یک شخصیت در صحنهٔ جاری می‌تواند بداند.
 * `scenePosition` ترتیب روایت است (نه زمان داستان) و افشا را کنترل می‌کند.
 */
export function factsForCharacter(
  facts: FactLike[],
  knowledge: KnowledgeLike[],
  query: { characterId: string; scenePosition: number },
): FactLike[] {
  const map = new Map<string, KnowledgeLike>();
  for (const k of knowledge) {
    if (k.characterId !== query.characterId) continue;
    const existing = map.get(k.factId);
    if (!existing || rank(k) > rank(existing)) map.set(k.factId, k);
  }
  return facts.filter((fact) => {
    if (fact.status !== "confirmed") return false;
    const entry = map.get(fact.id);
    if (!entry) return false;
    if (entry.knowledge === "unaware") return false;
    if (entry.revealScenePosition != null && entry.revealScenePosition > query.scenePosition) return false;
    return true;
  });
}

function rank(k: KnowledgeLike): number {
  if (k.knowledge === "knows") return 3;
  if (k.knowledge === "suspects") return 2;
  return 1;
}

export interface CanonView {
  facts: FactLike[];
  resolved: Array<{
    subjectId: string;
    attribute: string;
    status: ResolveStatus;
    value: string | null;
    reason: string;
    sourceRef: string | null;
  }>;
  conflicts: FactLike[][];
  unknown: Array<{ subjectId: string; attribute: string; reason: string }>;
}

/** نمای یک صحنه برای ساخت پرامپت و نمایش به کاربر. */
export function buildCanonView(
  facts: FactLike[],
  query: { subjectIds: string[]; at: string | null },
): CanonView {
  const attributesBySubject = new Map<string, Set<string>>();
  for (const fact of facts) {
    if (!query.subjectIds.includes(fact.subjectId)) continue;
    const set = attributesBySubject.get(fact.subjectId) ?? new Set<string>();
    set.add(fact.attribute);
    attributesBySubject.set(fact.subjectId, set);
  }
  const resolved: CanonView["resolved"] = [];
  const conflicts: FactLike[][] = [];
  const unknown: CanonView["unknown"] = [];
  for (const [subjectId, attributes] of attributesBySubject) {
    for (const attribute of [...attributes].sort()) {
      const r = resolveFact(facts, { subjectId, attribute, at: query.at });
      if (r.status === "resolved" && r.chosen) {
        resolved.push({
          subjectId,
          attribute,
          status: r.status,
          value: r.chosen.value,
          reason: r.reason,
          sourceRef: r.chosen.sourceRef,
        });
      } else if (r.status === "conflict") {
        conflicts.push(r.conflicts);
        resolved.push({
          subjectId,
          attribute,
          status: "conflict",
          value: null,
          reason: r.reason,
          sourceRef: null,
        });
      } else if (attribute !== "wound") {
        // نبود واقعیت برای همهٔ ویژگی‌ها خطا نیست؛ فقط ثبت می‌شود.
        unknown.push({ subjectId, attribute, reason: r.reason });
      } else {
        unknown.push({ subjectId, attribute, reason: r.reason });
      }
    }
  }
  return { facts, resolved, conflicts, unknown };
}

/** گروه‌بندی تعارض‌ها برای نمایش در پروندهٔ جهان داستان. */
export function groupConflicts(facts: FactLike[]): Map<string, FactLike[]> {
  const map = new Map<string, FactLike[]>();
  for (const fact of facts) {
    if (fact.status !== "confirmed") continue;
    const key = `${fact.subjectId}::${fact.attribute}`;
    const list = map.get(key) ?? [];
    list.push(fact);
    map.set(key, list);
  }
  const conflicts = new Map<string, FactLike[]>();
  for (const [key, list] of map) {
    const overlapping = list.filter((fact) => inScope(fact, null) || true);
    const byScope = new Map<string, FactLike[]>();
    for (const fact of overlapping) {
      const scope = `${fact.scopeStart ?? ""}|${fact.scopeEnd ?? ""}`;
      const bucket = byScope.get(scope) ?? [];
      bucket.push(fact);
      byScope.set(scope, bucket);
    }
    for (const bucket of byScope.values()) {
      if (new Set(bucket.map((f) => f.value.trim())).size > 1) {
        conflicts.set(key, bucket);
        break;
      }
    }
  }
  return conflicts;
}

/**
 * پیشنهاد تغییر وضعیت: وقتی منبع یک پنل عوض می‌شود، پنل باید «نیازمند بازبینی»
 * شود. این تابع فقط علامت‌گذاری را محاسبه می‌کند و هرگز تصویر را بازتولید نمی‌کند.
 */
export function needsReviewAfterSourceChange(input: {
  panelUpdatedAt: string;
  sourceChangedAt: string;
  currentReviewStatus: "none" | "fresh" | "stale";
}): boolean {
  if (input.currentReviewStatus === "none") return false;
  return input.sourceChangedAt > input.panelUpdatedAt;
}
