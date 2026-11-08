---
"@awthaq/core": minor
"@awthaq/admin": minor
---

`auth.admin.actionDenied` carries `targetUserId` or `organizationId` when the refused call named one, like `auth.admin.impersonationDenied` (IDS-006, BEH-EA-224).

Migration: none for publishers (both fields are optional). A consumer that validates the event with a closed schema accepts the two optional keys.
