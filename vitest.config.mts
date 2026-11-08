import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    testTimeout: 30000,
    setupFiles: ["tests/setup.ts"],
    // یک پایگاه دادهٔ مشترک در پوشهٔ موقت؛ فایل‌ها موازی اجرا نمی‌شوند.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(path.dirname(fileURLToPath(import.meta.url)), "src"),
    },
  },
});
