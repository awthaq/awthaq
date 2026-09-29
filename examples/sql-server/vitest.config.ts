import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "example-sql-server",
    include: ["test/**/*.test.ts"],
  },
});
