import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "device-authorization",
    include: ["test/**/*.test.ts"],
  },
});
