import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "ports",
    include: ["test/**/*.test.ts"],
    // Real argon2id/scrypt hashing: under `pnpm coverage` (v8) on a loaded machine the default 5 s is not enough.
    testTimeout: 30_000,
  },
});
