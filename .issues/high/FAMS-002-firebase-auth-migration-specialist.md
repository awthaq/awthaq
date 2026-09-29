---
ID: "FAMS-002"
Title: "UserRecord requires an email; Firebase anonymous and phone users cannot be represented"
Level: high
Category: "architecture"
Status: resolved
Package: "core"
Source: "packages/core/src/Users.ts:31"
Auditor: "firebase-auth-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# FAMS-002 — UserRecord requires an email; Firebase anonymous and phone users cannot be represented

`HIGH` · `architecture` · `core` · reported by **Firebase Auth Migration Specialist** (`firebase-auth-migration-specialist`)

Status: **resolved**

## Summary

Users.create demands { email, name } and UserRecord.email is a required string, so effect-auth has no email-less identity. Firebase's signInAnonymously creates real, upgradeable user rows with no email, and phone-auth users carry only a phoneNumber. Neither can be imported except by inventing a placeholder email — which the codebase itself already does as a smell on the OAuth JIT path, where a provider without email becomes the synthetic address `${providerId}:${profile.subject}` (packages/oauth/src/OAuth.ts:686). The AnonymousPrincipal that does exist (packages/api) is an unauthenticated caller marker, not a persisted anonymous account, and can never be upgraded via account link because it has no user row.

## Evidence

Source: `packages/core/src/Users.ts:31`

```
/** BEH-EA-041: always the lower-cased form of whatever email was given. */
readonly email: string;
readonly emailVerified: boolean;
```

## Recommended fix

Make email optional on UserRecord (or introduce an identity-kind field with email/phone/none), keep the byEmail index conditional, and add an anonymous-account creation path through Sessions so Firebase anonymous users can be imported and later upgraded via Accounts.link, mirroring Firebase's linkWithCredential semantics.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: Firebase migration parity
- Full dossier: [`firebase-auth-migration-specialist`](../../.reports/firebase-auth-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AOMS-002` — UserRecord has no metadata field: Auth0 user_metadata/app_metadata have no storage target](high/AOMS-002-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`AOMS-008` — No bulk user import/export surface anywhere in the monorepo](medium/AOMS-008-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, medium)_`
- [`BE-007` — User profile is a closed shape — no user-field extension point for apps or plugins](medium/BE-007-bereket-engida.md) `_(bereket-engida, medium)_`
- [`BAM-009` — User profile surface cannot receive better-auth user fields: no image, no email change](medium/BAM-009-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, medium)_`
- [`EEM-006` — PlatformError sits in core typed channels, taxing every plugin call site with a die mapping](medium/EEM-006-effect-error-management-specialist.md) `_(effect-error-management-specialist, medium)_`
- [`ESS-008` — Three _tag strings duplicated across the Data and Schema error taxonomies](medium/ESS-008-effect-schema-specialist.md) `_(effect-schema-specialist, medium)_`
- [`GC-004` — Memory and SQL implementations of Users diverge on race failure modes](medium/GC-004-giulio-canti.md) `_(giulio-canti, medium)_`
- [`MW-007` — Users port requires a full 7-method shape — no partial-adapter path for immutable/legacy stores](medium/MW-007-matias-woloski.md) `_(matias-woloski, medium)_`
- … 3 more findings touch `packages/core/src/Users.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/core/src/Users.ts:29-32` still declares `readonly email: string; readonly emailVerified: boolean;` as required, non-optional fields on `UserRecord`, and the synthetic-email smell on the OAuth JIT path (`packages/oauth/src/OAuth.ts:686` area) is present. Making email optional (or adding an identity-kind field) touches the core domain invariant (`byEmail` index, verification flows) used across every plugin — a genuine architecture decision, not a mechanical patch. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [UserRecord model extension (optional email, phone/anonymous identity, deactivation state)](../../.scratch/resolve-ready-for-human-findings/issues/09-userrecord-model-extension.md) — `UserRecord.email: string` is replaced by a tagged `UserIdentity` union (`Email`/`Phone`/`Anonymous`), with a new `Users.promoteIdentity` upgrade path retiring the `OAuth.ts` synthetic-email workaround and enabling anonymous-account upgrade. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `users-identity-model`. Evidence at HEAD ec065a7: `packages/core/src/Users.ts:51`. Fix: Implement ticket 09: UserRecord.identity: UserIdentity union + status, widened create, promoteIdentity, setStatus, dialect-branched migrations, and retire OAuth's synthetic email. (effort XL). Full dossier: `.plan/slices/01-core-sessions-users.md`.

**Resolved (2026-09-29):** P14 commit 4b63d9e. Implemented wayfinder ticket 09 as designed. core Users.ts: UserIdentity = Email{email,emailVerified} | Phone{phone: E164,phoneVerified} | Anonymous; UserRecord {id, identity, name, metadata, image, status, statusReason, suspendedUntil, createdAt, updatedAt}; create({identity,name,metadata?,image?}) failing EmailAlreadyExists|PhoneAlreadyExists; findByPhone; promoteIdentity (Anonymous -> Email/Phone in place, IdentityMismatch otherwise); verifyPhone; setStatus; emailOf/phoneOf/isEmailVerified/accountLabel helpers. sql: Models.User (email/phone NullOr, phoneVerified, status, image; identity and status columns excluded from update/jsonUpdate), CoreMigrations 21 (make_users_email_nullable: pg DROP NOT NULL, sqlite table rebuild), 22 (phone/phoneVerified/status/statusReason/suspendedUntil/image), 23 (partial unique users_phone_unique), UsersRepository findByPhone/insertIfAbsent/verifyPhone/promoteIdentity/changeEmail/setStatus as targeted UPDATE ... RETURNING. toUserRecord folds the columns into the union (a row with both email and phone dies with a defect). Call sites: oauth (a profile with no email now creates an Anonymous user; the synthetic providerId:subject email is gone), password (mail only to an Email identity), passkey (WebAuthn user name via Users.accountLabel), organization (invitations match Users.emailOf), server Account DTO + Authentication (identity-aware AccountDto {id, identity, name, image}), admin UserDto, qadi email/emailVerified readers (undefined for non-Email), migrate-auth0, Hooks.BeforeUserDelete.email now optional. Tests: core Users.test.ts (both layers: Anonymous, Phone, promoteIdentity, verifyPhone, uniqueness), sql CoreMigrations.test.ts (rows written under the pre-change schema survive the sqlite rebuild; lower(email) unique index survives; NULL emails coexist; phone unique), sql contract.ts (repository ops on sqlite/file/libsql/postgres), oauth 'profile without an email creates an Anonymous user, never a synthetic email'. Red proof: the type change itself made the whole old suite fail to compile (the red state); the new behaviour tests were then written against it. Gates: typecheck 0 errors incl. tsconfig.test.json; vitest 1894 passed; test:bdd 113 passed; spec:verify:strict PASS; scripts/test-pg.sh against real postgres:16: 20 files / 384 tests passed incl. the core Users + UserImport suites; oxlint clean on touched packages (only pre-existing HttpApiTypes.test.ts / PasskeyClient warnings). Spec: BEH-EA-041/042/046 revised in place (spec/behaviors/06 rev 1.1). Deferred: new Gherkin scenarios for the revised behaviours (no new BEH ids were minted, so spec:verify stays contiguous at 224).
