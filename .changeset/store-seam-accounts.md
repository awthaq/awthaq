---
"@awthaq/core": minor
"@awthaq/ports": minor
"@awthaq/sql": minor
"@awthaq/test": minor
---

`Accounts` is written once, over a new `AccountStore` port (ADR-EA-041, plan 02 phase 4).

- `@awthaq/ports` gains `AccountStore` (`insertIfAbsent`, the token-free identity reads `get`/`getByKey`/`listByUser`, `readCredentialHash`, `readProviderTokens`, `writeCredentialHash`, `writeProviderTokens`, `deleteUnlessLast`, `deleteByUser`, each atomic by contract) with a `Ref` adapter, `layerMemory`. `@awthaq/sql` gains `AccountStoreSql.layer` over `AccountsRepository`. `@awthaq/core`'s `Accounts` gains `layer` (requires `AccountStore` and `Crypto`); `ProviderTokenSet` is now the port's `ProviderTokens`; `Accounts.layerMemory` and `layerSql` stay as aliases until the persistence bundles land.
- `@awthaq/test` gains `StoreContract.accounts`, run on the `Ref`, SQLite, SQLite WAL file and (`pnpm test:pg`) Postgres adapters, with the concurrent-unlink case that proves BEH-EA-045.
- Behaviour, in every backend: an `issuer` of `""` and an absent issuer are the same (`Option.none()` in the record; memory returned `Some("")`); `listByUser` is ordered by `(createdAt, id)`; `updateCredentialHash` and `updateProviderTokens` bump `updatedAt` (memory did not); an identity read (`findById`, `findByProviderSubject`, `listByUser`, `findCredentialHash`) decrypts no token and never writes a re-encrypted one back (the SQL read decrypted all three token columns and could write on the sign-in path); a duplicate `link` no longer aborts an enclosing Postgres transaction; the memory adapter stamps the ambient tenant.
- `Accounts.layerSql` now needs `Crypto` (the service mints the account id, like `Sessions` and `Verification`; the SQL model used to).
- `@awthaq/sql` repository: new `findIdentityById`, `findIdentityByKey`, `listIdentitiesByUser`, `insertIdentityIfAbsent`, `findPasswordHash`, `writePasswordHash`, `writeTokens`; `deleteAllByUser` resolves to the number deleted.

Migration: provide `Crypto` (for example `NodeCrypto.layer`) to a composition that uses `Accounts.layerSql`; it already has it if it also uses `Sessions` or `Verification`. A caller that compared `AccountRecord.issuer` with `Option.some("")` reads `Option.none()` now. BEH-EA-043, BEH-EA-045, BEH-EA-125.
