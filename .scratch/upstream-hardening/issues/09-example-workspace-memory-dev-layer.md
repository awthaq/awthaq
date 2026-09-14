# Runnable example workspace + exported memory dev layer

Type: grilling
Status: open

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
