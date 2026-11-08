import crypto from "node:crypto";
import http from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { AppError } from "./http";
import { getSetting, setSetting } from "./db";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));
type Session = { clientId: string; subject: string; email: string; access: string; refresh: string; idToken: string; expires: number; scopes: string[] };
type Entry = { getPassword(): string | null; setPassword(value: string): void; deletePassword(): boolean };
type PlanState = { epoch: number; session: Session | null; loaded: boolean; server: http.Server | null; timer?: NodeJS.Timeout; pending: boolean; error: string | null; storage: "credential_manager" | "session_memory"; refreshing?: Promise<string> };
const globalPlan = globalThis as typeof globalThis & { __ravayatPlan?: PlanState };
const state = globalPlan.__ravayatPlan ??= { epoch: 0, session: null, loaded: false, server: null, pending: false, error: null, storage: "session_memory" };

function entry(name: string): Entry {
  if (process.env.RAVAYAT_DISABLE_KEYRING === "1") throw new Error("disabled");
  const { Entry } = require("@napi-rs/keyring") as { Entry: new (service: string, name: string) => Entry };
  return new Entry("RavayatStudio.ChatGPT", name);
}
type Stored = { keys: string[] };
function stored(): Stored | null {
  try { const value = JSON.parse(entry("active").getPassword() || "null"); return Array.isArray(value?.keys) && value.keys.every((k: unknown) => typeof k === "string" && /^session-[a-f0-9]+-\d+$/.test(k)) ? value : null; } catch { return null; }
}
function erase(record: Stored | null) { for (const key of record?.keys ?? []) { try { entry(key).deletePassword(); } catch { /* best effort old chunks */ } } }
function load(): Session | null {
  if (state.loaded) return state.session;
  state.loaded = true;
  const record = stored();
  if (!record) return null;
  try {
    const raw = record.keys.map(k => { const v = entry(k).getPassword(); if (v == null) throw new Error(); return v; }).join("");
    const value = JSON.parse(raw);
    if (typeof value.access !== "string" || typeof value.clientId !== "string" || !Array.isArray(value.scopes) || typeof value.expires !== "number") return null;
    state.storage = "credential_manager";
    return state.session = value;
  } catch { state.error = "خواندن اتصال ذخیره‌شده ممکن نشد؛ دوباره وارد شوید."; return null; }
}
function persist(session: Session) {
  state.session = session; state.loaded = true;
  const previous = stored();
  const raw = JSON.stringify(session); const keys: string[] = []; const generation = crypto.randomBytes(12).toString("hex");
  try {
    // Small vault entries avoid the Windows per-credential size limit. Commit the pointer last.
    for (let start = 0; start < raw.length; start += 700) { const key = `session-${generation}-${keys.length}`; keys.push(key); entry(key).setPassword(raw.slice(start, start + 700)); }
    entry("active").setPassword(JSON.stringify({ keys }));
    state.storage = "credential_manager"; erase(previous);
  } catch {
    erase({ keys }); state.storage = "session_memory";
    // Do not leave obsolete credentials looking like the current session after a failed rotation.
    try { entry("active").deletePassword(); erase(previous); } catch { /* in-memory session remains */ }
  }
}
export function planStatus() {
  const session = load();
  return { connected: Boolean(session), sharing: Boolean(session?.scopes.includes("chatgpt.tokens.use.direct")), email: session?.email ?? null, pending: state.pending, error: state.error, storage: state.storage, imageGeneration: false };
}
function stopPending() { clearTimeout(state.timer); state.server?.close(); state.server = null; state.pending = false; }
export function disconnectPlan() {
  state.epoch++; stopPending(); const previous = stored();
  try { entry("active").deletePassword(); erase(previous); } catch { if (previous) throw new AppError("پاک‌کردن اتصال از خزانه ممکن نشد.", 500, "logout_failed"); }
  state.session = null; state.loaded = true; state.error = null;
  setSetting("chatgptRegistration", "");
  setSetting("chatgptModels", "[]");
}
async function token(body: URLSearchParams): Promise<Record<string, unknown>> {
  const response = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new AppError("ورود یا تمدید اتصال ChatGPT انجام نشد؛ دوباره وارد شوید.", 401, "chatgpt_reauth");
  return await response.json();
}
function tokenSession(data: Record<string, unknown>, prior: Session): Session {
  if (typeof data.access_token !== "string" || !data.access_token || !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 0) throw new AppError("پاسخ ورود کامل نیست.", 401, "invalid_token_response");
  return { ...prior, access: data.access_token, refresh: typeof data.refresh_token === "string" ? data.refresh_token : prior.refresh, idToken: typeof data.id_token === "string" ? data.id_token : prior.idToken, expires: Date.now() + Number(data.expires_in) * 1000, scopes: typeof data.scope === "string" ? data.scope.split(/\s+/).filter(Boolean) : prior.scopes };
}
export async function beginPlanLogin(): Promise<{ url: string }> {
  if (state.pending) throw new AppError("یک ورود در حال انجام است؛ آن را کامل یا لغو کنید.", 409, "login_pending");
  const previous = load(); state.error = null; const epoch = ++state.epoch;
  const registration = previous?.clientId || getSetting("chatgptRegistration") || "";
  const nonce = crypto.randomBytes(32).toString("base64url"); const oauthState = crypto.randomBytes(32).toString("base64url"); const verifier = crypto.randomBytes(48).toString("base64url");
  let host = getSetting("chatgptHostId"); if (!host) { host = `urn:uuid:${crypto.randomUUID()}`; setSetting("chatgptHostId", host); }
  let consumed = false; let redirect = "";
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", redirect);
    if (req.method !== "GET" || req.headers.host !== new URL(redirect).host) { res.writeHead(400).end(); return; }
    if (url.pathname !== "/auth/callback") { res.writeHead(404).end(); return; }
    if (consumed || url.searchParams.get("state") !== oauthState) { res.writeHead(400).end("Invalid sign-in state."); return; }
    consumed = true; clearTimeout(state.timer);
    try {
      if (url.searchParams.has("error")) throw new AppError("ورود توسط حساب تأیید نشد.", 401, "login_denied");
      const code = url.searchParams.get("code"); const clientId = url.searchParams.get("client_id") || registration;
      if (!code || !clientId || clientId === "dynamic_agent_client" || (registration && clientId !== registration)) throw new Error("invalid callback");
      setSetting("chatgptRegistration", clientId);
      const data = await token(new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirect, resource: RESOURCE }));
      if (typeof data.id_token !== "string") throw new Error("missing ID token");
      const { payload } = await jwtVerify(data.id_token, jwks, { issuer: ISSUER, audience: clientId, requiredClaims: ["sub", "exp", "nonce"] });
      if (payload.nonce !== nonce || !payload.sub || (previous && previous.subject !== payload.sub)) throw new Error("identity mismatch");
      const session = tokenSession(data, { clientId, subject: payload.sub, email: typeof payload.email === "string" ? payload.email : "", access: "", refresh: "", idToken: "", expires: 0, scopes: [] });
      if (state.epoch !== epoch) throw new Error("login cancelled");
      persist(session); state.error = null;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'" }).end("<!doctype html><html lang=fa dir=rtl><meta charset=utf-8><title>استودیوی روایت</title><p>ورود انجام شد. به برنامه برگردید.</p></html>");
    } catch { if (state.epoch === epoch) state.error = "ورود کامل نشد؛ حساب و مجوز استفاده از اشتراک را بررسی و دوباره تلاش کنید."; res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("ورود کامل نشد. به برنامه برگردید."); }
    finally { if (state.epoch === epoch) stopPending(); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") { server.close(); throw new Error("loopback unavailable"); }
  redirect = `http://127.0.0.1:${address.port}/auth/callback`; state.server = server; state.pending = true;
  state.timer = setTimeout(() => { state.error = "زمان ورود تمام شد؛ دوباره تلاش کنید."; stopPending(); }, 5 * 60000); state.timer.unref();
  const params = new URLSearchParams({ client_id: registration || "dynamic_agent_client", ext_agent_host_id: host, response_type: "code", redirect_uri: redirect, scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct", resource: RESOURCE, state: oauthState, nonce, code_challenge_method: "S256", code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url") });
  if (!registration) params.set("agent_name_hint", "Ravayat Studio");
  // Routine reauthorization works without id_token_hint. Never expose an ID token in a renderer URL.
  return { url: `${ISSUER}/api/accounts/authorize?${params}` };
}
export async function planAccessToken(): Promise<string> {
  const session = load();
  if (!session?.scopes.includes("chatgpt.tokens.use.direct")) throw new AppError("در تنظیمات وارد ChatGPT شوید و مجوز استفاده از اشتراک را فعال کنید.", 401, "chatgpt_plan_required");
  if (session.expires > Date.now() + 60000) return session.access;
  if (state.refreshing) return state.refreshing;
  const epoch = state.epoch;
  state.refreshing = (async () => {
    if (!session.refresh) throw new AppError("برای ادامه دوباره وارد ChatGPT شوید.", 401, "chatgpt_reauth");
    const data = await token(new URLSearchParams({ grant_type: "refresh_token", client_id: session.clientId, refresh_token: session.refresh, resource: RESOURCE }));
    const updated = tokenSession(data, session); if (epoch !== state.epoch) throw new AppError("اتصال قطع شده است.", 401, "chatgpt_disconnected"); persist(updated);
    if (!updated.scopes.includes("chatgpt.tokens.use.direct")) throw new AppError("مجوز استفاده از اشتراک فعال نیست؛ دوباره وارد شوید.", 401, "chatgpt_plan_required");
    return updated.access;
  })().finally(() => { state.refreshing = undefined; });
  return state.refreshing;
}
export type PlanModel = { id: string; label: string };
export function cachedPlanModels(): PlanModel[] {
  try { const value = JSON.parse(getSetting("chatgptModels") || "[]"); return Array.isArray(value) ? value.filter((m: PlanModel) => typeof m.id === "string" && typeof m.label === "string") : []; } catch { return []; }
}
export async function refreshPlanModels(): Promise<PlanModel[]> {
  const access = await planAccessToken();
  const response = await fetch(`${RESOURCE}/models`, { headers: { authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new AppError("فهرست مدل‌های این حساب دریافت نشد؛ اتصال و محدودیت اشتراک را بررسی کنید.", 400, "chatgpt_models_failed");
  const data = await response.json();
  const models: PlanModel[] = (Array.isArray(data.models) ? data.models : []).filter((m: { visibility?: string; slug?: string }) => m.visibility === "list" && typeof m.slug === "string").map((m: { slug: string; display_name?: string }) => ({ id: m.slug, label: m.display_name || m.slug }));
  setSetting("chatgptModels", JSON.stringify(models)); return models;
}
