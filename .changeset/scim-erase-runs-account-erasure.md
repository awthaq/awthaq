---
"@awthaq/core": minor
"@awthaq/scim": minor
"@awthaq/admin": minor
"@awthaq/server": minor
---

SCIM `DELETE /Users/:id` with `deleteBehavior: "erase"` now runs the account erasure (ADR-EA-031, BEH-EA-250): every plugin's rows (organization memberships and invitations, passkeys, roles, ...), linked accounts, sessions, verification tokens, the user and the audit pseudonymization, in one transaction, announced by `auth.user.deleted` with `deletedBy: "directory"`. It previously deleted only the user row and its sessions, leaving memberships (a taken seat), linked accounts (a SAML sign-in for the same NameID then failed) and the audit trail behind. `@awthaq/scim` also takes part in every erasure (`scimErasure`: the user's `scim_resource` rows) and in the data-subject export (`scimExport`), and adds a `scim_resource(kind, "resourceId")` index migration.

Migration: `AccountErasure.eraseAccount(userId, options?)` is now `eraseAccount(userId, initiator)` with a required `Erasure.ErasureInitiator`: `{ deletedBy: "self" }` becomes `ErasureInitiator.Self()`, `{ deletedBy: "admin" }` becomes `ErasureInitiator.Admin({ adminUserId })`, and a call with no options (which meant "self") becomes `ErasureInitiator.Self()`. `auth.user.deleted.deletedBy` gains `"directory"` and optional `adminUserId`/`connectionId`/`organizationId`: an exhaustive switch on `deletedBy` needs a `"directory"` case. A composition of `Scim.layer` must now provide `Erasure.AccountErasure` (`Erasure.layer`; `AuthHttp` compositions already do). A SCIM `DELETE` racing another erasure of the same user now answers 404 instead of 204. Run the new SCIM migration.
