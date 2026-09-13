import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "admin",
    include: ["test/**/*.test.ts"],
  },
});
