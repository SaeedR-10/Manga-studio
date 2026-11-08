import { fail, guard, json } from "@/server/http";
import { restorePackage } from "@/server/backup";
import { AppError } from "@/server/http";

export async function POST(req: Request) {
  try {
    guard(req);
    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      throw new AppError("بسته باید به‌صورت فایل ZIP ارسال شود.", 400, "bad_content_type");
    }
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new AppError("فایل بسته پیدا نشد.", 400, "no_file");
    if (file.size > 800 * 1024 * 1024) throw new AppError("حجم بسته بیش از حد مجاز است.", 400, "too_large");
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await restorePackage(buffer);
    return json(
      {
        ...result,
        note: "بسته در یک پروژهٔ تازه بازیابی شد؛ تصاویر و متن‌ها به همان پروژه متصل‌اند. کلیدهای API در بسته نبودند.",
      },
      { status: 201 },
    );
  } catch (error) {
    return fail(error);
  }
}
