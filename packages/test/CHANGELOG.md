# @awthaq/test

## 0.2.0

### Minor Changes

- d7351b7: `runPluginContractTests` checks a plugin's own hook taps (PV-260, BEH-EA-200).
  
  - `plugin.taps` entries (`AuthPlugin.DeclaredTap`) now carry, beside `point` and `order`, the tap's `kind`, its `owner` (the plugin id), the `handler` itself and `exercise(input)`/`install(owner)` (`HookPoint.TapDeclaration` gained `kind`, `handler` and `exercise`). `exercise` runs the handler against a stub validated against the point's input schema and returns its `Exit`, unfiltered by any point's failure semantics.
  - `runPluginContractTests` always verifies that each declared tap registers at its point under the plugin's id and declared order, and takes an opt-in `hooks: [{ point, input }]` that runs the plugin's actual handlers: an observe tap must not try to abort (`HookAbort`) and must not fail the observed operation, a veto tap may only abort with `HookAbort`, a divert tap must not fail.
  
  Migration: a hand-built `AuthPlugin.Any` may still omit `taps`; code that builds a `DeclaredTap` by hand must supply the new fields (build it from `Point.declareTap(...)` and add `owner`).
- The `userFields` extension point (SAM-004): a plugin declares typed scalar fields on `users`, and the rest is derived.
  
  - `AuthPlugin.Service` takes `userFields: { plan: UserFields.serverOnly(Schema.Literals(["free", "pro"])), nickname: UserFields.field(Schema.String) }`. `Auth.make` generates a `NNNN_<plugin>_add_user_field_<field>` migration per field (`ALTER TABLE users ADD COLUMN "<plugin id>_<field>"`, nullable, dialect-neutral), returns the composed `userFields` (typed by `Auth.UserFieldsOf<P>`) and `userFieldsLayer`, and lists them in `manifest.userFields`.
  - `Users.getFields`/`setFields` (validated, `source: "client" | "server"` gated per BEH-EA-048) and the typed `Users.typedFields(auth.userFields)`; `UserFields.client(auth.userFields)` for the browser; `UsersRepository.readFields`/`writeFields` in `@awthaq/sql`.
  - `PATCH /user` accepts `fields` (client-writable fields only: 403 `UserFieldNotWritable` for a `serverOnly` one, 422 `UnknownUserField`/`InvalidUserField`), and `AccountDto` carries `fields`. `TestAuth.layer` provides the registry.
  
  Migration: `AccountDto` now has a required `fields` (`{}` when none are declared); a hand-built `UsersShape` implements `getFields`/`setFields`; a hand-built `Manifest` has `userFields: []`; provide `auth.userFieldsLayer` to `Users` when a composition declares fields. ADR-EA-035, BEH-EA-040/048.

### Patch Changes

- Updated dependencies
- Updated dependencies [d7351b7]
- Updated dependencies [8dd72b6]
- Updated dependencies [3514b28]
- Updated dependencies [cb155d4]
- Updated dependencies [f831b6c]
- Updated dependencies [e073887]
- Updated dependencies
- Updated dependencies [4688890]
- Updated dependencies
- Updated dependencies [4cd6174]
- Updated dependencies [5d5b3c6]
- Updated dependencies
  - @awthaq/core@0.2.0
  - @awthaq/server@0.2.0
  - @awthaq/ports@0.2.0
  - @awthaq/sql@0.2.0

## 0.1.0

### Patch Changes

- @awthaq/api@0.1.0
  - @awthaq/core@0.1.0
  - @awthaq/ports@0.1.0
  - @awthaq/qadi@0.1.0
  - @awthaq/server@0.1.0
  - @awthaq/sql@0.1.0
