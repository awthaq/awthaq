import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "scim",
    include: ["test/**/*.test.ts"],
  },
});
