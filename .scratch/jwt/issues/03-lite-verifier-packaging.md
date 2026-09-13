# 03 — Lite verifier packaging and dependency footprint

**Type:** grilling
**Status:** resolved
**Blocked by:** None — can start immediately (grounded in ticket 00)

## Question

The map has settled that a standalone verifier — usable by a downstream
service that never installs `Auth.make`/`AuthPlugin` at all — is in scope,
since that's the actual use case a self-contained JWT exists for. Not yet
settled: how it's packaged.

1. Does it live as a subpath export of `@effect-auth/jwt` itself (e.g.
   `@effect-auth/jwt/verify`), tree-shaken so a consumer that only imports
   that path never pulls in `AuthPlugin`/`Sessions`/`@effect-auth/core` —
   or does it need to be a wholly separate package? The original 20-package
   plan (`spec/overview.md`) didn't include `@effect-auth/jwt` at all
   (ticket 00), so adding a 21st package for this is a bigger structural
   change than a subpath export and deserves its own explicit call, not a
   default.
2. What's its actual dependency floor? "Zero effect-auth footprint" was
   about not depending on `AuthPlugin`/`Sessions`/core services — it
   presumably still depends on `effect` itself (already this whole
   ecosystem's baseline) and whatever HTTP-fetch primitive it uses to pull
   JWKS. Confirm that's the intended boundary, not literally zero
   dependencies.
3. Does the lite verifier implement JWKS fetching/caching/refresh-on-
   unknown-`kid` itself, sharing the actual verification logic (claims
   checks, algorithm allowlist) with the full plugin's own `verify` via a
   common internal module both import — or does it duplicate that logic
   to stay genuinely standalone? (This echoes ticket 00's `oauth/Jwt.ts`
   fog note — same shape of question, different pair of modules.)
4. Does the lite verifier ever get access to the `sid`-based live-
   revocation-check opt-in (already decided as part of the full plugin's
   `verify`, ticket 05), or is that necessarily unavailable to it — a
   downstream service with no session-store access can't perform a live
   check regardless of packaging, so this may just be a documented
   limitation rather than an open question. Confirm.


## Answer

Subpath export of `@effect-auth/jwt` itself — `@effect-auth/jwt/verify`
(exact subpath name TBD at implementation time) — not a 21st package.
Reasoning: the original 20-package plan never anticipated this need, and a
whole extra package (its own `package.json`, versioning, release surface)
is disproportionate to what's actually being isolated — one module with a
deliberately narrow import graph. `package.json`'s `exports` map gets a
second entry pointing at a `src/verify.ts` (or similarly named) module that
imports nothing from `@effect-auth/core`/`server`/`AuthPlugin` — enforced
by convention and checked by this repo's existing `pnpm circular`-style
tooling extended to also flag a cross-boundary import into `verify.ts`,
not by a build-time package boundary.

Dependency floor: `effect` itself (this whole ecosystem's baseline) plus
whatever HTTP-fetch primitive JWKS retrieval needs (`effect/unstable/http`'s
client, already a transitive dependency at this stratum) — not literally
zero dependencies, just zero dependency on `AuthPlugin`/`Sessions`/core
services.

The lite verifier and the full plugin's own `verify` share one internal
module implementing the actual claims/algorithm-allowlist checks and JWKS
key selection (mirroring `packages/oauth/src/Jwt.ts`'s own `findKey`
shape) — both import it; neither duplicates it. JWKS fetching/caching
(refresh-on-unknown-`kid`) lives in that same shared module, parameterized
over just an `HttpClient` and a JWKS URL, so both the lite verifier and the
full in-process plugin drive it identically.

The `sid`-based live revocation check (ticket 05) is confirmed
unavailable to the lite verifier — it has no session-store access by
design, so this is a documented limitation of the lite path, not an open
question. A downstream service that needs live revocation awareness must
either run the full plugin (has `Sessions`) or implement its own
out-of-band check against whatever it's told about `sid`.
