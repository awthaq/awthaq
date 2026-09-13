import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "two-factor",
    include: ["test/**/*.test.ts"],
  },
});
