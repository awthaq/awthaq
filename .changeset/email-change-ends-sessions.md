---
"@awthaq/core": minor
"@awthaq/password": minor
---

Confirming an email change ends every session of the account (BEH-EA-053, REQ-EA-686).

`POST /change-email/confirm` (`Password.confirmEmailChange`) is a public, token-authenticated request, so it has no caller session to rotate. It now calls `Sessions.revokeAll(userId, "emailChanged")` in the same transaction that replaces and verifies the address; `auth.session.revoked` carries the new `SessionRevocationReason` `"emailChanged"`.

Migration: a client that stayed signed in across an email change is signed out when the change is confirmed and signs in again under the new address; an exhaustive `switch` over `SessionRevocationReason` gains an `"emailChanged"` case.
