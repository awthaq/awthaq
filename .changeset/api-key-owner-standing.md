---
"@awthaq/api-key": patch
"@awthaq/server": patch
---

API keys and `client_credentials` clients stop authenticating when their owner is suspended, banned, deactivated by SCIM, or erased.

- `@awthaq/api-key`: `ApiKey.resolve` and `ApiKey.issueServiceToken` apply the shared sign-in gate (`Users.assertCanSignIn`) to the key's owner after the secret matched, so a missing or suspended owner is refused like an unknown credential. An outage reading the owner is the typed `StoreUnavailable` (503). The plugin now contributes to `ErasureRegistry` (deletes the user's keys and clients) and to `DataExportRegistry` (names, prefixes and scopes, never a secret or hash); `ApiKeyRecords` and `ApiKeyClientRecords` gain `deleteByOwner`. `ApiKeyShape["resolve"]` and `["issueServiceToken"]` gain `StoreUnavailable` in their error channel and `POST /api-key/token` declares it.
- `@awthaq/server`: `CredentialResolverContribution.resolve` may fail with `StoreUnavailable`.

Migration: `ApiKey.layer` now requires `Users` and `Erasure.ErasureRegistry`/`DataExport.DataExportRegistry` (all provided by a standard `Auth.make` composition and `Hooks.HooksLive`). A host with a custom `ApiKeyRecords` or `ApiKeyClientRecords` implements `deleteByOwner`. Keys of users erased before this release are now refused; purge the orphans with `DELETE FROM apikey_key WHERE "ownerId" NOT IN (SELECT id FROM users)` (and the same for `apikey_client`). BEH-EA-046.
