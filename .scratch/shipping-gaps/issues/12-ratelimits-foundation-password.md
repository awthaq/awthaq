# 12 — RateLimits foundation + Password-plugin rules

**What to build:** `TestAuth` provides a real `RateLimits.layer` by
default, and sign-in, sign-up, reset-request, and reset-confirm are all
throttled in practice.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

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
