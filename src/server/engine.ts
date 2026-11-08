import { planStatus } from "./chatgpt-plan";
import { assertAutomaticImages } from "./image-workflow";
import { getSetting } from "./db";
import { newId, nowIso, row, rows, run, sha256, transaction } from "./db";
import { AppError } from "./http";
import { estimateImageCost, estimateTextCost, findModel, MODELS, allModels } from "./models";
import {
  buildAdaptationPrompt,
  buildDirectorPrompt,
  buildExtractionPrompt,
  buildImagePrompt,
  buildReviewPrompt,
  buildSuggestionPrompt,
  CanonEntry,
} from "./prompts";
import { getProvider, ProviderError } from "./providers";
import { selectReferences } from "./refs";
import { getApiKey } from "./secrets";
import { readAsset, saveImage } from "./storage";
import {
  AttachmentEntry,
  assertManifestComplete,
  buildAttachmentManifest,
  loadVerifiedAttachments,
} from "./attachments";
import {
  assertBudgetAdmits,
  assertGenerationAdmission,
  assertReviewAdmission,
  chapterBudget,
  panelUsage,
} from "./caps";
import { buildKnowledgeContext, buildSceneContext, knowledgePromptLines, knowledgeSummary, scenePosition } from "./context";
import {
  buildRepairMessage,
  directorNoteSchema,
  extractionSchema,
  MAX_REPAIR_ROUNDS,
  panelProposalSchema,
  reviewResponseSchema,
  suggestionSchema,
  validateModelOutput,
} from "./validate";
import { requireProject, getScene } from "./repo/projects";
import { getPanel, markPanelStale, requirePanel, snapshotPanel } from "./repo/panels";
import type { IdentityConflict } from "./repo/world";
import { canonEntriesAt, defaultStyle, getEntity, listEntities, listStyles } from "./repo/world";
import { referenceCandidates, referencesByIds, requireReference } from "./repo/refs";
import {
  addTake,
  completeRequest,
  createRequest,
  failRequest,
  getRequest,
  markProcessing,
  markSending,
  recordAttempt,
  createReview,
} from "./repo/ai";
import { enqueueJob, setJobStatus } from "./repo/jobs";
import { getAsset } from "./storage";
import type { Job, Panel } from "@/lib/types";

/**
 * موتور تولید و اقتباس.
 *
 * قواعد ثابت این فایل:
 *  - پیش‌نمایش، پرامپت، درخواست ذخیره‌شده، کارگر و آداپتور از یک «فهرست پیوست»
 *    مرتب استفاده می‌کنند؛ ترتیب تصاویر هرگز بی‌صدا عوض نمی‌شود.
 *  - ورودی هر کار پیش از صف‌شدن «فریز» می‌شود؛ کارگر هرگز متن یا وضعیت صحنهٔ
 *    عوض‌شده را به‌جای نسخهٔ زمان ثبت، بی‌اطلاع استفاده نمی‌کند.
 *  - پذیرش درخواست (سقف پنل و بودجهٔ فصل) داخل همان تراکنش ثبت انجام می‌شود.
 *  - هر فراخوانی واقعی ارائه‌دهنده (شامل اصلاح پاسخ) ثبت می‌شود و مصرف
 *    نامشخص هرگز صفر حساب نمی‌شود.
 */

export interface PlanBudget {
  budgetUsd: number | null;
  knownUsd: number;
  reservedUsd: number;
  unknownCount: number;
  overBudget: boolean;
  policy: "block" | "allow";
  explanation: string;
}

export interface ProducePlan {
  panelId: string;
  provider: string;
  model: string;
  prompt: string;
  /** فهرست مرتب پیوست‌ها؛ همان ترتیبی که به سرویس می‌رود */
  attachments: AttachmentEntry[];
  references: Array<{ index: number; id: string; title: string; roles: string[]; entityName: string; thumbUrl: string; version: number }>;
  dropped: Array<{ title: string; reason: string }>;
  warnings: string[];
  /** مواردی که باید پیش از ارسال حل شوند (مثلاً مرجع پین‌شده‌ای که در این زمان معتبر نیست). */
  blocking: string[];
  size: string;
  aspectRatio: string;
  imageSize: string;
  costEstimate: { usd: number | null; basis: string; source?: string; kind: "estimate" };
  caps: {
    generationsPerPanel: number;
    used: number;
    inFlight: number;
    remaining: number;
    reviewsPerPanel: number;
    reviewsUsed: number;
    reviewsInFlight: number;
  };
  budget: PlanBudget;
  canon: CanonEntry[];
  conflicts: string[];
  /** تعارض نسخه‌های هویتی که در زمان صحنه معتبرند؛ تا تصمیم صریح، تولید متوقف است. */
  identityConflicts: IdentityConflict[];
  knowledge: Array<{ name: string; knows: string[]; suspects: string[]; withheld: string[] }>;
  supportsMask: boolean;
  requestKey: string;
}

export interface ProduceOptions {
  referenceIds?: string[];
  size?: string;
  aspectRatio?: string;
  imageSize?: string;
  allowedChanges?: string;
  constraints?: string;
  promptOverride?: string;
  /** کاربر تعارض نسخه‌های هویتی را دیده و صریحاً ادامه را پذیرفته است. */
  acknowledgeIdentityConflicts?: boolean;
  /** کلید همان پیش‌نمایشی که کاربر تأیید کرده؛ اگر نقشه عوض شده باشد، ارسال نمی‌شود. */
  expectedRequestKey?: string;
}

export interface EditOptions extends ProduceOptions {
  sourceTakeId: string;
  maskAssetId?: string | null;
  editKind?: "inpaint" | "refine";
  editInstruction?: string;
}

function resolveSize(provider: string, modelId: string, requested: ProduceOptions): { size: string; aspectRatio: string; imageSize: string } {
  const model = findModel(provider, modelId);
  if (!model || model.kind !== "image") {
    throw new AppError("مدل تصویر انتخاب‌شده در کاتالوگ نیست.", 400, "unknown_model", "در تنظیمات اتصال‌ها مدل تصویر را انتخاب کنید.");
  }
  if (provider === "google") {
    const imageSize = requested.imageSize || requested.size || "1K";
    if (!model.capabilities.sizes.includes(imageSize)) {
      throw new AppError(
        `اندازهٔ «${imageSize}» برای این مدل پشتیبانی نمی‌شود.`,
        400,
        "unsupported_size",
        `اندازه‌های مجاز: ${model.capabilities.sizes.join("، ")}`,
      );
    }
    const aspect = requested.aspectRatio || "9:16";
    if (!model.capabilities.aspectRatios.includes(aspect)) {
      throw new AppError(`نسبت تصویر «${aspect}» برای این مدل پشتیبانی نمی‌شود.`, 400, "unsupported_aspect");
    }
    return { size: imageSize, aspectRatio: aspect, imageSize };
  }
  const size = requested.size || "1024x1536";
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) {
    throw new AppError("اندازهٔ تصویر باید به شکل WIDTHxHEIGHT باشد.", 400, "invalid_size");
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width % 16 !== 0 || height % 16 !== 0) {
    throw new AppError("هر ضلع تصویر باید بر ۱۶ بخش‌پذیر باشد.", 400, "invalid_size");
  }
  const ratio = width / height;
  if (ratio < 1 / 3 || ratio > 3) {
    throw new AppError("نسبت تصویر باید بین ۱:۳ و ۳:۱ باشد.", 400, "invalid_size");
  }
  if (width > 3840 || height > 2160) {
    throw new AppError("اندازهٔ درخواستی از سقف مستند مدل بزرگ‌تر است.", 400, "invalid_size");
  }
  return { size, aspectRatio: requested.aspectRatio || "", imageSize: "" };
}

