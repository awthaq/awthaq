---
ID: "THS-002"
Title: "BeforeSessionIssue divert point does not exist in production code; Sessions.issue and password.signIn consult no hook"
Level: high
Category: "architecture"
Status: resolved
Package: "core"
Source: "packages/core/src/Sessions.ts:226"
Auditor: "totp-hotp-mfa-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# THS-002 — BeforeSessionIssue divert point does not exist in production code; Sessions.issue and password.signIn consult no hook

`HIGH` · `architecture` · `core` · reported by **TOTP/HOTP MFA Specialist** (`totp-hotp-mfa-specialist`)

Status: **resolved**

## Summary

The generic divert mechanism is real and tested (HookPoint.divert, BEH-EA-089..096), but the specific point the whole two-factor design depends on exists only as a local fixture in core/test/HookPoint.test.ts:112 — no production class declares it. Both Sessions.issue layers (memory at :226, SQL at :431) mint sessions without consulting any hook point, and password.signIn goes straight from credential verification to sessions.issue (packages/password/src/Password.ts:559). Meanwhile features/04-cross-cutting/12-hooks.feature:96 narrates 'the BeforeSessionIssue hook point tapped by the two-factor plugin's step-up tap' as an implemented scenario, and spec/models/06-two-factor-totp.md:100 admits 'no BeforeSessionIssue hook point exists to tap into'. The design's core guarantee — no session minted until the second factor succeeds — has nowhere to attach.

## Evidence

Source: `packages/core/src/Sessions.ts:226`

```
    const issue: SessionsShape["issue"] = Effect.fnUntraced(function* (input) {
      if (input.supersedes !== undefined) {
```

## Recommended fix

Declare BeforeSessionIssue as a real HookPoint.divert in core (input: userId + issuance context; diverted: a typed TwoFactorRequired-style outcome), run it in both Sessions.issue layers (or in password.signIn before issue, consistently), and port the test fixture to the production declaration. Add the missing steps test for the REQ-EA-251 scenario so the BDD file stops narrating unwired behavior.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 24/100), domain: TOTP/HOTP MFA
- Full dossier: [`totp-hotp-mfa-specialist`](../../.reports/totp-hotp-mfa-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-007` — Redundant assertion after sound narrowing in session supersedes path](low/AH-007-anders-hejlsberg.md) `_(anders-hejlsberg, low)_`
- [`AGA-004` — No cookie carries CHIPS Partitioned; embedded deployments cannot authenticate](medium/AGA-004-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, medium)_`
- [`APS-010` — All principal identifiers are UUIDv7: time-ordered, partially predictable](info/APS-010-auth-pentest-specialist.md) `_(auth-pentest-specialist, info)_`
- [`BO-005` — Session cookie is a browser-session cookie while the server session lives 30d — browser close forces re-login](medium/BO-005-balazs-orban.md) `_(balazs-orban, medium)_`
- [`BAM-003` — Session cutover invalidates every live better-auth session with no bridge](high/BAM-003-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`DRS-004` — Session token carries no shard/region hint; verify is a bare findById that needs a global directory under any partitioning](medium/DRS-004-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, medium)_`
- [`ECF-007` — issue(supersedes) is a two-step delete-then-insert with no transaction or interruption guard](low/ECF-007-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`EEM-008` — Internal Data.TaggedError classes carry stringly message fields and reuse wire tag names verbatim](low/EEM-008-effect-error-management-specialist.md) `_(effect-error-management-specialist, low)_`
- … 29 more findings touch `packages/core/src/Sessions.ts`

## Comments

_Triage notes and discussion append here._

**Decision (2026-09-19):** Resolved via [Hook point wiring completeness across auth flows](../../.scratch/resolve-ready-for-human-findings/issues/03-hook-point-wiring-completeness.md) — `Hooks.BeforeSessionIssue` declared as a real `HookPoint.divert` in new `packages/core/src/Hooks.ts`, consulted at each plugin's own sign-in call site (password.signIn, oauth.callback, passkey.authenticate) immediately before `sessions.issue`, diverting to a typed `TwoFactorRequired` outcome — not centralized inside `Sessions.issue` itself, so admin impersonation and token-rotation reissue are unaffected. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — `BeforeSessionIssue` only exists as a local fixture in `packages/core/test/HookPoint.test.ts:112`; grep over every package's `src` finds zero production `HookPoint.divert` declarations. Both `Sessions.issue` layers (memory `packages/core/src/Sessions.ts:226`, SQL `:431`) mint sessions with no hook check, and `password.signIn` (`packages/password/src/Password.ts:516`) goes straight from credential verification to `sessions.issue`. Declaring the divert point and deciding where exactly it's consulted (Sessions vs. each plugin's sign-in) is an architecture decision, not a mechanical patch. Status → ready-for-human.

**Resolved (2026-09-20):** Duplicate of [`AOMS-006`](AOMS-006-auth0-okta-migration-specialist.md), which carries the full resolution — this finding's own specific ask is fully covered: `Hooks.BeforeSessionIssue`, a real `HookPoint.divert` in new `packages/core/src/Hooks.ts` (ported from exactly the `test/HookPoint.test.ts` fixture shape this finding names, into production code), is consulted at `password.signIn`, `oauth.callback`, and `passkey.authenticateVerify` — consistently at each plugin's own sign-in call site, per this finding's own recommended fix's "or... consistently" branch — never inside `Sessions.issue` itself (which is also called for admin impersonation and same-session token rotation, neither of which is "a first factor just succeeded"). Verified by dedicated mutation-tested `packages/password/test/PasswordHooksSignIn.test.ts`, `packages/oauth/test/OAuthHooksSignIn.test.ts`, and `packages/passkey/test/PasskeyHooksSignIn.test.ts`.

**Out of scope**: this finding's own recommended fix additionally asks to "add the missing steps test for the REQ-EA-251 scenario" in `features/features/04-cross-cutting/12-hooks.feature`, so the BDD file stops narrating unwired behavior. Left untouched here, deliberately — it's one scenario within the much larger BDD feature-wiring gap `AH-003`/`BDD-002` already track (500 of 628 scenarios across the whole suite never execute) as its own dedicated multi-session effort; wiring one scenario from inside this ticket would freelance ahead of that effort's own risk-based prioritization.
