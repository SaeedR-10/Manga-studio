import { fail, guardRead, json } from "@/server/http";
import { listStoredDrafts } from "@/server/drafts";

/** فهرست پیش‌نویس‌های پایدار برای بازیابی پس از اجرای دوباره روی پورت دیگر. */
export async function GET(req: Request) {
  try {
    guardRead(req);
    return json({ drafts: listStoredDrafts() });
  } catch (error) {
    return fail(error);
  }
}
