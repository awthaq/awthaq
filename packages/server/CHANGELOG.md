# @awthaq/server

## 0.2.0

### Minor Changes

- 8dd72b6: A native client's first sign-in no longer needs the CSRF warm-up: an unsafe request that carries no `Cookie` header at all skips the double-submit pair.
  
  CSRF defends ambient browser credentials, and a request with no `Cookie` header (and no `Authorization`) carries none, so `CsrfProtection` no longer demands the `__Host-csrf` pair of it, which a cookie-less client could only obtain through a warm-up `GET` and a cookie jar. The site checks still run, in a stricter form that guards login CSRF: `Sec-Fetch-Site` must be `same-origin` or `none`; `same-site` is admitted only with an allow-listed `Origin`; `cross-site`, a foreign `Origin` or `Origin: null` are refused; with neither header the caller is a non-browser and is admitted. A request carrying any cookie (a stale session cookie, an analytics cookie) keeps the full double-submit check. `CsrfConfig.requireTokenWithoutCookies: true` withdraws the exemption; `@awthaq/client` adds `CsrfClientNative`, the client half for a program with no cookie jar (no cookie read, no `CsrfRejected` retry). BEH-EA-077 (cookie-less exemption and threat model), BEH-EA-079.
  
  Migration: none required. A deployment that authenticates by an ambient non-cookie credential (mTLS client certificates, an intranet network position, HTTP Basic) or that must cover a browser sending neither `Sec-Fetch-Site` nor `Origin` sets `requireTokenWithoutCookies: true`.
- The `userFields` extension point (SAM-004): a plugin declares typed scalar fields on `users`, and the rest is derived.
  
  - `AuthPlugin.Service` takes `userFields: { plan: UserFields.serverOnly(Schema.Literals(["free", "pro"])), nickname: UserFields.field(Schema.String) }`. `Auth.make` generates a `NNNN_<plugin>_add_user_field_<field>` migration per field (`ALTER TABLE users ADD COLUMN "<plugin id>_<field>"`, nullable, dialect-neutral), returns the composed `userFields` (typed by `Auth.UserFieldsOf<P>`) and `userFieldsLayer`, and lists them in `manifest.userFields`.
  - `Users.getFields`/`setFields` (validated, `source: "client" | "server"` gated per BEH-EA-048) and the typed `Users.typedFields(auth.userFields)`; `UserFields.client(auth.userFields)` for the browser; `UsersRepository.readFields`/`writeFields` in `@awthaq/sql`.
  - `PATCH /user` accepts `fields` (client-writable fields only: 403 `UserFieldNotWritable` for a `serverOnly` one, 422 `UnknownUserField`/`InvalidUserField`), and `AccountDto` carries `fields`. `TestAuth.layer` provides the registry.
  
  Migration: `AccountDto` now has a required `fields` (`{}` when none are declared); a hand-built `UsersShape` implements `getFields`/`setFields`; a hand-built `Manifest` has `userFields: []`; provide `auth.userFieldsLayer` to `Users` when a composition declares fields. ADR-EA-035, BEH-EA-040/048.

### Patch Changes

- Updated dependencies
- Updated dependencies [d7351b7]
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
  - @awthaq/api@0.2.0
  - @awthaq/ports@0.2.0

## 0.1.0

### Patch Changes

- @awthaq/api@0.1.0
  - @awthaq/core@0.1.0
  - @awthaq/ports@0.1.0
  - @awthaq/sql@0.1.0
