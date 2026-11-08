---
"@awthaq/ports": minor
"@awthaq/sql": minor
"@awthaq/core": minor
"@awthaq/test": minor
---

Provider tokens are sealed under `accounts:<id>:<field>`, which binds the account: a token copied to another account of the same user and provider no longer opens. `AccountStore.readProviderTokens` returns `Option<Option<SealedProviderTokens>>`, and `Accounts.findProviderTokens` opens the tokens and fails `ProviderTokensUnreadable` (re-consent) for the one that does not; `ProviderTokensUnreadable.reason` may now be `Malformed`. `TokensRead`, `AccountTokenUndecryptable`, `AccountsRepositoryConfig`, `AccountsRepository.findById`/`listByUser`/`findTokensById` are removed (`findSealedTokensById` replaces the last), `AccountsRepository.insert` returns the row as stored, and `writeTokens` is one statement (ADR-EA-019 rev 1.3, BEH-EA-034).

Migration: tokens sealed under `<providerId>:<userId>:<field>` no longer open, so the account needs one OAuth sign-in to re-store them (`OAuthTokenUnavailable` until then). Use `SealedColumnConfig.resealOnRead` instead of `AccountsRepositoryConfig.reencryptOnRead`. A custom `AccountStore` returns sealed tokens (`Sealed.plain` for plaintext) and passes `StoreContract.accounts`.
