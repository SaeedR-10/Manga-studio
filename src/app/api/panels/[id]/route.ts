import { body, fail, guard, guardRead, json } from "@/server/http";
import { panelUpdateSchema } from "@/server/api-helpers";
import {
  deletePanel,
  listPanels,
  panelVersions,
  requirePanel,
  updatePanel,
} from "@/server/repo/panels";
import { listReviews, listTakes } from "@/server/repo/ai";
import { planPanelProduction } from "@/server/engine";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guardRead(req);
    const { id } = await ctx.params;
    const panel = requirePanel(id);
    const url = new URL(req.url);
    const wantPlan = url.searchParams.get("plan") !== "0";
    let plan: unknown = null;
    let planError: string | null = null;
    if (wantPlan) {
      /*
       * پیش‌نمایش با همان گزینه‌هایی ساخته می‌شود که کاربر در فرم دیده است
       * (اندازه، کیفیت، محدودیت‌ها و مراجع)، نه فقط پیش‌فرض‌ها. همان planKey
       * هنگام ارسال بررسی می‌شود تا چیزی که دیده می‌شود همان چیزی باشد که می‌رود.
       */
      const referenceIds = url.searchParams.getAll("reference").filter(Boolean);
      try {
        plan = planPanelProduction(panel.projectId, id, {
          size: url.searchParams.get("size") ?? undefined,
          imageSize: url.searchParams.get("imageSize") ?? undefined,
          aspectRatio: url.searchParams.get("aspectRatio") ?? undefined,
          allowedChanges: url.searchParams.get("allowedChanges") ?? undefined,
          constraints: url.searchParams.get("constraints") ?? undefined,
          referenceIds: referenceIds.length ? referenceIds : undefined,
        });
      } catch (error) {
        planError = error instanceof Error ? error.message : "ساخت پیش‌نمایش ورودی ممکن نشد.";
      }
    }
    const neighbors = listPanels(panel.projectId, { sceneId: panel.sceneId }).filter(
      (p) => Math.abs(p.position - panel.position) <= 1 && p.id !== panel.id,
    );
    return json({
      panel,
      takes: listTakes(id),
      reviews: listReviews(id),
      versions: panelVersions(id),
      neighbors,
      plan,
      planError,
    });
  } catch (error) {
    return fail(error);
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guard(req);
    const { id } = await ctx.params;
    const patch = await body(req, panelUpdateSchema);
    return json({ panel: updatePanel(id, patch) });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    guard(req);
    const { id } = await ctx.params;
    const panel = requirePanel(id);
    deletePanel(id);
    return json({ panels: listPanels(panel.projectId, { sceneId: panel.sceneId }) });
  } catch (error) {
    return fail(error);
  }
}
