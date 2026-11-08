import type { PanelProposal } from "./validate";

/**
 * تبدیل محلی متن صحنه به پیشنهاد پنل، بدون AI.
 *
 * این مسیر همیشه در دسترس است و مسیر «نوشتن تا خروجی» را بدون کلید کامل می‌کند.
 * قاعده «هر پاراگراف = یک پنل» نیست: جمله‌ها به ضرباهنگ شکسته می‌شوند،
 * دیالوگ از متن جدا می‌شود و نماها بر اساس نقش هر ضرباهنگ انتخاب می‌شوند.
 * کاربر پیش از افزودن به برد، همهٔ پنل‌ها را می‌بیند و می‌تواند ویرایش کند.
 */

export interface SplitOptions {
  text: string;
  characters: Array<{ id: string; name: string }>;
  locationName?: string;
  target?: number;
  isFlashback?: boolean;
  storyDate?: string | null;
}

const SENTENCE_SPLIT = /(?<=[.!؟?…»”])\s+|\n+/u;

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function extractDialogue(text: string): Array<{ speaker: string; text: string; kind: "dialogue" | "narration" | "thought" | "sfx" }> {
  const out: Array<{ speaker: string; text: string; kind: "dialogue" | "narration" | "thought" | "sfx" }> = [];
  const quoted = /«([^»]{1,400})»/g;
  let match: RegExpExecArray | null;
  while ((match = quoted.exec(text)) !== null) {
    const body = clean(match[1]);
    if (body) out.push({ speaker: "", text: body, kind: "dialogue" });
  }
  const dashed = /(?:^|\n)\s*[-—–]\s*([^\n]{1,400})/g;
  while ((match = dashed.exec(text)) !== null) {
    const body = clean(match[1]);
    if (body && !out.some((d) => d.text === body)) out.push({ speaker: "", text: body, kind: "dialogue" });
  }
  const thought = /\(([^)]{1,240})\)/g;
  while ((match = thought.exec(text)) !== null) {
    const body = clean(match[1]);
    if (body) out.push({ speaker: "", text: body, kind: "thought" });
  }
  return out;
}

function detectCharacters(text: string, characters: Array<{ id: string; name: string }>) {
  return characters
    .filter((c) => text.includes(c.name))
    .map((c) => ({
      entityId: c.id,
      name: c.name,
      position: "",
      gaze: "",
      emotion: "",
      clothing: "",
      identityNote: "",
    }));
}

type Beat = { excerpt: string; kind: "action" | "dialogue" | "reaction" | "silence" };

function toBeats(text: string): Beat[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map(clean)
    .filter(Boolean);
  const beats: Beat[] = [];
  for (const paragraph of paragraphs) {
    const sentences = paragraph.split(SENTENCE_SPLIT).map(clean).filter(Boolean);
    for (const sentence of sentences) {
      if (sentence.length <= 2) continue;
      const hasDialogue = /«|(?:^|\s)[-—–]\s/.test(sentence);
      const kind: Beat["kind"] = hasDialogue
        ? "dialogue"
        : /[!؟?]/.test(sentence)
          ? "reaction"
          : sentence.length < 26
            ? "silence"
            : "action";
      if (sentence.length > 320) {
        const parts = Math.ceil(sentence.length / 220);
        const size = Math.ceil(sentence.length / parts);
        for (let i = 0; i < parts; i++) {
          beats.push({ excerpt: sentence.slice(i * size, (i + 1) * size), kind });
        }
      } else {
        beats.push({ excerpt: sentence, kind });
      }
    }
  }
  if (beats.length === 0) beats.push({ excerpt: text.slice(0, 220), kind: "action" });
  return beats;
}

export function splitSceneIntoPanels(options: SplitOptions): PanelProposal["panels"] {
  const target = Math.max(1, Math.min(options.target ?? 12, 28));
  const beats = toBeats(options.text);
  // اگر ضرباهنگ‌ها بیشتر از هدف‌اند، جمله‌های کوتاه در هم ادغام می‌شوند.
  const merged: Beat[] = [];
  for (const beat of beats) {
    const last = merged[merged.length - 1];
    if (
      merged.length >= target &&
      last &&
      last.kind === beat.kind &&
      last.excerpt.length + beat.excerpt.length < 300
    ) {
      last.excerpt = `${last.excerpt} ${beat.excerpt}`;
    } else if (merged.length < target) {
      merged.push({ ...beat });
    } else {
      const index = merged.length - 1;
      merged[index] = { ...merged[index], excerpt: `${merged[index].excerpt} ${beat.excerpt}`.slice(0, 600) };
    }
  }

  return merged.map((beat, index) => {
    const dialogue = extractDialogue(beat.excerpt);
    const characters = detectCharacters(beat.excerpt, options.characters);
    const shotSize: PanelProposal["panels"][number]["shotSize"] =
      index === 0
        ? "wide"
        : beat.kind === "dialogue"
          ? "medium"
          : beat.kind === "reaction"
            ? "close"
            : beat.kind === "silence"
              ? "extreme_close"
              : index % 5 === 4
                ? "detail"
                : "medium";
    const cameraAngle: PanelProposal["panels"][number]["cameraAngle"] =
      beat.kind === "reaction" ? "low" : index % 7 === 6 ? "high" : "eye";
    return {
      title: `پنل ${index + 1}`,
      sourceExcerpt: beat.excerpt,
      narrativeGoal:
        beat.kind === "dialogue"
          ? "انتقال گفت‌وگو و تنش صحنه"
          : beat.kind === "reaction"
            ? "نمایش واکنش و تغییر حالت"
            : beat.kind === "silence"
              ? "سکوت و مکث روایی"
              : "پیش‌بردن کنش صحنه",
      action: beat.excerpt,
      characters,
      location: options.locationName ?? "",
      timeLabel: options.storyDate ?? "",
      shotSize,
      cameraAngle,
      gazeDirection: "",
      movement: "",
      emotion: beat.kind === "reaction" ? "تنش" : "",
      lighting: options.isFlashback ? "نور سرد و خاطره‌ای" : "",
      costumes: "",
      props: "",
      dialogue,
    };
  });
}

/** متن کامل پنل برای خروجی متنی و خلاصه‌سازی. */
export function panelText(panel: {
  title: string;
  action: string;
  dialogue: Array<{ speaker: string; text: string }>;
}): string {
  const lines = [panel.title, panel.action];
  for (const d of panel.dialogue) lines.push(`${d.speaker ? `${d.speaker}: ` : ""}«${d.text}»`);
  return lines.filter(Boolean).join("\n");
}