/** موجودیت‌های مرتبط با پنل: شخصیت‌ها، مکان و اشیای نام‌برده‌شده. */
function panelEntities(panelId: string): {
  entityIds: string[];
  characterIds: string[];
  characters: Panel["characters"];
  propText: string;
} {
  const panel = requirePanel(panelId);
  const ids = new Set<string>();
  const characterIds: string[] = [];
  const characters = panel.characters.map((c) => {
    let id = c.entityId;
    if (!id) {
      const found = listEntities(panel.projectId, "character").find((e) => e.name === c.name);
      id = found?.id ?? null;
    }
    if (id) {
      ids.add(id);
      characterIds.push(id);
    }
    return { ...c, entityId: id };
  });
  if (panel.locationId) ids.add(panel.locationId);
  // اشیای ثبت‌شده که نامشان در متن «اشیای پنل» آمده است — نه همهٔ پروژه.
  if (panel.props.trim()) {
    for (const entity of listEntities(panel.projectId, "object")) {
      if (panel.props.includes(entity.name)) ids.add(entity.id);
    }
  }
  return { entityIds: [...ids], characterIds: [...new Set(characterIds)], characters, propText: panel.props };
}

/** برنامهٔ کامل تولید یک پنل؛ پیش از ارسال به کاربر نشان داده می‌شود. */
export function planPanelProduction(projectId: string, panelId: string, options: ProduceOptions = {}): ProducePlan {
  const project = requireProject(projectId);
  const panel = requirePanel(panelId);
  if (panel.projectId !== projectId) {
    throw new AppError("پنل به این پروژه تعلق ندارد.", 404, "cross_project_access");
  }
  const scene = getScene(panel.sceneId);
  if (!scene) throw new AppError("صحنهٔ پنل پیدا نشد.", 404, "scene_missing");
  const provider = project.settings.image.provider;
  const modelId = project.settings.image.model;
  const model = findModel(provider, modelId);
  if (!model) throw new AppError("مدل تصویر انتخاب‌شده در کاتالوگ نیست.", 400, "unknown_model");
  const { size, aspectRatio, imageSize } = resolveSize(provider, modelId, options);

  const { entityIds, characterIds, characters: panelCharacters } = panelEntities(panelId);  const pinned = options.referenceIds?.length ? options.referenceIds : panel.referencesUsed;
  const entityName = (id: string) => getEntity(id)?.name ?? "";
  const selection = selectReferences({
    candidates: referenceCandidates(projectId),
    entityIds,
    styleRefId: panel.styleProfileId,
    limit: Math.min(model.capabilities.maxReferenceImages, 12),
    pinnedIds: pinned,
    at: scene.storyDate,
  });

  // فهرست پیوست واحد: ترتیب انتخاب‌شده حفظ می‌شود و مرجع مشکل‌دار خطا می‌دهد.
  const manifest = buildAttachmentManifest({
    ids: selection.selected.map((ref) => ref.id),
    refs: selection.selected,
    limit: Math.min(model.capabilities.maxReferenceImages, 12),
    entityName,
  });
  if (pinned.length && manifest.problems.length) {
    assertManifestComplete(manifest);
  }

  /*
   * مرجع‌هایی که کاربر صریحاً پین کرده اما در زمان داستان این صحنه معتبر
   * نیستند، بی‌صدا حذف نمی‌شوند: مجموعهٔ ورودی ناقص است و باید تصمیم بگیرید.
   */
  const pinnedDropped = selection.dropped.filter((item) => pinned.includes(item.ref.id));
  const blocking = pinnedDropped.map(
    (item) => `مرجع پین‌شدهٔ «${item.ref.title}» برای این صحنه قابل استفاده نیست: ${item.reason}`,
  );

  const style =
    (panel.styleProfileId ? listStyles(projectId).find((s) => s.id === panel.styleProfileId) : null) ?? defaultStyle(projectId);
  const canon = canonEntriesAt(projectId, { storyDate: scene.storyDate, entityIds });
  const knowledge = buildKnowledgeContext(projectId, panel.sceneId, characterIds);
  const knowledgeLines = knowledgePromptLines(knowledge);

  const characters = panelCharacters.map((c) => {
    const own = canon.entries.filter((e) => e.status === "resolved" && e.subject === c.name);
    const attached = manifest.entries.filter((entry) => c.entityId != null && entry.entityIds.includes(c.entityId));
    return {
      name: c.name,
      position: c.position,
      gaze: c.gaze,
      emotion: c.emotion,
      clothing:
        c.clothing ||
        own
          .filter((e) => /لباس|پوشاک|یونیفرم|زره|clothing|outfit/i.test(e.attribute))
          .map((e) => e.value)
          .join("؛ "),
      identity: [c.identityNote, ...own.filter((e) => /هویت|چهره|face|identity|نشانه/i.test(e.attribute)).map((e) => e.value)]
        .filter(Boolean)
        .join("؛ "),
      referenceIds: attached.map((entry) => entry.referenceId),
    };
  });

  const prompt =
    options.promptOverride?.trim() ||
    buildImagePrompt({
      sceneTitle: scene.title,
      storyDate: scene.storyDate,
      isFlashback: scene.isFlashback,
      action: panel.action,
      narrativeGoal: panel.narrativeGoal,
      shotSize: panel.shotSize,
      cameraAngle: panel.cameraAngle,
      gazeDirection: panel.gazeDirection,
      movement: panel.movement,
      emotion: panel.emotion,
      lighting: panel.lighting,
      location: panel.locationId ? getEntity(panel.locationId)?.name ?? "" : "",
      timeLabel: panel.timeLabel,
      characters,
      props: panel.props,
      canon: canon.entries,
      style: style ? [style.name, style.description, style.linework, style.palette].filter(Boolean).join("؛ ") : "",
      // همان ترتیب manifest: «image 1..N» با بایت‌های ارسالی یکی است.
      references: manifest.entries.map((entry) => ({
        id: entry.referenceId,
        title: entry.referenceTitle,
        roles: entry.roles,
        entityName: entry.entityName,
      })),
      allowedChanges: options.allowedChanges ?? "",
      constraints: options.constraints ?? "",
      readingDirection: project.settings.readingOrder,
      knowledgeNotes: knowledgeLines,
    });

  const usage = panelUsage(panelId);
  const estimate = estimateImageCost(modelId, provider === "google" ? imageSize : size);
  const budget = chapterBudget(projectId, panel.sceneId);
  const requestKey = sha256(
    JSON.stringify({
      panelId,
      provider,
      modelId,
      prompt,
      size,
      aspectRatio,
      imageSize,
      attachments: manifest.entries.map((entry) => [entry.index, entry.referenceId, entry.assetSha256, entry.roles]),
    }),
  ).slice(0, 32);

  return {
    panelId,
    provider,
    model: modelId,
    prompt,
    attachments: manifest.entries,
    references: manifest.entries.map((entry) => ({
      index: entry.index,
      id: entry.referenceId,
      title: entry.referenceTitle,
      roles: entry.roles,
      entityName: entry.entityName,
      thumbUrl: `/api/assets/${entry.assetId}?variant=thumb`,
      version: entry.referenceVersion,
    })),
    dropped: selection.dropped.map((d) => ({ title: d.ref.title, reason: d.reason })),
    warnings: [...selection.warnings, ...manifest.problems.map((p) => p.reason)],
    blocking,
    size,
    aspectRatio,
    imageSize,
    costEstimate: { ...estimate, kind: "estimate" },
    caps: {
      generationsPerPanel: project.settings.caps.generationsPerPanel,
      used: usage.takes,
      inFlight: usage.active,
      remaining: Math.max(0, project.settings.caps.generationsPerPanel - usage.admitted),
      reviewsPerPanel: project.settings.caps.reviewsPerPanel,
      reviewsUsed: usage.reviews,
      reviewsInFlight: usage.activeReviews,
    },
    budget: {
      budgetUsd: budget.budgetUsd,
      knownUsd: budget.knownUsd,
      reservedUsd: budget.reservedUsd,
      unknownCount: budget.unknownCount,
      overBudget: budget.overBudget,
      policy: budget.policy,
      explanation: budget.explanation,
    },
    canon: canon.entries,
    conflicts: canon.conflicts,
    identityConflicts: canon.identityConflicts,
    knowledge: knowledgeSummary(knowledge),
    supportsMask: model.capabilities.mask,
    requestKey,
  };
}

