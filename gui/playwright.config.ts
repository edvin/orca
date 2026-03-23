import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:5173",
    viewport: { width: 1512, height: 945 },
    colorScheme: "dark",
    screenshot: "off",
  },
  projects: [
    {
      name: "screenshots",
      use: { browserName: "chromium" },
    },
  ],
});
