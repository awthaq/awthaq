# ADR-EA-035: A Plugin Adds Typed Scalar Fields to `users` Through One Declared Extension Point

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-035 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-29 |
> | Status | Accepted — implemented for `users` (core `UserFields`, `AuthPlugin`'s `userFields`, `Auth.make`'s generated migrations, `Users.getFields`/`setFields`/`typedFields`, the profile endpoint, the client helper); `Account` and `Session` extension not built |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-29): Initial release (SAM-004, BE-007; decision A of the plan) |

---

## Context

Apps migrating from Supabase (`raw_user_meta_data`, `raw_app_meta_data`) or better-auth (`additionalFields`) keep a plan tier, a staff flag or a nickname next to the user. `User` is a closed shape, and the two rules that speak to extending it were spec only: [BEH-EA-040](../behaviors/05-persistence-stratum.md) (a shared table is altered only through a declared extension point, scalar columns only) and [BEH-EA-048](../behaviors/06-domain-users-accounts.md) (a contributed field is client-writable unless its plugin says otherwise). The interim answer, an opaque server-only `metadata` string or a plugin-prefixed side table, gives neither types nor the write gate.

## Decision

**A plugin declares fields; everything else is derived.** `AuthPlugin.Service("billing", { userFields: { plan: UserFields.serverOnly(Schema.Literals(["free", "pro"])), nickname: UserFields.field(Schema.String) } })` is the whole declaration.

1. **A field is a schema whose encoded side is one scalar** (a string, a number, a boolean, or a union of literals of one kind), so the column is a nullable `TEXT`, `DOUBLE PRECISION`/`REAL` or `BOOLEAN`/`INTEGER`. The decoded side is free (a literal union, a branded string, `NumberFromString`). Anything else, a name that is not a plain identifier, or a column name over 63 characters (Postgres truncates silently) throws `UserFields/InvalidDeclaration` where the plugin is defined.
2. **The linker owns the DDL.** `Auth.make` appends one generated migration per field to `migrations`, after every plugin's own, named `NNNN_<plugin>_add_user_field_<field>`: `ALTER TABLE users ADD COLUMN "<plugin id>_<field>"`, nullable and unbackfilled, dialect-neutral through `sql.onDialectOrElse` (a dot in a plugin id becomes `_`, since quoting would read it as `table.column`). A plugin therefore cannot write DDL against `users` at all, which is BEH-EA-040 enforced by construction rather than by review. Two declarations that would share a column are refused at composition (`UserFieldConflict`). Adding a field to a database that already ran the plugin ledger follows the plugin ledger's existing rule: append (the migration id must sort after every applied one, which `awthaq migration status` checks), because a numeric-id ledger skips a migration numbered below the newest applied.
3. **Types are folded, not declared twice.** `Auth.UserFieldsOf<P>` is the composed record keyed `<plugin id>_<field>` with each field's own schema, the type of `Built.userFields`. `Users.typedFields(auth.userFields)` reads and writes exactly those fields with their decoded types; `UserFields.client(auth.userFields)` encodes a patch of only the client-writable fields (the `serverOnly` marker is part of the schema's type, so a server-only key does not compile) and decodes an `AccountDto.fields`.
4. **The gate is in `Users`, not in each caller.** `Users.setFields(id, patch, { source })` validates a patch as a whole before storing anything (every key declared, every non-null value accepted by its schema, `null` clears): `UnknownUserField` (422), `InvalidUserField` (422), and for `source: "client"` (the profile endpoint) `UserFieldNotWritable` (403) for a `serverOnly` field. The default `source: "server"` is trusted code (a billing webhook) and may write any declared field. `getFields` is not gated: a user may read what they may not write. A write announces the changed keys on `Hooks.AfterUserAttributesChanged` (AAPS-005), so a policy that reads a field is refreshed.
5. **The registry is provided by the composition.** `UserFields.UserFieldRegistry` (a `Context.Reference`, empty by default) is what `Users` and the account handler read; `auth.userFieldsLayer` provides it (`TestAuth.layer` does so itself). A composition that declares no field pays nothing: no query, `fields: {}`.
6. **On the wire**: `AccountDto.fields` (`{}` when none) and an optional `fields` bag in `PATCH /user`'s payload.

**The default stays BEH-EA-048's**: a field is client-writable unless declared `serverOnly`. The base system cannot know that a plugin's field carries authority, so anything a policy or an authorization decision may rely on must be declared `serverOnly`; a plugin that forgets is the party responsible for the resulting corruption (BEH-EA-048's own blame rule).

## Alternatives considered

**B: one typed JSON `attributes` column keyed by plugin id.** No DDL and one column, but a field is not a column (no index, no `WHERE billing_plan = 'pro'` in an admin query, no DB-level type), and per-plugin schema evolution moves into the data.

**C: documentation only** (a plugin's own prefixed side table keyed by `UserId`). Still valid for anything that is not one scalar per user, and it remains the recommendation for that; it gives no types on `Users`, no write gate, and every plugin re-implements erasure and export for its side table.

**Plugin-written `ALTER TABLE`.** Rejected: it is exactly what BEH-EA-040 forbids, and it cannot be checked.

## Consequences

**Positive**: a plugin adds a typed, gated, migrated user field with one declaration and no core change; the field set is typed end to end (plugin, server, client); the gate cannot be bypassed by a handler that forgets it; erasure and export are unchanged (the fields live on the `users` row, which `AccountErasure` deletes).

**Negative**: the declared fields are read with a second query (`getFields`), not on `UserRecord`; an added field is a migration that must sort last on a migrated database; `updatedAt` is not bumped by `setFields`; scalar-only, so structured data still belongs in a plugin's own table or in `metadata`. `Account` and `Session` extension (BEH-EA-048 names them too) has no implementation.

_Related: [BEH-EA-040](../behaviors/05-persistence-stratum.md), [BEH-EA-048](../behaviors/06-domain-users-accounts.md), [ADR-EA-028](028-infrastructure-error-policy.md)._
