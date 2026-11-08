import { z } from "zod";
import { body, fail, guard, json } from "@/server/http";
import { factSchema } from "@/server/api-helpers";
import {
  factLikes,
  canonEntriesAt,
  canonWarnings,
  createEntity,
  createFact,
  createStyle,
  createTimelineEvent,
  getSceneState,
  listEntities,
  listEntityVersions,
  listFacts,
  listStyles,
  listTimeline,
  saveSceneState,
} from "@/server/repo/world";
import { getScene } from "@/server/repo/projects";
import { groupConflicts } from "@/server/canon";
import { markPanelsForStyle, markPanelsStale } from "@/server/repo/panels";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("entity"), kind: z.enum(["character", "location", "object", "group", "rule"]), name: z.string().min(1).max(200), summary: z.string().max(4000).optional() }),
  z.object({ action: z.literal("fact"), fact: factSchema }),
  z.object({ action: z.literal("style"), name: z.string().min(1).max(120), description: z.string().max(2000).optional(), palette: z.string().max(500).optional(), linework: z.string().max(500).optional(), isDefault: z.boolean().optional() }),
  z.object({ action: z.literal("timeline"), label: z.string().min(1).max(300), storyDate: z.string().max(40).nullable(), sceneId: z.string().nullable().optional(), kind: z.string().max(40).optional(), note: z.string().max(1000).optional() }),
  z.object({ action: z.literal("scene-state"), sceneId: z.string().min(1), locationId: z.string().nullable().optional(), presentEntities: z.array(z.string()).max(30).optional() }),
]);

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const sceneId = url.searchParams.get("sceneId");
    const entities = listEntities(id);
    const facts = listFacts(id);
    const conflicts = [...groupConflicts(factLikes(id, null))].map(([key, group]) => ({
      key,
      facts: group.map((f) => ({ id: f.id, value: f.value, scopeStart: f.scopeStart, scopeEnd: f.scopeEnd })),
    }));
    return json({
      entities: entities.map((e) => ({ ...e, versions: listEntityVersions(e.id) })),
      facts,
      styles: listStyles(id),
      timeline: listTimeline(id),
      conflicts,
      sceneState: sceneId ? getSceneState(sceneId) : null,
      canon:
        sceneId && getScene(sceneId)
          ? canonEntriesAt(id, { storyDate: getScene(sceneId)!.storyDate, entityIds: entities.map((e) => e.id) })
          : null,
      warnings:
        sceneId && getScene(sceneId)
          ? canonWarnings(id, {
              storyDate: getScene(sceneId)!.storyDate,
              entityIds: entities.map((e) => e.id),
            })
          : null,
    });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guard(req);
    const { id } = await ctx.params;
    const input = await body(req, actionSchema);
    if (input.action === "entity") {
      const entity = createEntity({ projectId: id, kind: input.kind, name: input.name, summary: input.summary });
      return json({ entity }, { status: 201 });
    }
    if (input.action === "fact") {
      const fact = createFact({ projectId: id, ...input.fact, sourceRef: input.fact.sourceRef ?? "" });
      return json({ fact }, { status: 201 });
    }
    if (input.action === "style") {
      const style = createStyle({ projectId: id, ...input });
      const panelsMarked = input.isDefault
        ? markPanelsForStyle(id, style.id, "سبک پیش‌فرض پروژه تغییر کرد؛ بازبینی پنل‌ها لازم است.")
        : 0;
      return json({ style, panelsMarked }, { status: 201 });
    }
    if (input.action === "timeline") {
      return json({ event: createTimelineEvent({ projectId: id, label: input.label, storyDate: input.storyDate, sceneId: input.sceneId, kind: input.kind, note: input.note }) }, { status: 201 });
    }
    saveSceneState({ sceneId: input.sceneId, locationId: input.locationId, presentEntities: input.presentEntities });
    // تغییر مکان/حاضران، مجموعهٔ مرجع قطعی و مراجع معتبر صحنه را عوض می‌کند.
    if (input.locationId !== undefined || input.presentEntities !== undefined) {
      markPanelsStale(input.sceneId, "وضعیت صحنه (مکان/حاضران) تغییر کرد؛ بازبینی لازم است.");
    }
    return json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
