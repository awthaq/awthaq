import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "react",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    // Only this package's own test run needs a DOM — every other package's
    // shared root `vitest.config.ts` project stays environment: "node".
    environment: "happy-dom",
  },
});
