import { chatgptProvider } from "./chatgpt";
import { googleProvider } from "./google";
import { openaiProvider } from "./openai";
import { Provider } from "./types";

export * from "./types";

const PROVIDERS: Record<string, Provider> = {
  openai: openaiProvider,
  chatgpt: chatgptProvider,
  google: googleProvider,
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as Array<keyof typeof PROVIDERS>;

export function getProvider(id: string): Provider {
  const provider = PROVIDERS[id];
  if (!provider) {
    throw new Error(`ارائه‌دهندهٔ «${id}» پشتیبانی نمی‌شود.`);
  }
  return provider;
}

export function providerSummaries() {
  return PROVIDER_IDS.map((id) => {
    const p = PROVIDERS[id];
    return { id: p.id, label: p.label, capabilities: p.capabilities() };
  });
}
