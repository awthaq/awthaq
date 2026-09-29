---
"@awthaq/admin": minor
"@awthaq/password": minor
"@awthaq/core": minor
---

Administrator account deletion and credential changes (`AdminAccounts`), and a mailed change-email flow in the password plugin.

- `@awthaq/admin`: the opt-in `AdminAccounts` plugin (`Auth.make([Admin, AdminAccounts])`, group `admin.accounts`) adds `DELETE /admin/users/:userId` (the one `AccountErasure` cascade), `POST /admin/users/:userId/email` (mails a `change-email` token to the new address; the owner confirms) and `POST /admin/users/:userId/password` (through the `PasswordHasher` port, revoking every session), each behind its own fail-closed predicate (`canDeleteUsers`, `canManageCredentials`) with audited `auth.admin.*` events. `AdminConfig` gains those predicates, `passwordPolicy` and `links.changeEmail`; `@awthaq/ports` is now a dependency.
- `@awthaq/password`: `POST /change-email` (authenticated) and `POST /change-email/confirm` (public), typed `EmailDeliveryFailed`/`EmailChangeNotSupported`, rate limits per requester, per target inbox and per token, `auth.user.emailChanged`, a notice to the previous address, `PasswordConfig.links.changeEmail`.
- `@awthaq/core`: `EmailChange` (the shared `change-email` purpose) and the events `auth.user.emailChanged`, `auth.admin.userDeleted`, `auth.admin.userEmailChangeRequested`, `auth.admin.userPasswordSet` (a new `AuthEvent` union member).

Migration: none required (all additive). A host that switches on `AdminAccounts` provides `PasswordHasher`, `Mailer` and `AccountErasure`, and the password plugin must be composed for an admin-requested email change to be confirmed. BEH-EA-221/222/224 (amended), BEH-EA-118.
