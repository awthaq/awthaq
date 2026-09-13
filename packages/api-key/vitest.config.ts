import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "api-key",
    include: ["test/**/*.test.ts"],
  },
});
