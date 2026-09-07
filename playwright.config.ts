import { defineConfig } from "@playwright/test";

/**
 * Extensions require a persistent context and a real Chromium build (not the headless
 * shell), so these run headed and serially. They are separate from the Vitest suite on
 * purpose: this is the only place where real layout, real computed styles and the actual
 * extension runtime exist.
 */
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [["list"]],
  use: { trace: "off" },
});
