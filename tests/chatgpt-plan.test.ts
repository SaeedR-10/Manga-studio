import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
const jwt = vi.hoisted(() => ({ nonce: "", badNonce: false, rejectSignature: false, options: null as unknown }));
vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(() => ({})),
  jwtVerify: vi.fn(async (_token, _keys, options) => { jwt.options = options; if (jwt.rejectSignature) throw new Error("invalid signature"); return { payload: { sub: "unit-test-account", email: "test@example.invalid", nonce: jwt.badNonce ? "bad" : jwt.nonce } }; }),
}));
import { beginPlanLogin, cachedPlanModels, disconnectPlan, planAccessToken, planStatus, refreshPlanModels } from "@/server/chatgpt-plan";
import { chatgptProvider, readPlanStream } from "@/server/providers/chatgpt";
import { getSetting } from "@/server/db";
let calls: Array<{ url: string; init?: RequestInit }>;
let scopes: string;
let tokenExpiry: number;
beforeEach(() => {
  disconnectPlan(); calls = []; scopes = "openid profile chatgpt.tokens.use.direct"; tokenExpiry = 3600; jwt.badNonce = false; jwt.rejectSignature = false;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/oauth/token")) return Response.json({ access_token: "dummy-oauth-access", refresh_token: "dummy-refresh", id_token: "dummy-id", scope: scopes, expires_in: tokenExpiry });
    if (String(url).endsWith("/models")) return Response.json({ models: [{ visibility: "list", slug: "account-specific-model", display_name: "Test Model" }, { visibility: "hidden", slug: "hidden-model" }] });
    return new Response(streamText([{ type: "response.output_text.delta", delta: "پاسخ" }, { type: "response.completed", response: { id: "response-test", usage: { input_tokens: 5, output_tokens: 2 } } }]), { headers: { "content-type": "text/event-stream" } });
  });
});
afterEach(() => { disconnectPlan(); vi.unstubAllGlobals(); });
function callback(url: URL): Promise<number> {
  return new Promise((resolve, reject) => { http.get(url, res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); }).on("error", reject); });
}
async function login() {
  const start = await beginPlanLogin(); const authorize = new URL(start.url); jwt.nonce = authorize.searchParams.get("nonce")!;
  const returned = new URL(authorize.searchParams.get("redirect_uri")!); returned.searchParams.set("state", authorize.searchParams.get("state")!); returned.searchParams.set("code", "dummy-code"); returned.searchParams.set("client_id", "oaiapp_test");
  return { authorize, returned };
}
function streamText(events: unknown[]) { return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""); }
function stream(value: string) { const bytes = new TextEncoder().encode(value); return new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } }); }
describe("official ChatGPT-plan connection", () => {
  it("uses stable host ID, loopback callback and PKCE, not an API key", async () => {
    const { authorize } = await login();
    expect(authorize.origin).toBe("https://auth.openai.com"); expect(authorize.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256"); expect(authorize.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127.0.0.1:\d+\/auth\/callback$/);
    const host = authorize.searchParams.get("ext_agent_host_id"); disconnectPlan(); const second = await login(); expect(second.authorize.searchParams.get("ext_agent_host_id")).toBe(host);
  });
  it("rejects callback state before exchanging credentials", async () => { const { returned } = await login(); returned.searchParams.set("state", "wrong"); expect(await callback(returned)).toBe(400); expect(calls).toHaveLength(0); expect(planStatus().connected).toBe(false); });
  it("checks verified ID-token audience and nonce, then grants plan access", async () => {
    const { returned } = await login(); expect(await callback(returned)).toBe(200);
    expect(jwt.options).toMatchObject({ issuer: "https://auth.openai.com", audience: "oaiapp_test" });
    expect(planStatus()).toMatchObject({ connected: true, sharing: true, storage: "session_memory" });
    expect(JSON.stringify(planStatus())).not.toContain("dummy-oauth-access"); expect(await planAccessToken()).toBe("dummy-oauth-access");
  });
  it("rejects an invalid signature", async () => { const { returned } = await login(); jwt.rejectSignature = true; expect(await callback(returned)).toBe(400); expect(planStatus().connected).toBe(false); });
  it("rejects a mismatched nonce", async () => { const { returned } = await login(); jwt.badNonce = true; expect(await callback(returned)).toBe(400); expect(planStatus().connected).toBe(false); });
  it("identity login without granted plan scope cannot analyze", async () => { scopes = "openid profile"; const { returned } = await login(); expect(await callback(returned)).toBe(200); expect(planStatus().sharing).toBe(false); await expect(planAccessToken()).rejects.toMatchObject({ code: "chatgpt_plan_required" }); });
  it("discovers only visible account models and persists no token in settings", async () => {
    const { returned } = await login(); await callback(returned); const models = await refreshPlanModels();
    expect(models.map(m => m.id)).toEqual(["account-specific-model"]); expect(cachedPlanModels()).toEqual(models);
    expect(getSetting("chatgptModels")).not.toContain("dummy-oauth-access");
  });
  it("uses the public streaming route, preserves input images, and omits unsupported fields", async () => {
    const { returned } = await login(); await callback(returned);
    const result = await chatgptProvider.analyze({ model: "account-specific-model", system: "instructions", user: "text", maxOutputTokens: 200, images: [{ mime: "image/png", base64: "AAA" }] }, "ignored");
    const call = calls.at(-1)!; expect(call.url).toBe("https://api.openai.com/v1/responses");
    const request = JSON.parse(String(call.init?.body)); expect(request).toMatchObject({ store: false, stream: true }); expect(request).not.toHaveProperty("max_output_tokens");
    expect(request.input[0].content[1].image_url).toBe("data:image/png;base64,AAA"); expect(result.text).toBe("پاسخ"); expect(result.tokensIn).toBe(5);
  });
  it("refreshes an expiring token only once for concurrent calls", async () => { tokenExpiry = 1; const { returned } = await login(); await callback(returned); tokenExpiry = 3600; await Promise.all([planAccessToken(), planAccessToken()]); expect(calls.filter(c => c.url.endsWith("/oauth/token"))).toHaveLength(2); });
  it("refuses automatic image generation without sending any request", async () => { await expect(chatgptProvider.generateImage({ model: "x", prompt: "x" }, "ignored")).rejects.toMatchObject({ code: "plan_image_unsupported" }); expect(calls).toHaveLength(0); });
});
describe("stream completion and subscription limits", () => {
  it("decodes fragmented Persian UTF-8 and requires completed", async () => { const result = await readPlanStream(stream(streamText([{ type: "response.output_text.delta", delta: "متن فارسی" }, { type: "response.completed", response: { id: "x" } }]))); expect(result.text).toBe("متن فارسی"); expect(result.tokensIn).toBeNull(); });
  it("rejects partial text without completion", async () => { await expect(readPlanStream(stream(streamText([{ type: "response.output_text.delta", delta: "partial" }])))).rejects.toMatchObject({ code: "incomplete_stream", retryable: false }); });
  it("does not accept text followed by a usage-limit failure", async () => { await expect(readPlanStream(stream(streamText([{ type: "response.output_text.delta", delta: "partial" }, { type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded" } } }])))).rejects.toMatchObject({ code: "subscription_sharing_usage_limit_exceeded", retryable: false }); });
});
