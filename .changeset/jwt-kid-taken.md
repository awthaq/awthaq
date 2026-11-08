---
"@awthaq/jwt": minor
---

A signing key's `kid` names one key forever (plan 25 ticket 20, plan 24 R6 and Q3, BEH-EA-296):

- `KeyRing.registerRemoteKey` and `KeyRing.importKey` with the same public key again under its `kid` (same `alg` and public JWK) are a no-op that answers the stored key: a host registering its remote key at every boot keeps working, and re-registering the current remote key rotates nothing.
- A different key under a stored `kid` fails `SigningKeyRecords.KidTaken` (`"SigningKeyRecords/KidTaken"`), typed, and writes nothing. Before, the in-memory records overwrote the stored key (the current key and its private half included) and the SQL records reported `CurrentKeyConflict`, which `KeyRing` turned into a defect.
- `KeyRing.registerRemoteKey` that loses a race to a concurrent registration or mint of another current key fails `CurrentKeyConflict` instead of dying.
- `SigningKeyRecords` and `RevocationStore` run the `RecordsContract` suites (memory, SQLite, Postgres): the single-current, `markRotated`, `retire` and `purgeExpired` races are proven on every adapter.

Migration: a custom adapter through `@awthaq/jwt`'s `SigningKeyRecords` must implement `findByKid(kid)` (the key under `kid` whatever its state, or `None`), and its `create` must never overwrite a stored `kid`: the same public-only key again answers the stored record unchanged, any other key fails `KidTaken` (memory: in the same `Ref.modify` as the insert; SQL: `INSERT … ON CONFLICT (kid) DO NOTHING RETURNING *`, then a read of the stored row). Migration: `SigningKeyRecordsShape.create`'s error channel adds `KidTaken`; `KeyRing.registerRemoteKey`'s adds `KidTaken` and `CurrentKeyConflict`, `KeyRing.importKey`'s adds `KidTaken`. MOD-EA-008, ADR-EA-017.
