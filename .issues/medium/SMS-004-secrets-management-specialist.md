---
ID: "SMS-004"
Title: "CSRF and challenge-cookie HMAC secrets ship without any Config/env loading layer"
Level: medium
Category: "security"
Status: resolved
Package: "server"
Source: "packages/server/src/Csrf.ts:26"
Auditor: "secrets-management-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SMS-004 — CSRF and challenge-cookie HMAC secrets ship without any Config/env loading layer

`MEDIUM` · `security` · `server` · reported by **Secrets Management Specialist** (`secrets-management-specialist`)

Status: **resolved**

## Summary

CsrfConfig and passkey's ChallengeCookieConfig (packages/passkey/src/ChallengeStore.ts:238-239, same posture) are bare Context.Service tags the application must fill via Layer.succeed - there is no shipped layer reading a Config.Redacted(...) value, unlike KeyProvider.layerEnv. 'Never defaulted' is enforced only by the type demanding a value, so the path of least resistance for an app author - exactly what this repo's own tests model (packages/server/test/Csrf.test.ts:73, Redacted.make("test-csrf-secret") inline) - is a literal in source, which is where real secrets end up in source control. BEH-EA-126's principle (wiring names the env var, never the value) is implemented for OAuth client secrets but not for these two signing secrets.

## Evidence

Source: `packages/server/src/Csrf.ts:26`

```
/** BEH-EA-075: signs the double-submit cookie; never a default in production. */
  readonly secret: Redacted.Redacted<string>;
```

## Recommended fix

Add Csrf.layerConfig / ChallengeStore.layerConfig factories reading Config.Redacted("AWTHAQ_CSRF_SECRET") and Config.Redacted("AWTHAQ_CHALLENGE_COOKIE_SECRET") with a minimum-length validation, mirroring KeyProvider.layerEnv's loud-failure pattern.

## Context

- Auditor verdict on this domain: **needs-work** (score 64/100), domain: secrets management
- Full dossier: [`secrets-management-specialist`](../../.reports/secrets-management-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 38 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ACS-005` — RFC 2104 HMAC-SHA256 hand-rolled and duplicated across plugins](low/ACS-005-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`ACS-007` — No minimum length enforced on HMAC signing secrets](low/ACS-007-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`CDS-005` — siteCheck passes same-site and header-less requests — safe only while the double-submit leg actually runs](medium/CDS-005-csrf-defense-specialist.md) `_(csrf-defense-specialist, medium)_`
- [`CDS-006` — CSRF token is not bound to the session and never expires](low/CDS-006-csrf-defense-specialist.md) `_(csrf-defense-specialist, low)_`
- [`MNA-008` — __Host-csrf cookie set without Secure - same prefix violation class, currently latent](low/MNA-008-mobile-native-auth-specialist.md) `_(mobile-native-auth-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `hmac-secret-hygiene`. Evidence at HEAD ec065a7: `packages/server/src/Csrf.ts:24`. Fix: Ship Config-backed layers for the CSRF secret and origins (mirroring KeyProvider.layerEnv), so the obvious path never puts a literal secret in source. (effort S). Full dossier: `.plan/slices/06-server-api.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Csrf.layerConfig (packages/server/src/Csrf.ts): CsrfConfig from AWTHAQ_CSRF_SECRET (Config.Redacted, required, >= 32 bytes else WeakSigningSecret dies) and AWTHAQ_CSRF_ALLOWED_ORIGINS (Config.Array, default []). Tests in server/test/Csrf.test.ts (reads both vars, defaults origins, missing secret -> ConfigError, short secret dies WeakSigningSecret). README Configuration table gains the row. Deferred: ChallengeStore.layerConfig (AWTHAQ_CHALLENGE_COOKIE_SECRET) belongs to the passkey program; examples/memory-server keeps its checked-in dev-only placeholder (switching it would make the demo need an env var). The 32-byte floor is enforced inside layerConfig; enforcement inside CsrfProtectionLive itself is ACS-007, left open (see its Plan note).
