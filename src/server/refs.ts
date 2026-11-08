/**
 * انتخاب مراجع تصویری برای یک درخواست.
 *
 * همهٔ مراجع پروژه هرگز فرستاده نمی‌شوند. فقط مراجع «تأییدشده» و مرتبط با
 * موجودیت‌های صحنه، با نقش صریح، تا سقف مدل انتخاب می‌شوند و هر موردی که
 * کنار گذاشته شد با دلیل گزارش می‌شود تا کاربر قبل از ارسال ببیند.
 */

export const REFERENCE_ROLES = [
  "identity",
  "face",
  "body",
  "clothing",
  "tool",
  "pose",
  "location",
  "style",
  "composition",
  "scale",
  "map",
  "expression",
] as const;

export type ReferenceRole = (typeof REFERENCE_ROLES)[number];

export const ROLE_LABELS: Record<ReferenceRole, string> = {
  identity: "هویت",
  face: "چهره",
  body: "بدن",
  clothing: "لباس",
  tool: "ابزار",
  pose: "ژست",
  location: "مکان",
  style: "سبک",
  composition: "ترکیب‌بندی",
  scale: "مقیاس",
  map: "نقشه",
  expression: "حالت چهره",
};

export interface RefCandidate {
  id: string;
  assetId: string;
  title: string;
  status: "draft" | "approved" | "rejected" | "archived";
  roles: string[];
  entityIds: string[];
  version: number;
  createdAt: string;
  origin: "local_upload" | "ai_output" | "imported";
  validFrom?: string | null;
  validTo?: string | null;
}

export interface SelectedRef extends RefCandidate {
  rolesForRequest: string[];
  reason: string;
}

export interface SelectionResult {
  selected: SelectedRef[];
  dropped: Array<{ ref: RefCandidate; reason: string }>;
  warnings: string[];
  slotUsage: Record<string, number>;
}

const ROLE_PRIORITY: Record<string, number> = {
  identity: 100,
  face: 90,
  body: 80,
  clothing: 70,
  location: 75,
  tool: 60,
  style: 55,
  pose: 50,
  expression: 45,
  composition: 40,
  scale: 35,
  map: 30,
};

/**
 * @param candidates مراجع پروژه
 * @param wantedRolesIfEntity نقش‌هایی که برای هر موجودیت لازم است (اولویت دارد)
 * @param limit سقف مرجع مدل (از کاتالوگ، نه حافظه)
 * @param pinned مواردی که کاربر صریحاً انتخاب کرده و باید بمانند
 */
