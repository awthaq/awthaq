---
"@awthaq/organization": patch
"@awthaq/saml": patch
---

Fix: on libSQL, a domain another OIDC connection already holds answers `ConnectionDomainTaken`, not 503 (`StoreUnavailable`). A SAML domain insert that fails a constraint other than a unique one is no longer reported as `SamlDomainTaken`; it is a store failure. Both now classify through `StoreFailure.isUniqueViolation` (ADR-EA-028, ADR-EA-041).

Migration: none.