export interface QueuedProduction {
  job: Job;
  requestId: string;
  plan: ProducePlan;
  referenceProblems: string[];
}

/** ثبت درخواست تولید؛ سقف و بودجه در همان تراکنش رزرو می‌شوند. */
export function enqueuePanelImage(projectId: string, panelId: string, options: ProduceOptions = {}): QueuedProduction {
  assertAutomaticImages();
  const plan = planPanelProduction(projectId, panelId, options);
  const project = requireProject(projectId);
  const panel = requirePanel(panelId);
  /*
   * «همان طرحی که دید»: اگر کاربر پیش‌نمایش را با اندازه/محدودیت‌های دیگر دیده
   * باشد، ارسال با کلید قدیمی رد می‌شود؛ همیشه چیزی فرستاده می‌شود که در همان
   * لحظه در پیش‌نمایش دیده شده است.
   */
  if (options.expectedRequestKey && options.expectedRequestKey !== plan.requestKey) {
    throw new AppError(
      "پیش‌نمایش با ورودی‌های فعلی هم‌خوان نیست.",
      409,
      "plan_outdated",
      "اندازه، مراجع یا گزینه‌ها تغییر کرده‌اند. پیش‌نمایش تازه ساخته شد؛ یک بار دیگر بررسی و تأیید کنید.",
    );
  }
  if (plan.identityConflicts.length && !options.acknowledgeIdentityConflicts) {
    throw new AppError(
      "برای این صحنه چند نسخهٔ هویتی تأییدشده و هم‌زمان وجود دارد.",
      409,
      "identity_conflict_unresolved",
      plan.identityConflicts
        .map(
          (conflict) =>
            `${conflict.entityName} (${conflict.layer}): ${conflict.candidates
              .map((c) => c.label || c.id.slice(0, 8))
              .join(" / ")} — پیش از تولید یکی را تأیید کنید یا صریحاً ادامه را بپذیرید.`,
        )
        .join(" · "),
    );
  }
  if (plan.blocking.length) {
    throw new AppError(
      "مجموعهٔ مراجع انتخاب‌شده برای این صحنه سازگار نیست.",
      409,
      "reference_set_blocked",
      plan.blocking.join(" · "),
    );
  }
  assertBudgetAdmits(projectId, panel.sceneId, plan.costEstimate.usd);

  const requestId = transaction(() => {
    assertGenerationAdmission(projectId, panelId);
    const request = createRequest({
      projectId,
      panelId,
      role: "prompt_writer",
      provider: plan.provider,
      model: plan.model,
      promptVersion: null,
      promptText: plan.prompt,
      inputs: {
        kind: "image",
        attachments: plan.attachments,
        references: plan.references,
        size: plan.size,
        aspectRatio: plan.aspectRatio,
        imageSize: plan.imageSize,
        canon: plan.canon,
        conflicts: plan.conflicts,
        identityConflicts: plan.identityConflicts,
        identityConflictAcknowledged: Boolean(options.acknowledgeIdentityConflicts && plan.identityConflicts.length),
        knowledge: plan.knowledge,
        readingOrder: project.settings.readingOrder,
        requestKey: plan.requestKey,
      },
      requestKey: plan.requestKey,
      costEstimate: plan.costEstimate,
    });
    snapshotPanel(panel, "produce-request");
    run(
      "UPDATE panels SET references_used = ?, identity_snapshot = ?, updated_at = ? WHERE id = ?",
      JSON.stringify(plan.attachments.map((a) => a.referenceId)),
      JSON.stringify({
        attachments: plan.attachments,
        canon: plan.canon,
        knowledge: plan.knowledge,
        model: plan.model,
        provider: plan.provider,
        size: plan.size,
        requestId: request.id,
        capturedAt: nowIso(),
      }),
      nowIso(),
      panelId,
    );
    return request.id;
  });

  const job = enqueueJob({
    projectId,
    type: "panel_image",
    payload: { panelId, requestId },
    dedupeKey: `panel_image:${plan.requestKey}`,
    requestId,
    maxAttempts: 1,
  });
  return { job, requestId, plan, referenceProblems: [] };
}

/**
 * اصلاح ناحیه‌ای یک خروجی با ماسک.
 * خروجی مبدأ دست‌نخورده می‌ماند و خروجی تازه به آن و به ماسک گره می‌خورد.
 */
