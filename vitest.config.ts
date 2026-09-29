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
    // `examples/plugin-template` is the one example with a test suite (JH-009): the
    // template plugin `docs/plugin-authoring.md` walks through must keep passing.
    projects: ["packages/*", "examples/plugin-template", "examples/memory-server"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["packages/*/src/**/*.ts", "packages/*/src/**/*.tsx"],
      // DoD gate 6 (spec/process/definitions-of-done.md): a shortfall fails the run, it
      // is not merely reported (MM-004). The workspace-wide floor sits about two points
      // under what `pnpm coverage` measured when it was set, so it catches a real
      // regression without failing on noise; raise it when coverage rises, never lower
      // it to make a run pass. Same pattern as the sibling qadi repo's own
      // vitest.config.ts (../qadi, not `packages/qadi` here): a glob key holds those
      // files to their own bar, and they are then left out of the workspace-wide figure.
      thresholds: {
        statements: 89,
        branches: 83,
        functions: 84,
        lines: 90,
        // The packages that carry the security-critical logic are held to their own
        // floors, so a well-covered plugin cannot average a regression in them away.
        "packages/core/src/**": { statements: 93, branches: 83, functions: 92, lines: 94 },
        "packages/password/src/**": { statements: 92, branches: 73, functions: 87, lines: 93 },
        "packages/jwt/src/**": { statements: 93, branches: 90, functions: 89, lines: 94 },
        "packages/server/src/**": { statements: 88, branches: 84, functions: 84, lines: 88 },
      },
    },
  },
});