export function selectReferences(input: {
  candidates: RefCandidate[];
  entityIds: string[];
  styleRefId?: string | null;
  limit: number;
  pinnedIds?: string[];
  wantedRoles?: ReferenceRole[];
  /** زمان داستان صحنه؛ مرجع خارج از بازهٔ اعتبار انتخاب نمی‌شود. */
  at?: string | null;
}): SelectionResult {
  const dropped: SelectionResult["dropped"] = [];
  const warnings: string[] = [];
  const pinnedOrder = [...new Set(input.pinnedIds ?? [])];
  const pinned = new Set(pinnedOrder);
  const wantedRoles = new Set<string>(input.wantedRoles ?? []);
  const temporalUnknown = input.at == null;

  const scored: Array<{ ref: RefCandidate; score: number; roles: string[]; reason: string }> = [];

  for (const ref of input.candidates) {
    if (ref.status !== "approved") {
      dropped.push({ ref, reason: "تأییدنشده؛ فقط مرجع تأییدشده در تولید استفاده می‌شود." });
      continue;
    }
    const bounded = Boolean(ref.validFrom || ref.validTo);
    if (bounded) {
      if (temporalUnknown) {
        warnings.push(`مرجع «${ref.title}» بازهٔ زمانی دارد اما تاریخ صحنه مشخص نیست؛ اعتبارش تأیید نشده است.`);
      } else {
        const start = ref.validFrom ?? null;
        const end = ref.validTo ?? null;
        const at = input.at!;
        const valid = (!start || at >= start) && (!end || at < end);
        if (!valid) {
          dropped.push({
            ref,
            reason: `بازهٔ اعتبار این مرجع شامل زمان صحنه (${at}) نیست؛ برای این صحنه انتخاب نشد.`,
          });
          continue;
        }
      }
    }
    const entityMatch = ref.entityIds.some((id) => input.entityIds.includes(id));
    const isStyle = input.styleRefId === ref.id;
    if (!entityMatch && !isStyle && !pinned.has(ref.id)) {
      dropped.push({ ref, reason: "به موجودیت‌های این صحنه یا سبک انتخاب‌شده مربوط نیست." });
      continue;
    }
    const roleScore = Math.max(0, ...ref.roles.map((r) => ROLE_PRIORITY[r] ?? 10));
    const wanted = ref.roles.filter((r) => wantedRoles.size === 0 || wantedRoles.has(r as ReferenceRole));
    let score = roleScore + (entityMatch ? 25 : 0) + (isStyle ? 30 : 0) + (pinned.has(ref.id) ? 1000 : 0);
    if (wanted.length > 0) score += 15;
    scored.push({
      ref,
      score,
      roles: ref.roles,
      reason: isStyle
        ? "مرجع سبک انتخاب‌شدهٔ پروژه"
        : pinned.has(ref.id)
          ? "انتخاب صریح کاربر"
          : `مرتبط با موجودیت صحنه (${entityMatch ? "مستقیم" : "سبک"})`,
    });
  }

  // ترتیب صریح کاربر مقدم است و همان‌طور که انتخاب کرده حفظ می‌شود؛ بقیه بر پایهٔ امتیاز.
  const pinnedRank = new Map(pinnedOrder.map((id, index) => [id, index]));
  scored.sort((a, b) => {
    const ap = pinnedRank.get(a.ref.id);
    const bp = pinnedRank.get(b.ref.id);
    if (ap != null || bp != null) {
      if (ap == null) return 1;
      if (bp == null) return -1;
      return ap - bp;
    }
    return b.score - a.score || a.ref.createdAt.localeCompare(b.ref.createdAt);
  });

  const limit = Math.max(0, input.limit);
  const selected: SelectedRef[] = [];
  const slotUsage: Record<string, number> = {};
  for (const item of scored) {
    const isPinned = pinned.has(item.ref.id);
    if (selected.length >= limit) {
      dropped.push({
        ref: item.ref,
        reason: isPinned
          ? "انتخاب شما با سقف مراجع مدل تعارض دارد؛ باید یکی را بردارید."
          : `از سقف ${limit} مرجع مدل بیشتر است.`,
      });
      if (isPinned) warnings.push(`مرجع «${item.ref.title}» با سقف مدل جا نشد.`);
      continue;
    }
    selected.push({ ...item.ref, rolesForRequest: item.roles, reason: item.reason });
    for (const role of item.roles) slotUsage[role] = (slotUsage[role] ?? 0) + 1;
  }

  // هشدارهای ساختاری هویت: نبود چهره/هویت برای شخصیت حاضر
  for (const entityId of input.entityIds) {
    const hasIdentity = selected.some((r) => r.entityIds.includes(entityId) && r.roles.includes("identity"));
    const hasFace = selected.some((r) => r.entityIds.includes(entityId) && r.roles.includes("face"));
    if (!hasIdentity && !hasFace) {
      warnings.push(`برای موجودیت ${entityId} مرجع هویت یا چهره انتخاب نشده است؛ ثبات چهره تضمین نمی‌شود.`);
    }
  }

  return { selected, dropped, warnings, slotUsage };
}

/** مجموعهٔ نقش‌های مورد انتظار بر اساس نوع موجودیت. */
export function expectedRoles(kind: "character" | "location" | "object" | "group" | "rule"): ReferenceRole[] {
  if (kind === "character") return ["identity", "face", "body", "clothing"];
  if (kind === "location") return ["location", "map", "composition"];
  if (kind === "object") return ["tool", "scale"];
  return ["style"];
}

/** مرتب‌سازی مراجع برای نمایش درخواست: نقش‌ها به ترتیب اهمیت، نه ترتیب ذخیره. */
export function describeReferenceSet(refs: SelectedRef[]): string {
  return refs
    .map((ref) => `${ref.title} [${ref.rolesForRequest.join("، ") || "بدون نقش"}]`)
    .join(" · ");
}
