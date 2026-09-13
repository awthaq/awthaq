# 02 — getSession verifies a session cookie against the database

**What to build:** from a Next.js React Server Component or a server action,
calling `getSession` with the incoming request's headers and an explicit
runtime returns the resolved principal, user, and session for a valid,
unexpired session cookie. For a missing, malformed, expired, or
unknown-session cookie, it resolves `undefined` — never throws, never
rejects — so a page or action handles "no session" with a plain
`if (!session)`, the one ordinary case, rather than a caught exception. A
genuine backing-store outage (not "no valid session") still propagates as a
rejection, distinct from the ordinary case.

Per `.scratch/next-package/spec.md`'s Implementation Decisions: the
returned struct is `{principal, user, session}` — three fields, not the
aspirational four-field `SessionView` with `subject` from `spec/overview.md`.
Resolving a qadi subject from `principal` is the calling application's own
job (via `@qadi/core`'s `SubjectResolver.resolve`), not `getSession`'s —
this keeps `@effect-auth/next` off of `@effect-auth/qadi` entirely, matching
the stratum-layering rule already enforced elsewhere in this project
(`@effect-auth/api`'s `Subject.ts` / `@effect-auth/qadi`'s `SubjectApi.ts`
split).

`getSession` takes the runtime as an explicit argument — no module-level
singleton inside the package (see `.scratch/next-package/spec.md`'s
"No runtime construction owned by this package" decision; that pattern is
documented in ticket 05's README instead).

**Blocked by:** 01 — Wire @effect-auth/next's package dependencies

**Status:** done

## Result

Reuses `@effect-auth/server`'s `Authentication.PrincipalResolver` (not
originally in the ticket's dependency list — see ticket 01's own "Correction
found during implementation" note) to turn a verified session into a
`Principal`, rather than re-deriving that mapping a second time in this
package.

Tests do **not** run over `@effect-auth/test`'s full `TestAuth.layer`
harness as originally written — `getSession` only ever needs
`Sessions.Sessions | Users.Users | PrincipalResolver`, so tests build that
smaller layer directly (`Users.layerMemory` + `Sessions.layerMemory` +
`PrincipalResolverLive`, matching exactly what `TestAuth.signInAs` itself
requires), avoiding pulling in the whole `Auth.make`/HTTP-router machinery
`TestAuth.layer` exists for, which `getSession` never touches at all.

- [x] A request carrying a valid, unexpired session cookie resolves
      `{principal, user, session}` with the correct ids
- [x] A request with no `Cookie` header resolves `undefined`
- [x] A request with a malformed/unparseable `Cookie` header resolves
      `undefined` — never throws
- [x] An expired session (advanced past expiry via `TestClock`) resolves
      `undefined`
- [x] A well-formed cookie naming a session id that doesn't exist resolves
      `undefined`
- [x] `getSession` takes an explicit runtime argument; no hidden
      module-level singleton is introduced