export function enqueuePanelEdit(projectId: string, panelId: string, options: EditOptions): QueuedProduction {
  assertAutomaticImages();
  const project = requireProject(projectId);
  const panel = requirePanel(panelId);
  if (panel.projectId !== projectId) throw new AppError("پنل به این پروژه تعلق ندارد.", 404, "cross_project_access");
  const provider = project.settings.image.provider;
  const modelId = project.settings.image.model;
  const model = findModel(provider, modelId);
  if (!model) throw new AppError("مدل تصویر انتخاب‌شده در کاتالوگ نیست.", 400, "unknown_model");
  if (!model.capabilities.mask) {
    throw new AppError(
      "مدل انتخاب‌شده ویرایش ناحیه‌ای با ماسک را پشتیبانی نمی‌کند.",
      400,
      "mask_unsupported",
      "مدلی با پشتیبانی ماسک انتخاب کنید. این عملیات فقط برای مدل‌های بدون پشتیبانی غیرفعال است.",
    );
  }
  const take = row("SELECT * FROM image_takes WHERE id = ? AND panel_id = ?", options.sourceTakeId, panelId);
  if (!take) throw new AppError("خروجی مبدأ پیدا نشد.", 404, "take_missing");
  const sourceAsset = getAsset(String(take.asset_id));
  if (!sourceAsset) throw new AppError("فایل خروجی مبدأ پیدا نشد.", 404, "asset_missing");

  let maskAssetId: string | null = null;
  if (options.maskAssetId) {
    const mask = getAsset(options.maskAssetId);
    if (!mask) throw new AppError("فایل ماسک پیدا نشد.", 404, "asset_missing");
    if (!["image/png", "image/webp"].includes(mask.mime)) {
      throw new AppError("ماسک باید PNG یا WebP باشد.", 400, "invalid_mask");
    }
    if (sourceAsset.width && sourceAsset.height && mask.width && mask.height) {
      if (sourceAsset.width !== mask.width || sourceAsset.height !== mask.height) {
        throw new AppError(
          `ابعاد ماسک (${mask.width}×${mask.height}) با خروجی مبدأ (${sourceAsset.width}×${sourceAsset.height}) یکسان نیست.`,
          400,
          "mask_size_mismatch",
          "ماسک را با همان ابعاد تصویر مبدأ بسازید.",
        );
      }
    }
    maskAssetId = mask.id;
  }
  if ((options.editKind ?? "inpaint") === "inpaint" && !maskAssetId) {
    throw new AppError("برای اصلاح ناحیه‌ای، ماسک لازم است.", 400, "mask_required", "ماسک PNG هم‌اندازه با تصویر مبدأ بارگذاری کنید.");
  }

  const plan = planPanelProduction(projectId, panelId, options);
  const instruction = options.editInstruction?.trim() || "Only change the masked area; keep identity, style and everything else identical.";
  const prompt = `${plan.prompt}\n\nEDIT INSTRUCTION: ${instruction}`;
  const estimate = plan.costEstimate;
  assertBudgetAdmits(projectId, panel.sceneId, estimate.usd);

  const requestId = transaction(() => {
    assertGenerationAdmission(projectId, panelId);
    const request = createRequest({
      projectId,
      panelId,
      role: "prompt_writer",
      provider,
      model: modelId,
      promptVersion: null,
      promptText: prompt,
      inputs: {
        kind: "edit",
        editKind: options.editKind ?? "inpaint",
        sourceTakeId: options.sourceTakeId,
        sourceAssetId: sourceAsset.id,
        sourceSha256: sourceAsset.sha256,
        maskAssetId,
        instruction,
        attachments: plan.attachments,
        size: plan.size,
        aspectRatio: plan.aspectRatio,
        imageSize: plan.imageSize,
        requestKey: plan.requestKey,
      },
      requestKey: sha256(`${plan.requestKey}:${options.sourceTakeId}:${maskAssetId ?? ""}`).slice(0, 32),
      costEstimate: estimate,
    });
    return request.id;
  });

  const job = enqueueJob({
    projectId,
    type: "panel_edit",
    payload: { panelId, requestId },
    dedupeKey: `panel_edit:${requestId}`,
    requestId,
    maxAttempts: 1,
  });
  return { job, requestId, plan, referenceProblems: [] };
}

export function enqueueReview(projectId: string, panelId: string, takeId?: string): { job: Job; requestId: string } {
  const project = requireProject(projectId);
  const panel = requirePanel(panelId);
  if (panel.projectId !== projectId) throw new AppError("پنل به این پروژه تعلق ندارد.", 404, "cross_project_access");
  const take = takeId ? row("SELECT * FROM image_takes WHERE id = ? AND panel_id = ?", takeId, panelId) : null;
  const imageAssetId = take ? String(take.asset_id) : panel.imageAssetId ?? "";
  if (!imageAssetId) {
    throw new AppError("برای بازبینی، نخست یک تصویر را به‌عنوان خروجی بپذیرید.", 400, "no_image");
  }
  const imageAsset = getAsset(imageAssetId);
  if (!imageAsset) throw new AppError("فایل تصویر بازبینی پیدا نشد.", 404, "asset_missing");

  const scene = getScene(panel.sceneId);
  const { entityIds, characterIds } = (() => {
    const info = panelEntities(panelId);
    return { entityIds: info.entityIds, characterIds: info.characterIds };
  })();
  const canon = canonEntriesAt(projectId, { storyDate: scene?.storyDate ?? null, entityIds });
  const knowledge = buildKnowledgeContext(projectId, panel.sceneId, characterIds);
  const entityName = (id: string) => getEntity(id)?.name ?? "";
  const manifest = buildAttachmentManifest({
    ids: panel.referencesUsed,
    refs: referencesByIds(panel.referencesUsed),
    limit: 12,
    entityName,
  });
  const neighbors = rows(
    "SELECT position, action FROM panels WHERE scene_id = ? AND position IN (?, ?) ORDER BY position",
    panel.sceneId,
    Math.max(1, panel.position - 1),
    panel.position + 1,
  )
    .map((n) => `پنل ${String(n.position)}: ${String(n.action).slice(0, 140)}`)
    .join("\n");
  const prompt = buildReviewPrompt({
    sceneState: JSON.stringify({
      scene: scene?.title,
      storyDate: scene?.storyDate,
      isFlashback: scene?.isFlashback,
      action: panel.action,
      characters: panel.characters,
      shotSize: panel.shotSize,
      cameraAngle: panel.cameraAngle,
      dialogue: panel.dialogue,
      knowledge: knowledgeSummary(knowledge),
    }),
    canon: canon.entries,
    references: manifest.entries.map((entry) => ({ title: entry.referenceTitle, roles: entry.roles })),
    neighborNotes: neighbors,
  });
  const provider = getSetting("analysisSource") === "chatgpt" ? "chatgpt" : project.settings.text.provider;
  const model = provider === "chatgpt" && getSetting("analysisSource") === "chatgpt" ? (getSetting("chatgptModel") || "") : project.settings.text.model;
  const textModel = findModel(provider, model);
  if (!textModel || textModel.kind !== "text") {
    throw new AppError("مدل متنی انتخاب‌شده در کاتالوگ نیست.", 400, "unknown_model");
  }
  const estimate = estimateTextRequest(model, `${prompt.system}\n${prompt.user}`.length, 2048);
  if (provider !== "chatgpt") assertBudgetAdmits(projectId, panel.sceneId, estimate.usd);

  const requestId = transaction(() => {
    assertReviewAdmission(projectId, panelId);
    const request = createRequest({
      projectId,
      panelId,
      role: "image_reviewer",
      provider,
      model,
      promptVersion: prompt.version,
      promptText: `${prompt.system}\n\n${prompt.user}`,
      inputs: {
        kind: "review",
        imageAssetId,
        imageSha256: imageAsset.sha256,
        attachments: manifest.entries,
        promptSystem: prompt.system,
        promptUser: prompt.user,
        canon: canon.entries,
        knowledge: knowledgeSummary(knowledge),
        takeId: take ? String(take.id) : null,
      },
      requestKey: sha256(JSON.stringify({ panelId, imageAssetId, imageSha256: imageAsset.sha256, model, v: 2 })).slice(0, 32),
      costEstimate: estimate,
    });
    return request.id;
  });
  const job = enqueueJob({
    projectId,
    type: "image_review",
    payload: { panelId, requestId },
    dedupeKey: `image_review:${requestId}`,
    requestId,
    maxAttempts: 2,
  });
  return { job, requestId };
}

export interface AdaptationSnapshot {
  sceneId: string;
  sceneVersionId: string | null;
  textHash: string;
  capturedAt: string;
  presentEntities: string[];
  locationId: string | null;
}

