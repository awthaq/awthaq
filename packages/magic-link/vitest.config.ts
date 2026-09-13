import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "magic-link",
    include: ["test/**/*.test.ts"],
  },
});
