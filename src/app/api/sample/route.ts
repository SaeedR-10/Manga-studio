import { fail, guard, json } from "@/server/http";
import { createSampleProject } from "@/server/sample";

export async function POST(req: Request) {
  try {
    guard(req);
    const result = createSampleProject();
    return json(
      {
        ...result,
        note: "پروژهٔ نمونه با تقسیم‌بندی محلی ساخته شد؛ هیچ درخواست AI پولی ارسال نشد.",
      },
      { status: 201 },
    );
  } catch (error) {
    return fail(error);
  }
}