/** اقتباس با «فریز» کامل ورودی؛ کارگر هرگز متن تازه‌تر را بی‌اطلاع جایگزین نمی‌کند. */
export function enqueueAdaptation(
  projectId: string,
  sceneId: string,
  options: { panelTarget?: number } = {},
): { job: Job; requestId: string; snapshot: AdaptationSnapshot } {
  const project = requireProject(projectId);
  const scene = getScene(sceneId);
  if (!scene) throw new AppError("صحنه پیدا نشد.", 404, "scene_missing");
  if (scene.projectId !== projectId) throw new AppError("صحنه به این پروژه تعلق ندارد.", 404, "cross_project_access");
  const provider = getSetting("analysisSource") === "chatgpt" ? "chatgpt" : project.settings.text.provider;
  const model = provider === "chatgpt" && getSetting("analysisSource") === "chatgpt" ? (getSetting("chatgptModel") || "") : project.settings.text.model;
  const textModel = findModel(provider, model);
  if (!textModel || textModel.kind !== "text") {
    throw new AppError("مدل متنی انتخاب‌شده در کاتالوگ نیست.", 400, "unknown_model");
  }

  const stateRow = row("SELECT * FROM scene_state WHERE scene_id = ?", sceneId);
  const presentEntities = stateRow ? (JSON.parse(String(stateRow.present_entities ?? "[]")) as string[]) : [];
  const locationId = stateRow?.location_id ? String(stateRow.location_id) : null;
  const characterIds = presentEntities.filter((id) => getEntity(id)?.kind === "character");
  const context = buildSceneContext({ projectId, sceneId, characterIds, locationId });
  const panelTarget = options.panelTarget ?? project.settings.adaptation.panelsPerScene;
  const prompt = buildAdaptationPrompt(
    {
      sceneTitle: scene.title,
      sceneText: scene.text,
      storyDate: scene.storyDate,
      isFlashback: scene.isFlashback,
      canon: context.canon.entries,
      characters: context.characterIds.map((id) => ({
        id,
        name: getEntity(id)?.name ?? "",
        note: getEntity(id)?.summary ?? "",
      })),
      location: locationId ? getEntity(locationId)?.name ?? "" : "",
      style: defaultStyle(projectId)?.name ?? "",
      knowledge: knowledgePromptLines(context.knowledge),
    },
    panelTarget,
  );
  const estimate = estimateTextRequest(model, `${prompt.system}\n${prompt.user}`.length, 6000);
  if (provider !== "chatgpt") assertBudgetAdmits(projectId, sceneId, estimate.usd);
  const textHash = sha256(scene.text);
  const snapshot: AdaptationSnapshot = {
    sceneId,
    sceneVersionId: scene.currentVersionId,
    textHash,
    capturedAt: nowIso(),
    presentEntities,
    locationId,
  };

  const request = createRequest({
    projectId,
    panelId: null,
    role: "adaptation",
    provider,
    model,
    promptVersion: prompt.version,
    promptText: `${prompt.system}\n\n${prompt.user}`,
    inputs: {
      kind: "adaptation",
      sceneId,
      sceneVersionId: scene.currentVersionId,
      textHash,
      sceneText: scene.text,
      sceneTitle: scene.title,
      storyDate: scene.storyDate,
      isFlashback: scene.isFlashback,
      panelTarget,
      presentEntities,
      locationId,
      canon: context.canon.entries,
      knowledge: knowledgeSummary(context.knowledge),
      promptSystem: prompt.system,
      promptUser: prompt.user,
      capturedAt: snapshot.capturedAt,
    },
    requestKey: sha256(JSON.stringify({ sceneId, textHash, model, panelTarget, v: 2 })).slice(0, 32),
    costEstimate: estimate,
  });
  const job = enqueueJob({
    projectId,
    type: "adaptation",
    payload: { sceneId, requestId: request.id },
    dedupeKey: `adaptation:${request.id}`,
    requestId: request.id,
    maxAttempts: 2,
  });
  return { job, requestId: request.id, snapshot };
}

export type AssistantKind = "extract" | "suggest" | "director";

/** دستیارهای نویسنده/کارگردان: پیشنهاد می‌سازند، چیزی را خودکار تغییر نمی‌دهند. */
export function enqueueAssistant(
  projectId: string,
  sceneId: string,
  kind: AssistantKind,
  options: { panelTarget?: number } = {},
): { job: Job; requestId: string; preview: string } {
  const project = requireProject(projectId);
  const scene = getScene(sceneId);
  if (!scene) throw new AppError("صحنه پیدا نشد.", 404, "scene_missing");
  if (scene.projectId !== projectId) throw new AppError("صحنه به این پروژه تعلق ندارد.", 404, "cross_project_access");
  const provider = getSetting("analysisSource") === "chatgpt" ? "chatgpt" : project.settings.text.provider;
  const model = provider === "chatgpt" && getSetting("analysisSource") === "chatgpt" ? (getSetting("chatgptModel") || "") : project.settings.text.model;
  if (!findModel(provider, model)) throw new AppError("مدل متنی انتخاب‌شده در کاتالوگ نیست.", 400, "unknown_model");

  const textHash = sha256(scene.text);
  let prompt: { system: string; user: string; version: number };
  let role: string;
  let maxTokens = 4000;
  if (kind === "extract") {
    prompt = buildExtractionPrompt(scene.text);
    role = "extractor";
  } else if (kind === "suggest") {
    prompt = buildSuggestionPrompt(scene.text);
    role = "scene_editor";
    maxTokens = 3000;
  } else {
    const panels = rows("SELECT position, shot_size, camera_angle, action, gaze_direction FROM panels WHERE scene_id = ? ORDER BY position", sceneId);
    if (panels.length === 0) throw new AppError("برای پیشنهاد کارگردانی، نخست چند پنل بسازید.", 400, "no_panels");
    prompt = buildDirectorPrompt({
      sceneTitle: scene.title,
      panels: panels.map((p) => ({
        index: Number(p.position),
        shot: String(p.shot_size ?? ""),
        angle: String(p.camera_angle ?? ""),
        action: String(p.action ?? ""),
        gaze: String(p.gaze_direction ?? ""),
        hasBalloonSpace: "",
      })),
    });
    role = "director";
    maxTokens = 2500;
  }
  const estimate = estimateTextRequest(model, `${prompt.system}\n${prompt.user}`.length, maxTokens);
  if (provider !== "chatgpt") assertBudgetAdmits(projectId, sceneId, estimate.usd);
  const request = createRequest({
    projectId,
    panelId: null,
    role,
    provider,
    model,
    promptVersion: prompt.version,
    promptText: `${prompt.system}\n\n${prompt.user}`,
    inputs: {
      kind,
      sceneId,
      sceneVersionId: scene.currentVersionId,
      textHash,
      sceneText: scene.text,
      promptSystem: prompt.system,
      promptUser: prompt.user,
    },
    requestKey: sha256(JSON.stringify({ kind, sceneId, textHash, model, v: 2 })).slice(0, 32),
    costEstimate: estimate,
  });
  const job = enqueueJob({
    projectId,
    type: kind === "extract" ? "scene_extract" : kind === "suggest" ? "scene_suggest" : "director_notes",
    payload: { sceneId, requestId: request.id, kind },
    dedupeKey: `${kind}:${request.id}`,
    requestId: request.id,
    maxAttempts: 2,
  });
  return { job, requestId: request.id, preview: prompt.system.split("\n")[0] };
}

export interface JobResult {
  ok: boolean;
  message?: string;
}

function jobIsActive(jobId: string): boolean {
  const found = row("SELECT status FROM jobs WHERE id = ?", jobId);
  return found ? ["sending", "processing"].includes(String(found.status)) : false;
}

function appendRequestNote(requestId: string, note: string): void {
  run(
    "UPDATE ai_requests SET note = CASE WHEN note = '' THEN ? ELSE note || ' · ' || ? END, updated_at = ? WHERE id = ?",
    note.slice(0, 500),
    note.slice(0, 500),
    nowIso(),
    requestId,
  );
}

