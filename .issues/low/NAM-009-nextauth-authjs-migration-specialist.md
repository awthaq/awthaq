---
ID: "NAM-009"
Title: "User.image / OAuth picture dropped: avatar data has no destination"
Level: low
Category: "dx"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuthProvider.ts:33"
Auditor: "nextauth-authjs-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# NAM-009 — User.image / OAuth picture dropped: avatar data has no destination

`LOW` · `dx` · `oauth` · reported by **NextAuth.js/Auth.js Migration Specialist** (`nextauth-authjs-migration-specialist`)

Status: **resolved**

## Summary

Auth.js's adapter `users` table carries `image` and every built-in provider preset maps `picture`/`avatar_url` into it; effect-auth's User model (Models.ts:40-56: id, email, emailVerified, name, createdAt, updatedAt) and OAuthProfile (subject, email, emailVerified, name) both lack the field, and mapProfile has nowhere to put it even if a provider sends it. A migrated user base silently loses all avatars, and an app rendering `session.user.image` (Auth.js's default session shape includes it) breaks at the type level after migration — good (compile error, not runtime), but still an unlisted schema translation task.

## Evidence

Source: `packages/oauth/src/OAuthProvider.ts:33`

```
export interface OAuthProfile {
  readonly subject: string;
  readonly email?: string;
```

## Recommended fix

Either add an optional image column to User and picture to OAuthProfile, or document avatar handling as app-owned extension data (SessionViewExtension slot) in the migration mapping table.

## Context

- Auditor verdict on this domain: **needs-work** (score 55/100), domain: Auth.js Migration Parity
- Full dossier: [`nextauth-authjs-migration-specialist`](../../.reports/nextauth-authjs-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 27 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-007` — quirks.skipPkce is not gated to confidential clients, so a public client can run code flow without PKCE](medium/AP-007-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AH-003` — Discovery document asserted without validation at provider boot](low/AH-003-anders-hejlsberg.md) `_(anders-hejlsberg, low)_`
- [`BO-009` — OAuth provider config: no vendor presets and Effect Config descriptions leak into user-facing typing](low/BO-009-balazs-orban.md) `_(balazs-orban, low)_`
- [`ESS-002` — OIDC discovery document cast, not decoded, at plugin boot](high/ESS-002-effect-schema-specialist.md) `_(effect-schema-specialist, high)_`
- [`IC-003` — Zero OAuth provider presets — every app hand-assembles issuer/endpoints/mapProfile](medium/IC-003-iain-collins.md) `_(iain-collins, medium)_`
- [`JR-009` — oidc() factory does not require the openid scope; a mis-scoped provider surfaces only as an undifferentiated runtime 400](low/JR-009-justin-richer.md) `_(justin-richer, low)_`
- [`MW-010` — OAuth providers are mechanism-only: no shipped preset catalog raises per-customer integration cost](info/MW-010-matias-woloski.md) `_(matias-woloski, info)_`
- [`NAM-003` — Zero vendor provider presets — every Auth.js provider must be hand-translated](medium/NAM-003-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, medium)_`
- … 2 more findings touch `packages/oauth/src/OAuthProvider.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `user-profile-image`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuthProvider.ts:33`. Fix: Add an optional `image` to OAuthProfile and the User model so mapProfile can carry avatars (Auth.js/better-auth parity). (effort M). Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Closed by commit 4b63d9e. OAuthProfile.image (optional) + profileOf(image) + google (picture), github (avatar_url), gitlab (picture) presets; OAuth JIT sign-up stores it as User.image only when it passes AccountContract.ImageUrl (http(s), <= 2048 chars — an untrusted claim ending up in a client-visible field); User.image column (migration 22); Users.updateProfile image?: string|null (omitted keeps, null clears). Tests: oauth 'an http(s) avatar from the profile lands on the created user', 'a non-http(s) avatar claim (javascript:, data:) is never stored', OAuthPresets image mapping.
