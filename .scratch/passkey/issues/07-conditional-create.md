# 07 — Conditional-create registration endpoint

**What to build:** a second, dedicated registration-options endpoint,
`register/options/conditional`, session-bound and accepting the relaxed
UP=0/UV=0 flags Chrome's conditional-create flow produces — the ordinary
`register/options` endpoint continues to require normal UP/UV. Ships
enabled by default (`conditionalCreate` config, default `true`), per the
richness-over-simplicity decision made during this spec's grilling session.

**Blocked by:** 06 — Passkey plugin scaffold and registration ceremony

**Status:** done

- [ ] `register/options/conditional` requires an existing session (never
      anonymous) — distinct from the ordinary registration path, which may
      be reached pre-session in some flows
- [ ] A response verified through this endpoint's path accepts UP=0/UV=0;
      the ordinary `register/verify` path continues to reject them
- [ ] `PasskeyConfig.conditionalCreate` defaults to `true`; setting it to
      `false` removes/disables this endpoint for that installation
- [ ] Persists a credential through the exact same verify-then-persist
      logic ticket 06 established — no separate, parallel persistence path

## Result

Done, with one real bug found and fixed during `/code-review`'s Spec axis: `PasskeyConfig.conditionalCreate` was stored but never actually checked anywhere, so `register/options/conditional` was always reachable regardless of the flag. Fixed by adding a real check (and a new typed error, `PasskeyConditionalCreateDisabled`, 404 — "disabled" reads the same as "absent," not a distinguishable feature-flag response) in `registerOptionsConditional`, covered by a domain-level test. `register/options/conditional` requires a session; UP=0/UV=0 accepted via a relaxed `authenticatorSelection` and by not enforcing UV for challenges consumed from the conditional scope; persistence reuses the exact same `registerVerify` path as ticket 06 — no parallel persistence logic.
