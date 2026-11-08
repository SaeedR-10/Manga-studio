import { z } from "zod";
import { body, fail, guard, guardRead, json } from "@/server/http";
import { beginPlanLogin, cachedPlanModels, disconnectPlan, planStatus, refreshPlanModels } from "@/server/chatgpt-plan";
import { getSetting, setSetting } from "@/server/db";
export const runtime = "nodejs";
export async function GET(req: Request) { try { guardRead(req); return json({ ...planStatus(), models: cachedPlanModels(), imageWorkflow: getSetting("imageWorkflow") || "api", analysisSource: getSetting("analysisSource") || "project", model: getSetting("chatgptModel") || "" }); } catch (e) { return fail(e); } }
export async function POST(req: Request) {
  try {
    guard(req);
    const input = await body(req, z.object({ action: z.enum(["login", "logout", "refresh-models", "workflow", "analysis"]), mode: z.enum(["api", "manual_chatgpt"]).optional(), source: z.enum(["project", "chatgpt"]).optional(), model: z.string().max(200).optional() }));
    if (input.action === "login") return json(await beginPlanLogin());
    if (input.action === "logout") { disconnectPlan(); return json({ ok: true }); }
    if (input.action === "refresh-models") return json({ models: await refreshPlanModels() });
    if (input.action === "analysis") {
      if (input.source === "chatgpt" && (!planStatus().sharing || !cachedPlanModels().some(m => m.id === input.model))) return json({ error: { message: "ابتدا وارد شوید، مجوز اشتراک را بدهید و یک مدل از فهرست حساب انتخاب کنید." } }, { status: 400 });
      setSetting("analysisSource", input.source || "project");
      if (input.model) setSetting("chatgptModel", input.model);
      return json({ ok: true });
    }
    if (input.mode) setSetting("imageWorkflow", input.mode);
    return json({ ok: true });
  } catch (e) { return fail(e); }
}
