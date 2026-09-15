import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// The npm scripts pass --env-file-if-exists to tsx, but vitest is not run through
// node's CLI, so the API tests would fall back to the default credentials in
// tests/helpers/test-config.ts and fail to authenticate against a real MySQL.
if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "api",
          environment: "node",
          include: ["tests/api/**/*.test.ts"],
          globalSetup: "tests/global-setup.ts",
          setupFiles: ["tests/test-setup.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 15_000,
          hookTimeout: 120_000,
        },
      },
      {
        test: {
          name: "frontend",
          environment: "happy-dom",
          include: ["tests/frontend/**/*.test.js"],
        },
      },
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/learning/**/*.test.ts", "tests/decision/**/*.test.ts", "tests/execution/**/*.test.ts", "tests/knowledge/**/*.test.ts", "tests/telemetry/**/*.test.ts"],
        },
      },
    ],
  },
});
