---
"@awthaq/password": patch
"@awthaq/admin": patch
"@awthaq/cli": patch
---

A store outage while reading or writing a password credential is `StoreUnavailable` (503) in `change-password`, `reauthenticate`, `confirm-reset` and the administrator's `setUserPassword`, and a retryable usage error (exit 2) in `awthaq seed admin`, instead of a 500 defect (ADR-EA-028). A `confirm-reset` that fails this way does not spend its token. A password credential unlinked between the read and the write now answers `WrongPassword` (`change-password`) or `TokenConsumed` (`confirm-reset`), and a `seed admin` that loses a race to link the password treats it as already linked.

Migration: none (compatible). Alerting that keyed on 500s from these endpoints sees 503s instead.
