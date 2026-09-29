import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "migrate-firebase",
    include: ["test/**/*.test.ts"],
  },
});
