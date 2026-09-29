---
ID: "SCP-004"
Title: "Users mutation surface cannot express SCIM PATCH: updateProfile accepts {name} only"
Level: medium
Category: "api"
Status: resolved
Package: "core"
Source: "packages/core/src/Users.ts:62"
Auditor: "scim-provisioning-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SCP-004 — Users mutation surface cannot express SCIM PATCH: updateProfile accepts {name} only

`MEDIUM` · `api` · `core` · reported by **SCIM Provisioning Specialist** (`scim-provisioning-specialist`)

Status: **resolved**

## Summary

The only write path on UsersShape after create is updateProfile restricted to {name}; email is immutable post-create (verifyEmail only flips emailVerified one-way) and no operation can change or suspend anything else. SCIM PUT/PATCH routinely updates userName/emails/active; every such operation would require a core change per attribute rather than a plugin-local implementation, contradicting the spec's claim (spec/models/12-scim.md:27) that SCIM is 'additive... on top of the existing Users service without changing any Planned-MVP or Planned-Phase2 contract'.

## Evidence

Source: `packages/core/src/Users.ts:62`

```
  readonly updateProfile: (
    id: UserId,
    input: { readonly name: string },
  ) => Effect.Effect<UserRecord, UserNotFound>;
```

## Recommended fix

Either widen UsersShape with a typed update accepting the SCIM-representable fields (email with lowercasing invariant, active) or declare in the SCIM spec that the plugin owns its own resource table via the existing plugin tables seam and syncs to Users for the fields core owns — but decide now, because the current one-field surface silently forces the core-change path.

## Context

- Auditor verdict on this domain: **needs-work** (score 45/100), domain: SCIM provisioning
- Full dossier: [`scim-provisioning-specialist`](../../.reports/scim-provisioning-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AOMS-002` — UserRecord has no metadata field: Auth0 user_metadata/app_metadata have no storage target](high/AOMS-002-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`AOMS-008` — No bulk user import/export surface anywhere in the monorepo](medium/AOMS-008-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, medium)_`
- [`BE-007` — User profile is a closed shape — no user-field extension point for apps or plugins](medium/BE-007-bereket-engida.md) `_(bereket-engida, medium)_`
- [`BAM-009` — User profile surface cannot receive better-auth user fields: no image, no email change](medium/BAM-009-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, medium)_`
- [`EEM-006` — PlatformError sits in core typed channels, taxing every plugin call site with a die mapping](medium/EEM-006-effect-error-management-specialist.md) `_(effect-error-management-specialist, medium)_`
- [`ESS-008` — Three _tag strings duplicated across the Data and Schema error taxonomies](medium/ESS-008-effect-schema-specialist.md) `_(effect-schema-specialist, medium)_`
- [`FAMS-002` — UserRecord requires an email; Firebase anonymous and phone users cannot be represented](high/FAMS-002-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, high)_`
- [`GC-004` — Memory and SQL implementations of Users diverge on race failure modes](medium/GC-004-giulio-canti.md) `_(giulio-canti, medium)_`
- … 3 more findings touch `packages/core/src/Users.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `users-profile-surface`. Duplicate of `BAM-009` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/core/src/Users.ts:96`. Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `BAM-009-better-auth-migration-specialist` — closed by its fix (see that issue's Resolved comment).
