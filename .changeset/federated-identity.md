---
"@awthaq/core": minor
"@awthaq/test": minor
---

`FederatedIdentity.make` resolves an external party's assertion to a local user (`resolve`: linked, auto-linked or created through `SignUp`; `attach`: an explicit link), deciding the email-linking policy once and resolving a lost race to the account the winner wrote (ADR-EA-043, BEH-EA-338). New event `auth.account.linked` (`userId`, `providerId`, `via`). `@awthaq/test` gains `Rendezvous` for tests that force an interleaving.
