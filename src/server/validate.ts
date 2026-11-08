import { z } from "zod";

/**
 * اعتبارسنجی پاسخ مدل پیش از تبدیل به دادهٔ برنامه.
 * هر پاسخ نامعتبر یک بار با پیام اصلاحی دوباره درخواست می‌شود و سپس
 * «ناموفق» ثبت می‌شود؛ حلقهٔ بی‌پایان وجود ندارد.
 */

export const panelCharacterSchema = z.object({
  entityId: z.string().nullable().optional(),
  name: z.string().min(1),
  position: z.string().default(""),
  gaze: z.string().default(""),
  emotion: z.string().default(""),
  clothing: z.string().default(""),
  identityNote: z.string().default(""),
});

export const panelDialogueSchema = z.object({
  speaker: z.string().default(""),
  text: z.string().min(1),
  kind: z.enum(["dialogue", "narration", "thought", "sfx"]).default("dialogue"),
});

export const panelProposalSchema = z.object({
  panels: z
    .array(
      z.object({
        title: z.string().default(""),
        sourceExcerpt: z.string().default(""),
        narrativeGoal: z.string().default(""),
        action: z.string().min(1),
        characters: z.array(panelCharacterSchema).default([]),
        location: z.string().default(""),
        timeLabel: z.string().default(""),
        shotSize: z.enum(["wide", "medium", "close", "extreme_close", "over_shoulder", "detail"]).default("medium"),
        cameraAngle: z.enum(["eye", "low", "high", "birds_eye", "dutch"]).default("eye"),
        gazeDirection: z.string().default(""),
        movement: z.string().default(""),
        emotion: z.string().default(""),
        lighting: z.string().default(""),
        costumes: z.string().default(""),
        props: z.string().default(""),
        dialogue: z.array(panelDialogueSchema).default([]),
      }),
    )
    .min(1)
    .max(28),
});

export type PanelProposal = z.infer<typeof panelProposalSchema>;

export const reviewResponseSchema = z.object({
  summary: z.string().default(""),
  issues: z
    .array(
      z.object({
        kind: z.enum([
          "identity",
          "mark",
          "clothing",
          "tool",
          "scale",
          "position",
          "count",
          "location",
          "lighting",
          "continuity",
          "readability",
          "other",
        ]),
        severity: z.enum(["low", "medium", "high"]).default("medium"),
        description: z.string().min(1),
        referenceTitle: z.string().default(""),
        evidence: z.string().default(""),
        confidence: z.enum(["low", "medium", "high"]).default("medium"),
        suggestion: z.string().default(""),
        evaluable: z.boolean().default(true),
      }),
    )
    .default([]),
});

export type ReviewResponse = z.infer<typeof reviewResponseSchema>;

export const extractionSchema = z.object({
  characters: z
    .array(z.object({ name: z.string().min(1), description: z.string().default(""), evidence: z.string().default("") }))
    .default([]),
  locations: z
    .array(z.object({ name: z.string().min(1), description: z.string().default(""), evidence: z.string().default("") }))
    .default([]),
  objects: z
    .array(z.object({ name: z.string().min(1), description: z.string().default(""), evidence: z.string().default("") }))
    .default([]),
  facts: z
    .array(
      z.object({
        subjectName: z.string().min(1),
        attribute: z.string().min(1),
        value: z.string().min(1),
        evidence: z.string().default(""),
        scopeNote: z.string().default(""),
      }),
    )
    .default([]),
  notes: z.array(z.string()).default([]),
});

export type ExtractionResult = z.infer<typeof extractionSchema>;

export const suggestionSchema = z.object({
  suggestions: z
    .array(
      z.object({
        original: z.string().min(1),
        replacement: z.string().default(""),
        reason: z.string().default(""),
      }),
    )
    .default([]),
});

export const directorNoteSchema = z.object({
  notes: z
    .array(
      z.object({
        panelIndex: z.number().int().min(1),
        kind: z.enum(["readability", "focus", "variety", "axis", "gaze", "balloon_space", "pacing", "other"]),
        note: z.string().min(1),
        suggestion: z.string().default(""),
      }),
    )
    .default([]),
});

/** استخراج نخستین شیء JSON از پاسخ مدل (با یا بدون حصار کد). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fence ? fence[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    /* ادامه */
  }
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      /* ادامه */
    }
  }
  return null;
}

export interface ValidationOutcome<T> {
  ok: boolean;
  value: T | null;
  errors: string[];
}

export function validateModelOutput<T>(text: string, schema: z.ZodType<T>): ValidationOutcome<T> {
  const parsed = extractJson(text);
  if (parsed === null) {
    return { ok: false, value: null, errors: ["پاسخ، JSON قابل خواندن نبود."] };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      value: null,
      errors: result.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(ریشه)"}: ${i.message}`),
    };
  }
  return { ok: true, value: result.data, errors: [] };
}

/** حداکثر یک درخواست اصلاح برای پاسخ نامعتبر؛ پاسخ نامعتبر و تصاویر در درخواست می‌مانند. */
export function buildRepairMessage(errors: string[], previousText?: string): string {
  const lines = [
    "پاسخ قبلی با ساختار خواسته‌شده سازگار نبود. فقط JSON معتبر برگردان و هیچ توضیح اضافه ننویس.",
    "خطاها:",
    ...errors.map((e) => `- ${e}`),
  ];
  if (previousText?.trim()) {
    lines.push("<<<DATA previous_response>>>", previousText.trim().slice(0, 6000), "<<<END DATA previous_response>>>");
  }
  return lines.join("\n");
}

export const MAX_REPAIR_ROUNDS = 1;
