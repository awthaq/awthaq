import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "password",
    include: ["test/**/*.test.ts"],
  },
});
