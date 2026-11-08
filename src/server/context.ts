import { row } from "./db";
import type { CanonEntry } from "./prompts";
import { inScope } from "./canon";
import { canonEntriesAt, factLikes, knowledgeForProject, listEntities } from "./repo/world";
import type { Fact } from "@/lib/types";

/**
 * زمینهٔ روایت برای هر وظیفهٔ AI.
 *
 * - دانستهٔ نویسنده (Canon) از دانستهٔ هر شخصیت جدا می‌شود.
 * - افشا با «ترتیب روایت» سنجیده می‌شود (فصل × ۱۰۰۰ + صحنه)، نه با ترتیب
 *   زمان داستان؛ بنابراین فلش‌بک وضعیت همان لحظه را می‌گیرد.
 * - برای هر شخصیت، مواردی که «نباید بداند» فقط با نام ویژگی گزارش می‌شوند،
 *   نه با مقدار؛ تا راز در پرامپت بازگو نشود.
 */

export interface KnowledgeFact {
  factId: string;
  attribute: string;
  value: string;
}

export interface CharacterKnowledgeView {
  entityId: string;
  name: string;
  knows: KnowledgeFact[];
  suspects: KnowledgeFact[];
  /** ویژگی‌هایی که این شخصیت در این صحنه نباید از آن‌ها باخبر باشد */
  withheld: Array<{ attribute: string; revealedLater: boolean }>;
}

export function scenePosition(sceneId: string): number | null {
  const found = row(
    `SELECT s.position AS scene_position, c.position AS chapter_position
       FROM scenes s JOIN chapters c ON c.id = s.chapter_id
      WHERE s.id = ?`,
    sceneId,
  );
  if (!found) return null;
  return Number(found.chapter_position) * 1000 + Number(found.scene_position);
}

export function buildKnowledgeContext(
  projectId: string,
  sceneId: string,
  characterIds: string[],
): CharacterKnowledgeView[] {
  if (characterIds.length === 0) return [];
  const scene = row("SELECT project_id, story_date FROM scenes WHERE id = ?", sceneId);
  if (!scene) return [];
  const position = scenePosition(sceneId);
  if (position == null) return [];
  const storyDate = scene.story_date ? String(scene.story_date) : null;
  /**
   * فقط واقعیت‌های «تأییدشده» و معتبر در همین زمان داستان می‌توانند دانش
   * شخصیت باشند. پیشنهاد تأییدنشده، ردشده، بازنشسته یا واقعیتِ آینده وارد
   * پرامپت نمی‌شود؛ نبودِ داده یعنی «نمی‌داند»، نه حدس.
   */
  const eligibleFacts = (factLikes(projectId, storyDate) as Fact[]).filter(
    (fact) => fact.status === "confirmed" && inScope(fact, storyDate),
  );
  const byId = new Map(eligibleFacts.map((f) => [f.id, f]));
  const knowledge = knowledgeForProject(projectId);

  return characterIds.map((entityId) => {
    const entity = row("SELECT name FROM entities WHERE id = ? AND project_id = ?", entityId, projectId);
    const name = entity ? String(entity.name) : entityId;
    const views: CharacterKnowledgeView = { entityId, name, knows: [], suspects: [], withheld: [] };
    const seen = new Map<string, "knows" | "suspects" | "unaware">();
    for (const k of knowledge) {
      if (k.characterId !== entityId || !k.factId) continue;
      const revealed = k.revealScenePosition == null || k.revealScenePosition <= position;
      const state = revealed ? k.knowledge : "unaware";
      const prior = seen.get(k.factId);
      const rank = state === "knows" ? 3 : state === "suspects" ? 2 : 1;
      const priorRank = prior === "knows" ? 3 : prior === "suspects" ? 2 : 1;
      if (!prior || rank >= priorRank) seen.set(k.factId, state);
    }
    for (const [factId, state] of seen) {
      const fact = byId.get(factId);
      if (!fact) continue; // خارج از بازهٔ اعتبار همین صحنه
      if (state === "knows") views.knows.push({ factId, attribute: fact.attribute, value: fact.value });
      else if (state === "suspects") views.suspects.push({ factId, attribute: fact.attribute, value: fact.value });
      else views.withheld.push({ attribute: fact.attribute, revealedLater: true });
    }
    return views;
  });
}

/** خطوط آمادهٔ پرامپت برای محدودیت دانش شخصیت‌ها. */
export function knowledgePromptLines(views: CharacterKnowledgeView[]): string[] {
  const lines: string[] = [];
  for (const view of views) {
    if (view.withheld.length) {
      lines.push(
        `- ${view.name} در این صحنه از این موضوع‌ها بی‌خبر است و نباید در دیالوگ، فکر یا واکنشش به آن‌ها اشاره کند: ${view.withheld
          .map((w) => w.attribute)
          .join("، ")}.`,
      );
    }
    if (view.suspects.length) {
      lines.push(
        `- ${view.name} فقط گمان می‌برد (نه یقین): ${view.suspects.map((s) => `${s.attribute} (${s.value})`).join("، ")}.`,
      );
    }
    if (view.knows.length) {
      lines.push(`- ${view.name} می‌داند: ${view.knows.map((s) => `${s.attribute}: ${s.value}`).join("؛ ")}.`);
    }
  }
  return lines;
}

/** نمایش فشرده برای پنل تولید و بازبینی. */
export function knowledgeSummary(views: CharacterKnowledgeView[]): Array<{ name: string; knows: string[]; suspects: string[]; withheld: string[] }> {
  return views.map((v) => ({
    name: v.name,
    knows: v.knows.map((k) => `${k.attribute}: ${k.value}`),
    suspects: v.suspects.map((k) => `${k.attribute}: ${k.value}`),
    withheld: v.withheld.map((w) => w.attribute),
  }));
}

export interface SceneContext {
  canon: { entries: CanonEntry[]; conflicts: string[] };
  knowledge: CharacterKnowledgeView[];
  entityIds: string[];
  characterIds: string[];
}

/**
 * زمینهٔ واحد یک صحنه برای اقتباس و تولید: اطلاعات قطعی همان زمان + دانش
 * شخصیت‌ها + موجودیت‌های مرتبط (شخصیت، مکان، اشیای نام‌برده‌شده).
 */
export function buildSceneContext(input: {
  projectId: string;
  sceneId: string;
  characterIds: string[];
  locationId?: string | null;
  propText?: string;
}): SceneContext {
  const characterIds = [...new Set(input.characterIds)];
  const entityIds = [...characterIds];
  if (input.locationId) entityIds.push(input.locationId);

  // اشیای مرتبط: نام شیء ثبت‌شده در متن «اشیای پنل» آمده باشد.
  if (input.propText?.trim()) {
    for (const entity of listEntities(input.projectId, "object")) {
      if (input.propText.includes(entity.name) && !entityIds.includes(entity.id)) entityIds.push(entity.id);
    }
  }

  const scene = row("SELECT story_date FROM scenes WHERE id = ?", input.sceneId);
  const storyDate = scene?.story_date ? String(scene.story_date) : null;
  const canon = canonEntriesAt(input.projectId, { storyDate, entityIds: [...new Set(entityIds)] });
  const knowledge = buildKnowledgeContext(input.projectId, input.sceneId, characterIds);
  return { canon, knowledge, entityIds: [...new Set(entityIds)], characterIds };
}
