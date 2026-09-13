import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "test",
    include: ["test/**/*.test.ts"],
  },
});
