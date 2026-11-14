---
"@awthaq/ports": minor
"@awthaq/sql": minor
"@awthaq/admin": patch
"@awthaq/api-key": patch
"@awthaq/device-authorization": patch
"@awthaq/jwt": patch
"@awthaq/organization": patch
"@awthaq/saml": patch
"@awthaq/scim": patch
"@awthaq/webhooks": patch
---

`Keyset.chronological({ createdAt, id, direction })` in `@awthaq/ports` is the `(createdAt, id)` order of a record listing (ids by code unit, `desc` its flip), and `StoreFailure.labelled("<Records>")` in `@awthaq/sql` binds `orStoreUnavailable` to one store so each method pipes through `unavailable("<method>")`; the plugin records modules now use both; every listing order for the canonical (lowercase uuidv7) ids the stores mint, operation label, lock key and `*Shape` is unchanged. The memory twins of the organization connection, team, SAML, SCIM and webhook endpoint listings used to compare ids by locale and now compare them by code unit, as `Keyset` and SQLite's `ORDER BY id` do, so a caller-supplied non-canonical id (mixed case or punctuation) on equal `createdAt` can list in a different order.

Migration: none required. Plugin authors may adopt `Keyset.chronological` and `StoreFailure.labelled` in their own records modules; existing comparators and labels keep working unchanged.
