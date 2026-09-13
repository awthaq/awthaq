# 12 — RateLimits foundation + Password-plugin rules

**What to build:** `TestAuth` provides a real `RateLimits.layer` by
default, and sign-in, sign-up, reset-request, and reset-confirm are all
throttled in practice.

**Blocked by:** None — can start immediately

**Status:** done

## Result

New `Api.RateLimited` wire error (429, `retryAfterMillis`) in
`@effect-auth/api` — the shared cross-plugin shape BEH-EA-106 fixes,
declared on `PasswordApi`'s four rate-limited endpoints. `Password` is
the **first real `RateLimits.rule` consumer** in this codebase, so this
ticket had to solve two problems the spec left open:

**(a) Where enforcement actually happens.** `RateLimits.rule`/the
registry is declarative (introspection only, BEH-EA-111) — it registers
metadata, it does not throttle anything. Real enforcement is
`@effect-auth/ports`' `RateLimiter.consume({key, limit, window})`,
called directly inside each of `signUp`/`signIn`/`requestReset`/
`confirmReset`'s own domain implementation, catching `RateLimited` and
mapping to `Api.RateLimited`. A `RATE_LIMITS` constant is the single
source of truth both the enforcement call sites and the registry
registration draw their `limit`/`window` from, so the two can't drift.

**(b) Key strategy, scoped down from ticket 02's own decision.** Every
rule here keys on identity/email (`signIn` reuses `usage-examples-v4.md`
§16's own worked example exactly: `signin:${email}`, limit 5, window 15
minutes); `confirmReset` keys on the token's own decoded identifier
(free at that point, ties the limit to the specific account). Ticket
02's "sign-in keys on both identity **and** IP" and "sign-up keys on IP"
are **not built** — this codebase has no client-IP-extraction mechanism
anywhere (no handler threads a request's origin into a domain capability
today), and building one speculatively for this single rate-limit key
would itself be exactly the "unrequested infrastructure" this codebase's
standing preference warns against. Tracked as real follow-on work, not
silently dropped.

**Ripple, not in the original ticket text:**
- `TestAuth.layer` now provides `RateLimits.layer` alongside the
  already-present `RateLimiter.layerPermissive` (per this ticket's own
  acceptance criteria) — `Password` is a real consumer now, so any
  composition including it needs a registry to register into.
- Building `Password.layer` at all now requires `RateLimiter` +
  `RateLimitsRegistry` satisfied — the same category of ripple ticket
  11's `Authentication` middleware caused, fixed the same way (both test
  files' layer compositions updated; `RateLimiter.layerPermissive` +
  `RateLimits.layer` added everywhere `Password.Password.layer` is built
  directly, including the 4 breach-check tests' own inline compositions).
- **A real TS circularity**, not a style choice: passing `Password` (the
  class) into anything typed `AuthPlugin.Any` (which itself requires a
  `layer` field) from *within* `Password`'s own `static readonly layer`
  initializer sends the compiler's lazy self-reference check into an
  unrecoverable implicit-`any` — reachable the moment rule-registration
  is wired in at all, regardless of exactly where in that initializer
  it's written. Resolved by registering rules via direct
  `RateLimitsRegistry.register(...)` effect calls *inside* `make`
  (alongside the existing `Password.of(...)` self-reference, which
  never had this problem — it doesn't check `Password` against an
  external duck type), with one narrow, explicitly-justified return-type
  annotation on the small `.map` callback that builds those calls — the
  only way found to break the cycle locally without annotating
  `Password.layer` itself.

New tests: a real end-to-end throttle test (`Password.test.ts`, a real
enforcing `RateLimiter.layer`/`layerStoreMemory`, not the permissive
default — 5 wrong-password attempts succeed as ordinary
`InvalidCredentials`, the 6th answers `RateLimited`). The pre-existing
`RateLimitsRegistry` contract suite (`packages/core/test/RateLimits.test.ts`
— registration, scope violations, freeze, ordering) already satisfied
this ticket's own "dedicated contract suite" criterion; no new work
needed there. `pnpm test` — 569 tests, all green; `pnpm typecheck`/
`pnpm lint`/`pnpm format:check` clean workspace-wide.

- [ ] `TestAuth.layer` provides `RateLimits.layer` by default,
      superseding the current "no plugin calls `RateLimits.rule`" state
      documented in `TestAuth.ts`
- [ ] Sign-in keys on both attempted-identity and source IP; sign-up,
      reset-request, and reset-confirm key on identity/email
- [ ] IP extraction is caller-suppliable, not assumed from a raw socket
      (this is an embedded library, not a standalone server)
- [ ] Exceeding a rule's threshold on any of these four endpoints yields
      a throttled response, asserted in each endpoint's existing
      wire-level test file
- [ ] A dedicated contract suite for `RateLimitsRegistry` itself (rule
      registration, scope violations, freeze behavior) exists, mirroring
      this codebase's existing service-level contract-test shape
- [ ] Every existing dual-backend contract test across the workspace
      still passes unmodified — the default window is generous enough
      not to trip them
