---
"@awthaq/saml": minor
"@awthaq/sql": minor
---

The SAML records are scoped by their organization, the SP private key is a sealed column, and every store failure is `StoreUnavailable` (plan 05).

- `SamlRecords`: `findById` and `findByDomain` (a protocol message or home-realm discovery names a connection before any tenant is known) and `pruneSessions` (the retention sweep) take a `TenantScoped.CrossTenant` as their first argument, and run under `TenantScoped.lift`; `update` and `remove` take the connection's `organizationId` and no longer touch another organization's row. `saml_connection` is Keyed, and its domain, key and session tables are Derived.
- `SpKeyRecord.privateKey` is `SealedColumn.Sealed<string>`; `NewSpKey.privateKey` is a `Redacted` PEM that the records seal under `saml_sp_key:<id>:privateKey` (the old `saml-sp-key:` AAD still opens and re-seals on read, and so does a key sealed under a retired encryption key). `SamlRecords.layerMemory/layerSql` require `Encryption`; `SamlSpKeys` no longer does and its exported `aad` is removed. A signing key that does not open is the `sealedColumn.readable` defect (was `saml.signingKeyOpens`).
- Every `SamlRecords`, `SamlSpKeys`, `SamlConnectionStore`, `Saml` and `Sso` method fails with `StoreUnavailable` instead of dying; the metadata, SSO start and admin endpoints declare it. `@awthaq/sql`'s `StoreFailure.orStoreUnavailable` now accepts an effect whose `E` also carries domain errors and leaves them alone.

Migration: pass a witness (`TenantScoped.crossTenant("<why>")`) to `findById`, `findByDomain` and `pruneSessions`, and `organizationId` to `update` and `remove`; open an SP key with `SealedColumn.orDie(record.privateKey.open)`; provide `Encryption` to `SamlRecords`; run `SealedColumn.sweep` on `saml_sp_key.privateKey` to finish re-sealing rows that are never read. BEH-EA-314.
