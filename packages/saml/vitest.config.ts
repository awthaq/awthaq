import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "saml",
    include: ["test/**/*.test.ts"],
  },
});
