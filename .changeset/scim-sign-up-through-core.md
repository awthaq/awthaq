---
"@awthaq/scim": minor
---

SCIM provisioning is a sign-up (ADR-EA-038): `POST /Users` consults `BeforeSignUp` with strategy `scim:<organizationId>:<connectionId>` (a veto answers 403), the user, mapping and membership commit as one unit, and `auth.user.created` and `AfterSignUp` run after it commits, alongside `auth.scim.userProvisioned`. A failed provisioning is abandoned through `SignUp.createWith`, with no delete a legal-hold tap could veto.

Migration: the `Scim` layer now requires the `SqlTransaction` port. A host `BeforeSignUp` tap now sees directory provisioning; a tap that must not apply to a directory exempts strategies starting with `scim:`.
