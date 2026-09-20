import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "migrate-better-auth",
    include: ["test/**/*.test.ts"],
  },
});
