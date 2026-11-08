import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * آزمون‌ها در پوشهٔ دادهٔ موقت و بدون دسترسی به خزانهٔ واقعی کلید اجرا می‌شوند
 * تا هرگز کلید کاربر خوانده یا نوشته نشود.
 */
const testRoot = process.env.RAVAYAT_TEST_ROOT || os.tmpdir();
fs.mkdirSync(testRoot, { recursive: true });
const dir = fs.mkdtempSync(path.join(testRoot, "ravayat-test-"));
process.env.RAVAYAT_DATA_DIR = dir;
process.env.RAVAYAT_DISABLE_KEYRING = "1";
