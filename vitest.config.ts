import { defineConfig } from "vitest/config";

// Vitest 5's `test.projects` API: every package under `packages/*` now has
// its own `vitest.config.ts` (each package created since the 20-package
// scaffold carries one), so each runs as its own isolated project with its
// own settings honored — `packages/react/vitest.config.ts`'s
// `environment: "happy-dom"` in particular, which a flat root `include`
// (this config's own previous shape) would have silently ignored, running
// every package's tests under one shared "node" environment regardless of
// what each package's own config asked for. `features/` is a sibling
// directory, not under `packages/*`, so this glob never reaches its own
// separate `pnpm test:bdd` suite (features/vitest.config.ts) — no explicit
// exclude needed the way the flat `include` shape required one.
export default defineConfig({
  test: {
    projects: ["packages/*"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["packages/*/src/**/*.ts", "packages/*/src/**/*.tsx"],
      // Per-package thresholds belong here once a package needs a bar other
      // than the workspace-wide default (see qadi's own vitest.config.ts for
      // that pattern).
    },
  },
});
