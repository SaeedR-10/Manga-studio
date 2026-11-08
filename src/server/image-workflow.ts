import { getSetting } from "./db";
import { AppError } from "./http";
export function imageWorkflow(): "api" | "manual_chatgpt" { return getSetting("imageWorkflow") === "manual_chatgpt" ? "manual_chatgpt" : "api"; }
export function assertAutomaticImages() { if (imageWorkflow() === "manual_chatgpt") throw new AppError("حالت انتقال دستی فعال است؛ بستهٔ پرامپت و مراجع را بگیرید و تصویر ساخته‌شده را وارد کنید. هیچ درخواست API تصویری ارسال نشد.", 409, "manual_image_mode"); }
