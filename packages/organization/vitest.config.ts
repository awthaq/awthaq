import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "organization",
    include: ["test/**/*.test.ts"],
  },
});
