import { z } from "zod";

/** طرح‌های مشترک ورودی API (اعتبارسنجی زمان اجرا). */

export const idSchema = z.string().min(1).max(80);

export const projectCreateSchema = z.object({
  title: z.string().trim().min(1, "نام پروژه لازم است").max(120),
  subtitle: z.string().max(200).optional(),
  description: z.string().max(4000).optional(),
  publishFormat: z.enum(["vertical", "page"]).optional(),
});

export const projectUpdateSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  subtitle: z.string().max(200).optional(),
  description: z.string().max(4000).optional(),
  publishFormat: z.enum(["vertical", "page"]).optional(),
  settings: z
    .object({
      text: z.object({ provider: z.string().max(40), model: z.string().max(120) }).partial().optional(),
      image: z.object({ provider: z.string().max(40), model: z.string().max(120) }).partial().optional(),
      caps: z
        .object({
          generationsPerPanel: z.number().int().min(1).max(10).optional(),
          reviewsPerPanel: z.number().int().min(0).max(5).optional(),
          chapterBudgetUsd: z.union([z.number().min(0).max(100000), z.null()]).optional(),
          unknownCostPolicy: z.enum(["block", "allow"]).optional(),
        })
        .partial()
        .optional(),
      readingOrder: z.enum(["rtl", "ltr"]).optional(),
      adaptation: z.object({ panelsPerScene: z.number().int().min(1).max(28) }).partial().optional(),
    })
    .partial()
    .optional(),
});

export const sceneSaveSchema = z.object({
  text: z.string().max(2_000_000),
  reason: z.enum(["manual", "autosave", "restore", "ai"]).default("autosave"),
});

export const panelUpdateSchema = z.object({
  title: z.string().max(200).optional(),
  action: z.string().max(4000).optional(),
  sourceExcerpt: z.string().max(4000).optional(),
  narrativeGoal: z.string().max(2000).optional(),
  shotSize: z.enum(["wide", "medium", "close", "extreme_close", "over_shoulder", "detail"]).optional(),
  cameraAngle: z.enum(["eye", "low", "high", "birds_eye", "dutch"]).optional(),
  gazeDirection: z.string().max(200).optional(),
  movement: z.string().max(500).optional(),
  emotion: z.string().max(200).optional(),
  lighting: z.string().max(500).optional(),
  costumes: z.string().max(500).optional(),
  props: z.string().max(500).optional(),
  timeLabel: z.string().max(200).optional(),
  locationId: z.string().nullable().optional(),
  styleProfileId: z.string().nullable().optional(),
  characters: z
    .array(
      z.object({
        entityId: z.string().nullable().default(null),
        name: z.string().min(1).max(120),
        position: z.string().max(200).default(""),
        gaze: z.string().max(200).default(""),
        emotion: z.string().max(200).default(""),
        clothing: z.string().max(500).default(""),
        identityNote: z.string().max(500).default(""),
      }),
    )
    .max(12)
    .optional(),
  dialogue: z
    .array(
      z.object({
        speaker: z.string().max(120).default(""),
        text: z.string().min(1).max(2000),
        kind: z.enum(["dialogue", "narration", "thought", "sfx"]).default("dialogue"),
      }),
    )
    .max(20)
    .optional(),
  status: z.enum(["draft", "ready", "generated", "reviewed", "approved", "needs_review"]).optional(),
  needsReview: z.boolean().optional(),
});

export const factSchema = z.object({
  subjectId: z.string().max(80).default(""),
  subjectType: z.enum(["entity", "project"]).default("entity"),
  attribute: z.string().trim().min(1).max(120),
  value: z.string().trim().min(1).max(4000),
  sourceType: z.enum(["scene_version", "note", "reference", "user_decision", "ai_suggestion"]).default("user_decision"),
  sourceRef: z.string().max(500).optional(),
  scopeStart: z.string().max(40).nullable().optional(),
  scopeEnd: z.string().max(40).nullable().optional(),
  status: z.enum(["proposed", "confirmed", "rejected", "retired"]).default("proposed"),
});

export const entityVersionSchema = z.object({
  label: z.string().max(160).default(""),
  layer: z.enum(["identity", "face", "body", "birthmark", "clothing", "equipment", "injury", "age", "expression"]),
  payload: z.record(z.string(), z.unknown()).default({}),
  fixedTraits: z.boolean().default(false),
  validFrom: z.string().max(40).nullable().optional(),
  validTo: z.string().max(40).nullable().optional(),
  notes: z.string().max(2000).default(""),
  approved: z.boolean().default(false),
});

export const produceSchema = z.object({
  referenceIds: z.array(z.string().max(80)).max(24).optional(),
  size: z.string().max(40).optional(),
  aspectRatio: z.string().max(20).optional(),
  imageSize: z.string().max(20).optional(),
  allowedChanges: z.string().max(1000).optional(),
  constraints: z.string().max(1000).optional(),
  promptOverride: z.string().max(20_000).optional(),
  acknowledgeIdentityConflicts: z.boolean().optional(),
  expectedRequestKey: z.string().max(80).optional(),
});

export const layoutUpdateSchema = z.object({
  format: z.enum(["vertical", "page"]).optional(),
  title: z.string().max(160).optional(),
  pageWidth: z.number().min(320).max(6000).optional(),
  pageHeight: z.number().min(320).max(12000).optional(),
  gap: z.number().min(0).max(200).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});
