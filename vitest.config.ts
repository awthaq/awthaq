import { defineConfig } from "vitest/config";

// Scoped to packages/*/test explicitly (currently empty — see
// spec/roadmap.md, package creation is gated to M1 Core onward) so this run
// never crosses into features/**/*.steps.test.ts, which is its own separate
// workspace package with its own `pnpm test:bdd` command and vitest config
// (features/vitest.config.ts). Without this scoping, plain `vitest run` from
// the repo root would otherwise discover *.steps.test.ts files too, since
// Vitest's default include pattern matches them and there is no other
// config telling it not to.
//
// Deliberately a flat `include`, not Vitest 5's `test.projects` API: with
// zero packages today, `projects: ["packages/*"]` is a hard "No projects
// were found" startup error (an empty glob match is not tolerated the way a
// plain `include` glob's empty match is, even with `passWithNoTests: true`).
// Switch to `projects: ["packages/*"]` once each package has its own
// vitest.config.ts to run as an isolated project (see qadi's root
// vitest.config.ts for that pattern).
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "features/**"],
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["packages/*/src/**/*.ts"],
      // Per-package thresholds belong here once packages/* is real (see
      // qadi's own vitest.config.ts for the pattern: a workspace-wide floor
      // plus per-package overrides for anything held to a stricter bar).
    },
  },
});
