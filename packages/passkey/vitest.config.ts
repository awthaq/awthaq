import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "passkey",
    include: ["test/**/*.test.ts"],
    // Over a real Postgres each case builds its own migrated schema (hundreds of DDL statements): a full parallel run on a
    // loaded machine stretches a 150 ms case past vitest's 5 s. The same allowance as `features/vitest.config.ts` and `scripts/test-pg.sh`.
    testTimeout: process.env["AWTHAQ_POSTGRES_URL"] === undefined ? 5_000 : 60_000,
  },
});
