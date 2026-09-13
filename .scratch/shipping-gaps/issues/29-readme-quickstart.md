# 29 — README rewrite + Postgres-backed quickstart

**What to build:** The README accurately describes this project and
gives a prospective adopter a real, runnable quickstart against the new
Postgres backend.

**Blocked by:** 08, 09, 10, 11, 15

**Status:** done

## Result

Rewrote `README.md` end to end. Replaced the stale "pre-implementation,
no source exists" banner with an accurate status line linking
`spec/roadmap.md` and `.scratch/shipping-gaps/map.md`, and added a
**Publishing status** section stating plainly that no package is
published to npm yet (every `packages/*/package.json` is still
`"private": true`) — the quickstart runs from a clone, not `npm install`,
since claiming otherwise would be false.

The quickstart is one complete, copy-pasteable `server.ts`: `Auth.make([Password.Password])`
for the Password plugin's own contract/layer, `AuthCore.AuthCoreApi`
(`Session`/`Account` handlers) wired directly alongside it since
`Auth.make` doesn't yet prepend the fixed core surface (`Auth.ts`'s own
header comment — that's M1 Core, not yet landed), a real `@effect/sql-pg`
`PgClient` + `Migrator.make({})({loader: CoreMigrations.coreMigrations})`
migration run, `Encryption`/`KeyProvider.layerEnv` (the `accounts` table's
encryption columns are shared core schema, needed even with no OAuth
plugin installed), and a real listening server via
`HttpRouter.serve(AppLayer).pipe(Layer.provide(NodeHttpServer.layer(createServer, {port})))`
+ `Layer.launch` + `NodeRuntime.runMain`. Followed by real `curl` examples
for sign-up, sign-in, update-profile (200), and delete-user (204).

**Verified by literally running it**, not read for plausibility: built a
throwaway smoke-test script (Node's own `--experimental-strip-types`
runner never entered into it — imported the already-built `packages/*/lib`
output directly instead, plain `.mjs`, physically placed inside
`packages/core/test/_debug/` so bare specifiers like `effect`,
`@effect/sql-sqlite-node`, `@effect/platform-node` resolved off that
package's own real dependencies) that ran the *exact* composition shown
in the README, swapping only `PgClient.layer({url})` for
`SqliteClient.layer({filename: ":memory:"})` — `packages/sql`'s domain
layers are dialect-agnostic (ticket 03's own decision), so this is a
faithful stand-in; no local Postgres/Docker daemon was available in this
session (the same constraint ticket 15 hit — CI's `postgres:16` service
remains the first real signal against Postgres itself specifically, noted
honestly in the README's own "Running it" section). The script really
binds a TCP port via `NodeHttpServer`, really runs the framework
`Migrator` against a fresh SQLite DB, and really drives sign-up → sign-in
→ update-profile → delete-user over `fetch` against that live server —
all four succeeded end to end, migrations included.

**Two real bugs caught and fixed while assembling the quickstart, both
in this ticket's own draft, not in shipped library code:**

- Two `AuthHttp.routes(...)` calls (Password's `PasswordApi` and the core
  `AuthCoreApi`) both defaulting to `openapiPath: "/openapi.json"`
  collided at router-registration time (`Method 'GET' already declared
  for route '/openapi.json'`) — fixed by only requesting the OpenAPI path
  once.
- `@effect-auth/password`'s package index does
  `export * as Password from "./Password.ts"` — `Password` imported from
  the package root is a **namespace**, not the plugin class; the class
  `Auth.make` actually needs is `Password.Password`. Passing the bare
  namespace into `Auth.make([Password])` fails at runtime with `plugin
  .dependsOn is not iterable` (the namespace has no such getter), not at
  compile time — worth flagging since it's an easy, silent mistake for a
  real adopter to make too. Root-caused by comparing against
  `AuthPlugin.ts`'s own `dependsOn` getter machinery before finding the
  actual mismatch was one level up, in which value `Password` even
  referred to.

`pnpm check` (typecheck, lint, knip, format:check, circular, coverage,
`test:bdd`, `spec:verify:strict`) passes clean after this rewrite —
93.11%/82.84%/90.06%/93.27% (statements/branches/functions/lines)
coverage, 104 BDD scenarios passed/34 skipped, all 19 spec-traceability
checks PASS. No separate `examples/` app was added — the quickstart lives
entirely in `README.md`. All throwaway debug scripts were deleted before
this commit; none are part of the shipped tree.

- [x] The stale "pre-implementation, no source exists" banner is removed,
      replaced with an accurate one-line status linking to
      `spec/roadmap.md` and this effort's wayfinder map for progress
      tracking
- [x] A single flat quickstart (mirroring upstream's own ~500-line
      document shape) demonstrates a real `Auth.make(...)` composition
      against the Postgres backend from ticket 15, including sign-up/
      sign-in and at least one account-lifecycle endpoint from tickets
      08–11
- [x] The quickstart code is actually runnable/copy-pasteable — verified
      by literally running it (or an equivalent smoke test), not just
      read for plausibility
- [x] No separate `examples/` app is added — the quickstart lives
      entirely in the README
