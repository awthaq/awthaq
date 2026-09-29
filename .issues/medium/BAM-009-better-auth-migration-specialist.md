---
ID: "BAM-009"
Title: "User profile surface cannot receive better-auth user fields: no image, no email change"
Level: medium
Category: "api"
Status: resolved
Package: "core"
Source: "packages/core/src/Users.ts:62"
Auditor: "better-auth-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BAM-009 — User profile surface cannot receive better-auth user fields: no image, no email change

`MEDIUM` · `api` · `core` · reported by **better-auth Migration Specialist** (`better-auth-migration-specialist`)

Status: **resolved**

## Summary

UserRecord is id/email/emailVerified/name/timestamps only — better-auth's User.image has no column, and updateProfile accepts { name } alone, so there is no domain operation to change an email at all (better-auth core has changeEmail with verification). The User model likewise lacks better-auth admin-plugin fields (role, banned, banReason, banExpires). Field-for-field import per BEH-EA-207's no-silent-drop rule is impossible for these columns today.

## Evidence

Source: `packages/core/src/Users.ts:62`

```
readonly updateProfile: (
```

## Recommended fix

Add an image column (nullable) and an email-change operation with re-verification semantics; decide and document where better-auth's role/banned columns map ( BAM-005/BAM-006) so the import command has an explicit target for every source field.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: better-auth parity
- Full dossier: [`better-auth-migration-specialist`](../../.reports/better-auth-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 46 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AOMS-002` — UserRecord has no metadata field: Auth0 user_metadata/app_metadata have no storage target](high/AOMS-002-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`AOMS-008` — No bulk user import/export surface anywhere in the monorepo](medium/AOMS-008-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, medium)_`
- [`BE-007` — User profile is a closed shape — no user-field extension point for apps or plugins](medium/BE-007-bereket-engida.md) `_(bereket-engida, medium)_`
- [`EEM-006` — PlatformError sits in core typed channels, taxing every plugin call site with a die mapping](medium/EEM-006-effect-error-management-specialist.md) `_(effect-error-management-specialist, medium)_`
- [`ESS-008` — Three _tag strings duplicated across the Data and Schema error taxonomies](medium/ESS-008-effect-schema-specialist.md) `_(effect-schema-specialist, medium)_`
- [`FAMS-002` — UserRecord requires an email; Firebase anonymous and phone users cannot be represented](high/FAMS-002-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, high)_`
- [`GC-004` — Memory and SQL implementations of Users diverge on race failure modes](medium/GC-004-giulio-canti.md) `_(giulio-canti, medium)_`
- [`MW-007` — Users port requires a full 7-method shape — no partial-adapter path for immutable/legacy stores](medium/MW-007-matias-woloski.md) `_(matias-woloski, medium)_`
- … 3 more findings touch `packages/core/src/Users.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `users-profile-surface`. Evidence at HEAD ec065a7: `packages/core/src/Users.ts:96`. Fix: Add a nullable image field and a verified email-change primitive to Users; document better-auth field mapping. (effort L). Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Closed by commit 4b63d9e for the dossier's steps 1, 2 and 4 (the program-table scope: 'nullable image field and a verified email-change primitive to Users'). image: User.image column (migration 22), UserRecord.image Option, updateProfile image (client-writable; the HTTP payload's image is optional|null, bounded <= 2048 and http(s)-only via AccountContract.ImageUrl — a stored javascript:/data: URL would be an XSS vector), AccountDto {identity, name, image}. Users.changeEmail(id, newEmail): lower-cases, EmailAlreadyExists on conflict, resets emailVerified (BEH-EA-042's one permitted lowering; spec revised), no-op for the current address, IdentityMismatch for a non-Email user; the repository side is one guarded UPDATE ... RETURNING. better-auth field mapping documented in packages/migrate-better-auth/README.md. Tests: core Users.test.ts (both layers: image set/keep/clear; changeEmail resets verified, moves the uniqueness key, frees the old address), sql contract, server AuthHttp 'PATCH /user sets the avatar (http(s) only)'. DEFERRED (Plan note): dossier step 3, the password plugin's mailed change-email flow (Verification.issue('change-email:<userId>', {newEmail}) to the NEW address; consume -> changeEmail + verifyEmail in one transaction). It adds two endpoints, rate-limit rules and mail templates to packages/password (owned by other programs); Users.changeEmail is the primitive it will call and the purpose is reserved in BEH-EA-057. Until then no HTTP path can change an email at all, so 'only via a verified flow' holds trivially.

**Resolved (2026-09-29):** P21a: the deferred dossier step 3 landed. @awthaq/password POST /change-email (authenticated; mails core EmailChange's change-email token to the NEW address via VerificationLink, awaited with typed MailDeliveryFailed -> 502 EmailDeliveryFailed, EmailChangeNotSupported 409 for a non-email identity, same address a no-op, rate limits: requester 5/h, target inbox 3/15min across requesters, no ownership oracle at request time) and POST /change-email/confirm (public; VerificationLink.decode by purpose, then one SqlTransaction: consume + Users.changeEmail + Users.verifyEmail; EmailAlreadyExists 409 rolls the consumption back; publishes auth.user.emailChanged and dispatches an email-changed notice to the previous address through MailDispatch). PasswordConfig.links.changeEmail. Tests: PasswordChangeEmail.test.ts (10) and AuthHttp.test.ts end to end. The same token is what an administrator's setUserEmail (BAM-005) mints.
