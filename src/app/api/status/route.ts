import { fail, json } from "@/server/http";
import { SCHEMA_VERSION } from "@/server/db";
import { queueState, startQueue } from "@/server/queue";
import { hasApiKey, secretStoreStatus } from "@/server/secrets";
import { listProjects } from "@/server/repo/projects";

export async function GET() {
  try {
    // صف در اولین درخواست راه می‌افتد؛ instrumentation هم آن را زودتر شروع می‌کند.
    startQueue();
    return json({
      ok: true,
      appVersion: process.env.RAVAYAT_DESKTOP_VERSION || "0.1.0",
      schemaVersion: SCHEMA_VERSION,
      queue: queueState(),
      secrets: secretStoreStatus(),
      keys: { openai: hasApiKey("openai"), google: hasApiKey("google") },
      projects: listProjects().length,
    });
  } catch (error) {
    return fail(error);
  }
}
