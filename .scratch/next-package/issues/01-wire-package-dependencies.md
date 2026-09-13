# 01 — Wire @effect-auth/next's package dependencies

**What to build:** `@effect-auth/next` can import `@effect-auth/core` (for
`Sessions`, `Users`), `@effect-auth/api` (for `Api.Principal`,
`Api.SessionCookie`), and `@effect-auth/server` (for `AuthHttp`, and
`PrincipalResolver`/`PrincipalResolverLive` — the one place a session
already maps to a `Principal`) alongside its existing `@effect-auth/react`
dependency. This is a prefactor, not a feature — no new exported symbols, no
behavior change. It exists as its own ticket so the three feature tickets it
unblocks (02, 03, 04) don't each separately touch the same
`package.json`/tsconfig files, which would otherwise be redundant,
conflict-prone parallel edits to the same lines.

**Correction found during implementation:** the original spec listed only
`core`+`api`+`react` as dependencies, reasoning that no `@effect-auth/qadi`
dependency was needed. That reasoning still holds — `qadi` stays excluded —
but `@effect-auth/server` turned out to be genuinely needed too, for one
reason, not two: `getSession` (ticket 02) needs the real `PrincipalResolver`
service to turn a verified session into a `Principal` rather than
re-deriving that mapping a second time in this package (which would
violate the "one source of truth per concept" design principle in
`spec/overview.md`). **Correction to this correction, caught by
`/code-review`'s Spec axis:** `AuthHttp` is not actually imported by any
`packages/next/src/` file — `withNextCookies` (ticket 04) ended up a pure
`(Response, jar) => void` bridge that never dispatches a request itself, so
it needs no router-building machinery at all. `AuthHttp` is used only by
`packages/next/test/WithNextCookies.test.ts`, to produce a realistic
`Response` to test against — a devDependency-shaped need, not a production
one. `@effect-auth/server` as a runtime dependency of the package is still
justified, but by `PrincipalResolver` alone.
`@effect-auth/server` sits below `@effect-auth/qadi` in the stratum order
just like `core`/`api` do, so this doesn't reopen the qadi-layering
question — it's an addition, not a reversal.

Per `.scratch/next-package/spec.md`'s Implementation Decisions: this package
still does **not** gain a dependency on `@effect-auth/qadi`.

**Blocked by:** None — can start immediately.

**Status:** done

## Result

Also added `@effect-auth/test` (devDependency, for `TestAuth`-adjacent test
patterns) and `@effect/platform-node` (devDependency, for `NodeCrypto.layer`
— needed by every memory-backed test layer in this package, matching the
pattern every other package's tests already use).

- [x] `packages/next/package.json` lists `@effect-auth/core`,
      `@effect-auth/api`, and `@effect-auth/server` as `workspace:*`
      dependencies, in addition to the existing `@effect-auth/react`
      dependency
- [x] `packages/next/tsconfig.src.json`'s `paths` and `references` include
      `@effect-auth/core`, `@effect-auth/api`, and `@effect-auth/server`
      the same way the existing scaffold already wires `@effect-auth/react`
- [x] `pnpm install` resolves cleanly
- [x] `pnpm typecheck` and `pnpm build` succeed for `packages/next` with no
      exported symbols added yet (the placeholder `export {}` in
      `src/index.ts` is untouched)
