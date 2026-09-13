import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "qadi",
    include: ["test/**/*.test.ts"],
  },
});
