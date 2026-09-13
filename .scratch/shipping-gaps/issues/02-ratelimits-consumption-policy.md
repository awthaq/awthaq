# 02 — RateLimits consumption policy

**Type:** grilling
**Status:** resolved
**Blocked by:** None — can start immediately

## Question

`packages/core/src/RateLimits.ts` defines a real `RateLimitsRegistry`
(`Context.Service`, `Ref`-backed scoped state, a `rule()` helper,
`RateLimitScopeViolation`/`RateLimitsFrozen` errors) that no plugin calls
today — `packages/test/src/TestAuth.ts`'s own header comment says as
much: "no plugin built so far calls `RateLimits.rule`." This is dead
machinery risking rot before its first real consumer, and the brute-force
surface it exists to protect (sign-in, password reset request, OAuth
callback) is unguarded in the meantime.

Decide: (a) which call sites get a rule first — sign-in is the obvious
starting point (credential-stuffing/brute-force), request-password-reset
is the second (enumeration/spam), OAuth callback the third; is that the
full initial set, or does e.g. sign-up (registration spam) belong too?
(b) what limits — window/count per rule, and is that a hardcoded default
per plugin or configurable at `Auth.make` composition time (matching this
codebase's plugin-config conventions elsewhere)? (c) how does
`TestAuth.layer` wire `RateLimits.layer` once there's a real consumer —
does every dual-backend contract test need to account for rate-limit
state now, or does `TestAuth` provide a permissive/no-op limiter by
default with a separate layer for tests that specifically exercise
limiting? (d) is per-identity (user id) or per-IP (request-derived) the
correct rate-limit key for each rule, given this is a library other
services embed rather than a standalone server that necessarily sees raw
client IPs?

## Answer

**Call sites (every mutating endpoint).** Sign-in, sign-up, reset-request,
reset-confirm, change-password (ticket 01), and OAuth callback all get a
rule from day one — not a phased rollout. This intentionally exceeds the
ticket's own "obvious starting point" framing, per the richer-option
standing preference.

**Key strategy (dual-keyed per rule, not one global strategy).** Sign-in
keys on *both* attempted-identity and source IP (catches distributed
credential stuffing against one account and single-IP sprays across many
accounts); reset-request and change-password key on identity/email;
sign-up and OAuth callback key on IP alone, since no identity exists yet
at that point in the flow. Because this is an embedded library, IP
extraction must be caller-suppliable (not assumed from a raw socket) —
the exact mechanism (a request-context param threaded through, versus a
new slot similar to `PrincipalResolver`) is an implementation detail for
`/to-tickets`, not re-opened here.

**`TestAuth` wiring.** `RateLimits.layer` gets provided by default now
that real consumers exist (superseding the current "no plugin calls
`RateLimits.rule`" comment in `TestAuth.ts`). Whether the default window
is generous enough not to break existing dual-backend contract tests is
an implementation-time check, not a re-opened design question; tests that
specifically want to exercise limiting get a tightened-window test layer
instead of the permissive default.
