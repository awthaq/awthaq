---
"@awthaq/sql": minor
---

Breaking (pre-1.0): the repository writers no store adapter or domain service calls are removed from `@awthaq/sql` (plan 02 phase 7.6, finished).

- `UsersRepository` loses `update`, `verifyEmail`, `verifyPhone`, `promoteIdentity`, `changeEmail` and `writeFields`; `AccountsRepository` loses `update`, `updatePasswordHash`, `updateProviderTokens`, `findAad` and `findByProviderSubject`; `SessionsRepository` and `VerificationRepository` lose `update`.
- Kept: `updateProfile`, `setStatus`, `casIdentity`, `writeFieldsReturning`, `findIdentityById`, `findIdentityByKey`, `findTokensById`, `writeTokens`, `writePasswordHash`, `tryConsume`.

Migration: use the store ports instead of the repositories. `verifyEmail`, `verifyPhone`, `promoteIdentity` and `changeEmail` are `UserStore.casIdentity` (read, apply the rule, compare-and-swap, retry on `Stale`; `Users` does this for you); `writeFields` is `UserStore.writeFields`; `updatePasswordHash` is `writePasswordHash`; `updateProviderTokens` is `writeTokens` (it reads the AAD token-free, so `findAad` is not needed); `findByProviderSubject` is `findIdentityByKey` (identity only, no tokens decrypted) or `AccountStore.getByKey`; a verification token is consumed with `tryConsume`.