/** اجرای یک کار. خطاها به وضعیت صف نگاشت می‌شوند و هرگز به حلقهٔ بی‌پایان تبدیل نمی‌شوند. */
export async function runJob(job: Job, payload: Record<string, unknown>): Promise<JobResult> {
  const project = requireProject(job.projectId);
  const requestId = String(payload.requestId ?? "");
  const request = requestId ? getRequest(requestId) : null;
  const providerId = request?.provider ?? project.settings.image.provider;
  const modelId = request?.model ?? project.settings.image.model;
  const apiKey = providerId === "chatgpt" ? (planStatus().sharing ? "chatgpt-plan-session" : null) : getApiKey(providerId as "openai" | "google");
  if (!apiKey) {
    failRequest(requestId, { status: "failed", code: "no_key", message: "اتصال انتخاب‌شده آماده نیست؛ کلید API یا ورود و مجوز اشتراک ChatGPT را در تنظیمات بررسی کنید." });
    setJobStatus(job.id, "failed", { errorCode: "no_key", errorMessage: "کلید API تنظیم نشده است." });
    return { ok: false, message: "کلید API تنظیم نشده است." };
  }
  const provider = getProvider(providerId);
  markSending(requestId);
  setJobStatus(job.id, "sending");

  try {
    if (job.type === "panel_image" || job.type === "panel_edit") {
      assertAutomaticImages();
      const panel = requirePanel(String(payload.panelId));
      if (panel.projectId !== job.projectId) throw new AppError("پنل به این پروژه تعلق ندارد.", 404, "cross_project_access");
      markProcessing(requestId);
      setJobStatus(job.id, "processing");
      const inputs = (request?.inputs ?? {}) as Record<string, unknown>;
      const attachments = Array.isArray(inputs.attachments) ? (inputs.attachments as AttachmentEntry[]) : [];
      // بایت‌های واقعی فایل همین حالا خوانده، هش و سنجیده می‌شوند و همان‌ها ارسال می‌شوند.
      const verified = loadVerifiedAttachments(attachments);
      const images = verified.map(({ entry, asset, buffer }) => ({
        mime: asset.mime,
        base64: buffer.toString("base64"),
        label: `image ${entry.index}: ${entry.referenceTitle}`,
      }));

      let source: { mime: string; base64: string } | undefined;
      let mask: { mime: string; base64: string } | undefined;
      if (job.type === "panel_edit") {
        const sourceAssetId = String(inputs.sourceAssetId ?? "");
        const sourceFile = readAsset(sourceAssetId);
        if (inputs.sourceSha256 && sourceFile.asset.sha256 !== String(inputs.sourceSha256)) {
          throw new AppError("خروجی مبدأ پس از ثبت درخواست تغییر کرده است.", 409, "source_changed", "درخواست اصلاح را دوباره بسازید.");
        }
        source = { mime: sourceFile.asset.mime, base64: sourceFile.buffer.toString("base64") };
        if (inputs.maskAssetId) {
          const maskFile = readAsset(String(inputs.maskAssetId));
          mask = { mime: maskFile.asset.mime, base64: maskFile.buffer.toString("base64") };
        }
      }

      const started = Date.now();
      const result = await provider.generateImage(
        {
          model: modelId,
          prompt: request?.promptText ?? "",
          images: source ? [source] : images,
          mask,
          size: inputs.size ? String(inputs.size) : undefined,
          aspectRatio: inputs.aspectRatio ? String(inputs.aspectRatio) : undefined,
          imageSize: inputs.imageSize ? String(inputs.imageSize) : undefined,
          n: 1,
        },
        apiKey,
      );
      const takeIds: string[] = [];
      result.images.forEach((image, index) => {
        const buffer = Buffer.from(image.base64, "base64");
        const asset = saveImage({
          buffer,
          filename: `panel-${panel.position}-${Date.now()}.${image.mime.includes("jpeg") ? "jpg" : "png"}`,
          mime: image.mime,
          kind: "panel",
        });
        const take = addTake({
          panelId: panel.id,
          requestId,
          assetId: asset.id,
          variant: index,
          seed: result.seed,
          meta: {
            provider: providerId,
            model: modelId,
            size: inputs.size ?? inputs.imageSize,
            attachments: attachments.map((a) => ({ index: a.index, referenceId: a.referenceId, assetSha256: a.assetSha256 })),
          },
          sourceTakeId: inputs.sourceTakeId ? String(inputs.sourceTakeId) : null,
          maskAssetId: inputs.maskAssetId ? String(inputs.maskAssetId) : null,
          editKind: inputs.editKind ? String(inputs.editKind) : null,
        });
        takeIds.push(take.id);
      });
      const cost = computeImageCost(modelId, inputs, result.imageOutputTokens, null, null);
      recordAttempt({
        requestId,
        attempt: job.attempts + 1,
        status: "succeeded",
        httpStatus: 200,
        tokensIn: null,
        tokensOut: result.imageOutputTokens,
        durationMs: Date.now() - started,
      });
      if (!jobIsActive(job.id)) {
        // نتیجهٔ دیررس پس از لغو محلی: خروجی و مصرف واقعی نگه داشته می‌شود.
        run(
          "UPDATE ai_requests SET cost_computed = ?, cost_reported = ?, raw_response = ?, parsed = ? WHERE id = ?",
          JSON.stringify(cost),
          JSON.stringify({ usd: result.reportedCostUsd }),
          JSON.stringify(result.raw ?? null).slice(0, 400_000),
          JSON.stringify({ takeIds, late: true }),
          requestId,
        );
        appendRequestNote(requestId, "نتیجهٔ دیررس پس از لغو محلی دریافت شد؛ مصرف ثبت شد.");
        return { ok: false, message: "کار لغو شده بود؛ نتیجهٔ دیررس ثبت شد." };
      }
      completeRequest(requestId, {
        raw: result.raw,
        parsed: { takeIds },
        providerRequestId: result.providerRequestId,
        httpStatus: 200,
        costReported: { usd: result.reportedCostUsd },
        costComputed: cost,
      });
      setJobStatus(job.id, "succeeded");
      return { ok: true };
    }

    if (job.type === "image_review") {
      const panel = requirePanel(String(payload.panelId));
      if (panel.projectId !== job.projectId) throw new AppError("پنل به این پروژه تعلق ندارد.", 404, "cross_project_access");
      const inputs = (request?.inputs ?? {}) as Record<string, unknown>;
      const imageAssetId = String(inputs.imageAssetId ?? "");
      const { asset, buffer } = readAsset(imageAssetId);
      if (inputs.imageSha256 && asset.sha256 !== String(inputs.imageSha256)) {
        throw new AppError(
          "تصویر مورد بازبینی پس از ثبت درخواست تغییر کرده است.",
          409,
          "image_changed",
          "بازبینی را برای خروجی فعلی دوباره درخواست کنید.",
        );
      }
      const attachments = Array.isArray(inputs.attachments) ? (inputs.attachments as AttachmentEntry[]) : [];
      const refImages = loadVerifiedAttachments(attachments).map(({ asset: refAsset, buffer: refBuffer }) => ({
        mime: refAsset.mime,
        base64: refBuffer.toString("base64"),
      }));
      const visualInputs = [{ mime: asset.mime, base64: buffer.toString("base64") }, ...refImages];
      const system = String(inputs.promptSystem ?? "");
      const user = String(inputs.promptUser ?? "");
      markProcessing(requestId);
      setJobStatus(job.id, "processing");

      const firstStarted = Date.now();
      const first = await provider.analyze({ model: modelId, system, user, images: visualInputs, maxOutputTokens: 2048 }, apiKey);
      recordAttempt({
        requestId,
        attempt: job.attempts + 1,
        status: "response_received",
        httpStatus: 200,
        tokensIn: first.tokensIn,
        tokensOut: first.tokensOut,
        durationMs: Date.now() - firstStarted,
      });
      // مصرف هر فراخوانی جدا ثبت می‌شود و جمع هزینه‌ها با هم گزارش می‌شود.
      const calls = [{ tokensIn: first.tokensIn, tokensOut: first.tokensOut, reported: first.reportedCostUsd }];
      let validation = validateModelOutput(first.text, reviewResponseSchema);
      let repairText: string | null = null;

      if (!validation.ok && MAX_REPAIR_ROUNDS > 0) {
        // اصلاح با همان تصاویر و پاسخ نامعتبر انجام می‌شود، نه بدون آن‌ها.
        const repairStarted = Date.now();
        const repair = await provider.analyze(
          {
            model: modelId,
            system,
            user: `${user}\n\n${buildRepairMessage(validation.errors, first.text)}`,
            images: visualInputs,
            maxOutputTokens: 2048,
          },
          apiKey,
        );
        repairText = repair.text;
        calls.push({ tokensIn: repair.tokensIn, tokensOut: repair.tokensOut, reported: repair.reportedCostUsd });
        recordAttempt({
          requestId,
          attempt: job.attempts + 1,
          status: "repair_call",
          httpStatus: 200,
          tokensIn: repair.tokensIn,
          tokensOut: repair.tokensOut,
          durationMs: Date.now() - repairStarted,
        });
        validation = validateModelOutput(repair.text, reviewResponseSchema);
      }

      const cost = computeTextCallsCost(modelId, calls);
      if (!validation.ok || !validation.value) {
        failRequest(requestId, {
          status: "failed",
          code: "invalid_response",
          message: `پاسخ مدل با ساختار بازبینی سازگار نبود: ${validation.errors.join("؛ ")}`,
        });
        run(
          "UPDATE ai_requests SET cost_computed = ?, raw_response = ?, validation_errors = ? WHERE id = ?",
          JSON.stringify(cost),
          JSON.stringify({ first: first.raw, repair: repairText }).slice(0, 400_000),
          JSON.stringify(validation.errors),
          requestId,
        );
        setJobStatus(job.id, "failed", { errorCode: "invalid_response", errorMessage: validation.errors.join("؛ ") });
        return { ok: false };
      }
      if (!jobIsActive(job.id)) {
        run(
          "UPDATE ai_requests SET cost_computed = ?, parsed = ?, raw_response = ? WHERE id = ?",
          JSON.stringify(cost),
          JSON.stringify(validation.value),
          JSON.stringify(first.raw).slice(0, 400_000),
          requestId,
        );
        appendRequestNote(requestId, "بازبینی پس از لغو محلی کامل شد؛ گزارش ذخیره نشد و مصرف ثبت شد.");
        return { ok: false, message: "کار لغو شده بود؛ مصرف ثبت شد." };
      }
      createReview({
        panelId: panel.id,
        requestId,
        imageAssetId,
        summary: validation.value.summary,
        issues: validation.value.issues,
        references: attachments.map((a) => ({ id: a.referenceId, title: a.referenceTitle })),
      });
      completeRequest(requestId, {
        raw: { first: first.raw, repair: repairText },
        parsed: validation.value,
        providerRequestId: first.providerRequestId,
        httpStatus: 200,
        costComputed: cost,
        costReported: { usd: calls.some((c) => c.reported != null) ? calls.reduce((sum, c) => sum + (c.reported ?? 0), 0) : null },
      });
      setJobStatus(job.id, "succeeded");
      return { ok: true };
    }

    if (job.type === "adaptation") {
      // پرامپت و متن از snapshot زمان ثبت می‌آید؛ صحنهٔ فعلی دوباره خوانده نمی‌شود.
      const inputs = (request?.inputs ?? {}) as Record<string, unknown>;
      const sceneId = String(inputs.sceneId ?? "");
      const snapshotText = String(inputs.sceneText ?? "");
      if (!sceneId || !snapshotText) throw new AppError("ورودی اقتباس ناقص است.", 400, "invalid_snapshot");
      const live = getScene(sceneId);
      const liveHash = live ? sha256(live.text) : null;
      const basedOnOlderRevision = Boolean(inputs.textHash) && liveHash !== String(inputs.textHash);
      const started = Date.now();
      const result = await provider.analyze(
        {
          model: modelId,
          system: String(inputs.promptSystem ?? ""),
          user: String(inputs.promptUser ?? ""),
          maxOutputTokens: 6000,
        },
        apiKey,
      );
      const validation = validateModelOutput(result.text, panelProposalSchema);
      const cost = computeTextCallsCost(modelId, [
        { tokensIn: result.tokensIn, tokensOut: result.tokensOut, reported: result.reportedCostUsd },
      ]);
      recordAttempt({
        requestId,
        attempt: job.attempts + 1,
        status: validation.ok ? "succeeded" : "invalid_response",
        httpStatus: 200,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        durationMs: Date.now() - started,
      });
      if (!validation.ok || !validation.value) {
        failRequest(requestId, { status: "failed", code: "invalid_response", message: validation.errors.join("؛ ") });
        run(
          "UPDATE ai_requests SET cost_computed = ?, raw_response = ?, validation_errors = ? WHERE id = ?",
          JSON.stringify(cost),
          JSON.stringify(result.raw).slice(0, 400_000),
          JSON.stringify(validation.errors),
          requestId,
        );
        setJobStatus(job.id, "failed", { errorCode: "invalid_response", errorMessage: validation.errors.join("؛ ") });
        return { ok: false };
      }
      completeRequest(requestId, {
        raw: result.raw,
        parsed: validation.value,
        providerRequestId: result.providerRequestId,
        httpStatus: 200,
        costComputed: cost,
        costReported: { usd: result.reportedCostUsd },
      });
      run(
        "UPDATE ai_requests SET note = ? WHERE id = ?",
        basedOnOlderRevision
          ? "متن صحنه پس از ثبت درخواست تغییر کرده است؛ این نتیجه بر پایهٔ نسخهٔ زمان ثبت است."
          : "نتیجه بر پایهٔ همین نسخهٔ متن ساخته شد.",
        requestId,
      );
      setJobStatus(job.id, "succeeded");
      return { ok: true };
    }

    if (job.type === "scene_extract" || job.type === "scene_suggest" || job.type === "director_notes") {
      const inputs = (request?.inputs ?? {}) as Record<string, unknown>;
      const started = Date.now();
      const result = await provider.analyze(
        {
          model: modelId,
          system: String(inputs.promptSystem ?? ""),
          user: String(inputs.promptUser ?? ""),
          maxOutputTokens: job.type === "scene_extract" ? 4000 : 2500,
        },
        apiKey,
      );
      const validation =
        job.type === "scene_extract"
          ? validateModelOutput(result.text, extractionSchema)
          : job.type === "scene_suggest"
            ? validateModelOutput(result.text, suggestionSchema)
            : validateModelOutput(result.text, directorNoteSchema);
      const cost = computeTextCallsCost(modelId, [
        { tokensIn: result.tokensIn, tokensOut: result.tokensOut, reported: result.reportedCostUsd },
      ]);
      recordAttempt({
        requestId,
        attempt: job.attempts + 1,
        status: validation.ok ? "succeeded" : "invalid_response",
        httpStatus: 200,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        durationMs: Date.now() - started,
      });
      if (!validation.ok || !validation.value) {
        failRequest(requestId, { status: "failed", code: "invalid_response", message: validation.errors.join("؛ ") });
        run(
          "UPDATE ai_requests SET cost_computed = ?, raw_response = ?, validation_errors = ? WHERE id = ?",
          JSON.stringify(cost),
          JSON.stringify(result.raw).slice(0, 400_000),
          JSON.stringify(validation.errors),
          requestId,
        );
        setJobStatus(job.id, "failed", { errorCode: "invalid_response", errorMessage: validation.errors.join("؛ ") });
        return { ok: false };
      }
      completeRequest(requestId, {
        raw: result.raw,
        parsed: validation.value,
        providerRequestId: result.providerRequestId,
        httpStatus: 200,
        costComputed: cost,
        costReported: { usd: result.reportedCostUsd },
      });
      setJobStatus(job.id, "succeeded");
      return { ok: true };
    }

    throw new AppError(`نوع کار «${job.type}» پشتیبانی نمی‌شود.`, 400, "unknown_job");
  } catch (error) {
    const providerError = error instanceof ProviderError ? error : null;
    const retryable = providerError?.retryable ?? false;
    const status = providerError?.unknownOutcome ? "unknown" : "failed";
    const code = providerError?.code ?? (error instanceof AppError ? error.code : "internal");
    const message = error instanceof Error ? error.message : "خطای ناشناخته";
    failRequest(requestId, {
      status,
      code,
      message,
      httpStatus: providerError?.httpStatus ?? null,
    });
    recordAttempt({
      requestId,
      attempt: job.attempts + 1,
      status,
      httpStatus: providerError?.httpStatus ?? null,
      errorCode: code,
      errorMessage: message,
    });
    const canRetry = retryable && !["panel_image", "panel_edit"].includes(job.type) && job.attempts + 1 < job.maxAttempts;
    if (canRetry) {
      const delay = 2000 * Math.pow(2, job.attempts);
      setJobStatus(job.id, "queued", { errorCode: code, errorMessage: message, retryInMs: delay });
      run("UPDATE ai_requests SET status = 'queued', updated_at = ? WHERE id = ?", nowIso(), requestId);
    } else {
      setJobStatus(job.id, status, { errorCode: code, errorMessage: message });
    }
    if (error instanceof AppError) markPanelStaleIfAny(payload, message);
    return { ok: false, message };
  }
}

