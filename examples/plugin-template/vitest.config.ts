import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "example-plugin-template",
    include: ["test/**/*.test.ts"],
  },
});
