---
"@awthaq/saml": minor
---

SAML's by-id administrative operations (get, update, delete, refresh metadata, rotate and list signing keys) read the connection first and ask `canManageSaml` with its `organizationId` (BEH-EA-347). This closes a cross-organization read and write: a predicate that delegated one organization (`organizationId === undefined || organizationId === A`) used to admit every by-id call on an untenanted admin surface. A refused connection now answers like an absent one (404) for an administrator who holds the action in general, and 403 otherwise; each refusal publishes `auth.admin.actionDenied` naming the organization.

Migration: `canManageSaml` now receives the connection's `organizationId` for the six by-id operations. A predicate that approved by-id calls through `organizationId === undefined` should be reviewed: `undefined` now means "the action in general".
