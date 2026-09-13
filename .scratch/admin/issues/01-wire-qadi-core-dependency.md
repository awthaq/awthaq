# 01 — Wire `@qadi/core` into `@effect-auth/admin`

**What to build:** `@effect-auth/admin` can import `@qadi/core`'s `AuthSubject`
type — the only new dependency this plugin needs beyond what the earlier
package-scaffold pass already wired (`@effect-auth/core`, `sql`, `ports`,
`api`, `server` are all already present). This is a prefactor, not a
feature — no new exported symbols, no behavior change. It exists as its own
ticket so ticket 05 (where `AdminConfig`'s `canImpersonate` predicate first
needs the `AuthSubject` type) doesn't also have to touch `package.json`.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] `packages/admin/package.json` lists `@qadi/core` as a dependency, the
      same direct-external-dependency shape `@effect-auth/roles/package.json`
      already uses for the identical type (not a dependency on
      `@effect-auth/qadi` — `Admin` never touches the `SubjectResolver` slot)
- [x] `pnpm install` resolves cleanly
- [x] `pnpm typecheck` and `pnpm build` succeed with no exported symbols
      added yet

## Result

Done. Added `@qadi/core: "^0.6.2"` to `packages/admin/package.json`'s
`dependencies`, matching `@effect-auth/roles`'s own version pin exactly.
`pnpm install` resolved cleanly; no source files changed in this ticket.
This ticket's real content ended up folded into ticket 05, which is the
first to actually import `AuthSubject` from `@qadi/core`.
