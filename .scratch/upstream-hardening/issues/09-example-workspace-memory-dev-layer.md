# Runnable example workspace + exported memory dev layer

Type: grilling
Status: resolved

## Question

`packages/test/src/TestAuth.ts` already exports a real, production-
quality memory-backed layer (`MemoryPorts`, `TestAuth.ts:84-92`) and
`signInAs` — not a stub — but it's test-only in `packages/test`, not
packaged as a standalone runnable example the way upstream's
`dev-memory.ts` anchors their 26-line quickstart.

Decide: does the memory layer move to (or get re-exported from) a
non-test-scoped package so it's importable without pulling in test
tooling, or does a new `examples/` workspace just depend on
`packages/test` directly (accepting the test-dependency as fine for an
example, not for library consumers)?; what the example actually
demonstrates (mirror `shipping-gaps` ticket 29's README quickstart
composition but memory-backed instead of Postgres-backed, or something
that shows a *different* slice — e.g. a plugin composition the README
doesn't cover)?; and whether this becomes this repo's `examples/`
directory precedent (README stayed single-flat-document per `shipping-
gaps` ticket 07, deliberately not linking to a separate examples app —
confirm this ticket doesn't quietly reverse that decision).

## Answer

Grounded against `packages/test/package.json`'s actual dependency shape
and `.scratch/shipping-gaps/issues/07-readme-quickstart-scope.md`'s
recorded answer.

**No move needed — `@awthaq/test`'s dependency footprint is already
lean.** The ticket's own framing assumed importing it would "pull in
test tooling," but by direct read, `package.json`'s `dependencies` are
just `@awthaq/api`/`core`/`ports`/`server`, `@effect/platform-node`, and
`effect` — `vitest`/`@effect/vitest` are `devDependencies` only, used by
this package's *own* test suite (`runPluginContractTests`), not required
by anything that merely imports `TestAuth`/`MemoryPorts` as a value. A
consumer of the exported layer pulls in exactly what it needs and
nothing test-runner-shaped. New `examples/` workspace just depends on
`packages/test` directly — no relocation, no re-export shim, no
duplicated logic.

**Reverses `shipping-gaps` ticket 07(b) — deliberately, confirmed with
this session's user, not quietly.** That decision ("no separate
`examples/` app... decided as out of this map's destination") was scoped
to what the *README itself* documents, not a blanket ban on this repo
ever having a runnable examples workspace — and this ticket isn't
re-litigating the same question: the README's own quickstart stays
exactly as `shipping-gaps` ticket 29 shipped it (single-plugin,
Postgres-backed, no `examples/` link). This is a separate, additional
artifact.

**What it demonstrates — a multi-plugin composition the README doesn't
cover, memory-backed.** The README's own quickstart composes only
`[Password.Password]`, noting "the same call takes `[Password, OAuth,
Organization, Admin, Passkey, Jwt]` unchanged" — nobody has actually
shown that broader composition running anywhere. `examples/memory-server`
composes 2-3 plugins together (e.g. `Password` + `Organization`) over
`TestAuth.layer`'s memory backend, through a real listening
`NodeHttpServer` (matching the README's own "real listening server" bar,
not an in-process test client) — near-zero setup (no Postgres, no
migration run), closing both a real coverage gap and the DX complaint
the pasted report's evidence actually cited.

**Wiring** — new `pnpm-workspace.yaml` entry (`examples/*`, alongside
the existing `packages/*`/`features`), one member
(`examples/memory-server`), `private: true`, depending on `@awthaq/test`
plus whichever plugin packages the composition picks.
