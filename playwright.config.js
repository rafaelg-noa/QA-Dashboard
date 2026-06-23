import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests-e2e",

  webServer: {
    command: "node tests-e2e/static-server.js 8090",
    url: "http://localhost:8090",
    reuseExistingServer: !process.env.CI,
  },

  use: {
    baseURL: "http://localhost:8090",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
