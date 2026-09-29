import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "api-key",
    include: ["test/**/*.test.ts"],
    // The sql-records suite migrates a real SQLite database per test; under `pnpm coverage` (v8) on a shared CI runner the default 5 s is not enough.
    testTimeout: 30_000,
  },
});
