import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "migrate-auth0",
    include: ["test/**/*.test.ts"],
  },
});
