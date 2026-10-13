---
"@awthaq/saml": minor
---

`Saml.records` is the plugin's record store as one matched `{ memory, sql }` bundle, and `Saml.layer` now provides the connection store and the SP key store itself.

- `SamlRecords` is keyed `awthaq/saml/records/SamlRecords`; the bundle provides it over memory and over SQL (the `MemoryEnvelopes` test seam is not part of it).
- `Saml.layer` absorbs `SamlConnections.layerStore` and `SamlSpKeys.layer` (always required, storage-agnostic, built over `SamlRecords`); they stay in its output, so `Sso` still reads `SamlConnectionStore`. `SamlMetadataFetcher` stays the host's (a network adapter: `layerPinned` in production). `Sso` declares no records, and its `OrganizationConnectionStore` stays host-composed (`OrganizationConnections.layerStore`): OAuth connections are optional in `Organization`.

Migration: remove your own `SamlConnections.layerStore` and `SamlSpKeys.layer` from the host graph (keeping them is harmless but redundant). Code that built a `Context` by the old record key string must use the class. A host replaces `SamlRecords.layerMemory` / `SamlRecords.layerSql` with `Saml.records.memory` / `Saml.records.sql`.
