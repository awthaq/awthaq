import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "webhooks",
    include: ["test/**/*.test.ts"],
  },
});