function markPanelStaleIfAny(payload: Record<string, unknown>, message: string): void {
  if (payload.panelId) {
    const panel = getPanel(String(payload.panelId));
    if (panel) markPanelStale(panel.id, `خطای تولید: ${message}`);
  }
}

/** برآورد سقف بالای هزینهٔ یک درخواست متنی (نرخ ثبت‌شده × توکن تخمینی). */
export function estimateTextRequest(modelId: string, promptChars: number, maxOutputTokens: number): { usd: number | null; basis: string; source?: string } {
  const model = allModels().find((m) => m.id === modelId);
  if (getSetting("analysisSource") === "chatgpt" && getSetting("chatgptModel") === modelId) return { usd: null, basis: "مصرف سهمیهٔ اشتراک ChatGPT؛ صورتحساب API ندارد" };
  if (!model || model.price.inputUsd == null || model.price.outputUsd == null) {
    return { usd: null, basis: "نرخ این مدل ثبت نشده؛ برآورد ممکن نیست", source: model?.price.sourceUrl };
  }
  const tokensIn = Math.ceil(promptChars / 3);
  const estimate = (tokensIn / 1_000_000) * model.price.inputUsd + (maxOutputTokens / 1_000_000) * model.price.outputUsd;
  return {
    usd: estimate,
    basis: `سقف بالا: ${tokensIn} توکن ورودی و ${maxOutputTokens} توکن خروجی با نرخ ثبت‌شده`,
    source: model.price.sourceUrl,
  };
}

