import { z } from "zod";
import { body, fail, guard, json } from "@/server/http";
import { deleteApiKey, hasApiKey, maskKey, setApiKey, secretStoreStatus } from "@/server/secrets";

const schema = z.object({
  provider: z.enum(["openai", "google"]),
  key: z.string().min(8).max(4096),
});

/** کلید فقط ذخیره می‌شود؛ هرگز به رابط برنمی‌گردد. */
export async function POST(req: Request) {
  try {
    guard(req);
    const input = await body(req, schema);
    const mode = setApiKey(input.provider, input.key);
    return json({
      provider: input.provider,
      hasKey: true,
      masked: maskKey(input.key.trim()),
      mode,
      secrets: secretStoreStatus(),
    });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(req: Request) {
  try {
    guard(req);
    const url = new URL(req.url);
    const provider = url.searchParams.get("provider");
    if (provider !== "openai" && provider !== "google") {
      return json({ error: { message: "ارائه‌دهنده نامعتبر است." } }, { status: 400 });
    }
    deleteApiKey(provider);
    return json({ provider, hasKey: hasApiKey(provider), secrets: secretStoreStatus() });
  } catch (error) {
    return fail(error);
  }
}
