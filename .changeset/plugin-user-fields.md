---
"@awthaq/core": minor
"@awthaq/api": minor
"@awthaq/server": minor
"@awthaq/sql": minor
"@awthaq/test": minor
---

The `userFields` extension point (SAM-004): a plugin declares typed scalar fields on `users`, and the rest is derived.

- `AuthPlugin.Service` takes `userFields: { plan: UserFields.serverOnly(Schema.Literals(["free", "pro"])), nickname: UserFields.field(Schema.String) }`. `Auth.make` generates a `NNNN_<plugin>_add_user_field_<field>` migration per field (`ALTER TABLE users ADD COLUMN "<plugin id>_<field>"`, nullable, dialect-neutral), returns the composed `userFields` (typed by `Auth.UserFieldsOf<P>`) and `userFieldsLayer`, and lists them in `manifest.userFields`.
- `Users.getFields`/`setFields` (validated, `source: "client" | "server"` gated per BEH-EA-048) and the typed `Users.typedFields(auth.userFields)`; `UserFields.client(auth.userFields)` for the browser; `UsersRepository.readFields`/`writeFields` in `@awthaq/sql`.
- `PATCH /user` accepts `fields` (client-writable fields only: 403 `UserFieldNotWritable` for a `serverOnly` one, 422 `UnknownUserField`/`InvalidUserField`), and `AccountDto` carries `fields`. `TestAuth.layer` provides the registry.

Migration: `AccountDto` now has a required `fields` (`{}` when none are declared); a hand-built `UsersShape` implements `getFields`/`setFields`; a hand-built `Manifest` has `userFields: []`; provide `auth.userFieldsLayer` to `Users` when a composition declares fields. ADR-EA-035, BEH-EA-040/048.