/**
 * هزینهٔ تصویر.
 * - مدل‌های per_image: نرخ منتشرشده برای همان اندازه.
 * - مدل‌های توکنی: توکن ورودی و خروجی گزارش‌شده؛ نبود گزارش = «نامشخص».
 */
export function computeImageCost(
  modelId: string,
  inputs: Record<string, unknown>,
  imageOutputTokens: number | null,
  tokensIn: number | null = null,
  tokensOut: number | null = null,
) {
  const entry = allModels().find((m) => m.id === modelId);
  if (!entry) return { usd: null, basis: "مدل در کاتالوگ نیست", kind: "unknown" as const };
  if (entry.price.unit === "per_image") {
    const size = String(inputs.imageSize || inputs.size || "1K");
    const estimate = estimateImageCost(modelId, size);
    return { usd: estimate.usd, basis: estimate.basis, kind: estimate.usd == null ? ("unknown" as const) : ("computed" as const) };
  }
  const outTokens = imageOutputTokens ?? tokensOut;
  if (outTokens == null && tokensIn == null) {
    return { usd: null, basis: "سرویس مصرف توکن گزارش نکرد؛ هزینه «نامشخص» است", kind: "unknown" as const };
  }
  if (outTokens == null || entry.price.outputUsd == null) {
    return { usd: null, basis: "فقط بخشی از مصرف گزارش شد؛ هزینه ناقص است", kind: "partial" as const };
  }
  const inputUsd = tokensIn != null && entry.price.inputUsd != null ? (tokensIn / 1_000_000) * entry.price.inputUsd : 0;
  const outputUsd = (outTokens / 1_000_000) * entry.price.outputUsd;
  return {
    usd: inputUsd + outputUsd,
    basis: `توکن ورودی ${tokensIn ?? 0} و توکن تصویر خروجی ${outTokens} با نرخ ثبت‌شده`,
    kind: tokensIn == null ? ("partial" as const) : ("computed" as const),
  };
}

/** جمع مصرف چند فراخوانی (مثلاً بازبینی + اصلاح پاسخ). */
export function computeTextCallsCost(
  modelId: string,
  calls: Array<{ tokensIn: number | null; tokensOut: number | null; reported: number | null }>,
) {
  const entry = allModels().find((m) => m.id === modelId);
  if (getSetting("analysisSource") === "chatgpt" && getSetting("chatgptModel") === modelId) return { usd: null, basis: "مصرف سهمیهٔ اشتراک ChatGPT", kind: "subscription" as const };
  if (!entry || entry.price.inputUsd == null || entry.price.outputUsd == null) {
    return { usd: null, basis: "نرخ توکن برای این مدل ثبت نشده", kind: "unknown" as const };
  }
  let usd = 0;
  let partial = false;
  let any = false;
  let reportedSum = 0;
  let reportedAny = false;
  for (const call of calls) {
    if (call.reported != null) {
      reportedSum += call.reported;
      reportedAny = true;
    }
    if (call.tokensIn == null || call.tokensOut == null) {
      partial = partial || call.tokensIn != null || call.tokensOut != null;
      continue;
    }
    any = true;
    usd += (call.tokensIn / 1_000_000) * entry.price.inputUsd + (call.tokensOut / 1_000_000) * entry.price.outputUsd;
  }
  if (!any && !reportedAny) {
    return { usd: null, basis: "مصرف توکن گزارش نشد؛ هزینه نامشخص است", kind: "unknown" as const };
  }
  if (partial) {
    return { usd: reportedAny ? reportedSum : null, basis: "هزینهٔ ناقص: بخشی از مصرف گزارش نشد", kind: "partial" as const };
  }
  return {
    usd,
    basis: `${calls.length} فراخوانی؛ توکن ورودی/خروجی گزارش‌شده`,
    kind: "computed" as const,
  };
}

export { estimateTextCost };
