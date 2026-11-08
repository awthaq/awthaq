---
"@awthaq/ports": minor
"@awthaq/sql": minor
"@awthaq/core": minor
"@awthaq/test": minor
---

`users.metadata` and `sessions.ipAddress`/`userAgent` (with `encryptPii`) are declared `SealedColumn`s under the canonical AAD (`users:<id>:metadata`, `sessions:<id>:<field>`). `UserStore.StoredUser.metadata` and `SessionStore.SessionRecord.ipAddress`/`userAgent` are `Option<Sealed<string>>`; `NewUser.metadata` and `NewSession` stay plaintext. `Users` and `Sessions` degrade an unreadable value to absent with an ids-only warning, as before, and an insert hands back what it wrote without decrypting it (BEH-EA-034, BEH-EA-324, ADR-EA-019 rev 1.3). A sweep over the hand-declared core columns, which used to corrupt `users.metadata`, is now correct.

Migration: values sealed under the old `user:<id>:metadata` / `session:<id>:<field>` AADs no longer open (they read as absent); re-enter the data or accept the loss (pre-1.0, ADR-EA-034). A custom `UserStore`/`SessionStore` returns `Sealed.plain(value)` for a plaintext column. `Repositories.UsersRepository`/`SessionsRepository` rows now carry the stored cell; read it through `metadataOf`/`piiOf`. `StoreContract` cases that compare `StoredUser`/`SessionRecord` values open the PII first.
