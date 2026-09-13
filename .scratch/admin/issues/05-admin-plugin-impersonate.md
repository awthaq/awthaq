# 05 — `Admin` plugin skeleton, config, and `impersonate`

**What to build:** The `Admin` class itself (`AuthPlugin.Service`,
`dependsOn: []` — reaching `Sessions`/`Users`/`AuthEvents` with a plain
`yield*`, never a plugin dependency, matching `@effect-auth/passkey`'s own
corrected ticket 06), `AdminConfig` (fail-closed `canImpersonate` predicate
over `AuthSubject`, `maxDuration`), and a working `impersonate` endpoint: an
authorized caller supplies a target `userId` and a `reason`, and receives a
new, dual-identity session for that user with a hard expiry — the same
worked example `archive/PRD.md` §17/§18 and `spec/models/
15-admin-impersonation.md` both describe.

**Blocked by:** Tickets 02, 03, 04.

**Status:** done

- [x] `AdminConfig` is a `Context.Reference` with a fail-closed default
      (`canImpersonate: () => Effect.succeed(false)`); a `config(partial)`
      override function follows the same pattern `Password`'s
      `PasswordConfig`/`config()` already establishes (BEH-EA-212)
- [x] `Admin extends AuthPlugin.Service<...>()("admin", { dependsOn: [],
      ... })` — `Auth.make([Admin])` composes (`AuthComposition.test.ts`,
      mirroring every other plugin's own)
- [x] `impersonate` rejects a `reason` that is empty after trimming or
      longer than 1000 characters, with a typed/schema-level error
- [x] `impersonate` rejects the call (before issuing any session, before
      touching `ImpersonationRecords`) when `canImpersonate` resolves
      `false` for the caller's own subject — `AdminImpersonationDenied`
      (403) — and publishes `auth.admin.impersonationDenied`
- [x] `impersonate` rejects self-impersonation —
      `AdminSelfImpersonationRefused` (400) — and a call made from a
      session whose own principal already carries `actingAs` —
      `AdminAlreadyImpersonating` (409) — neither publishing
      `impersonationDenied` (BEH-EA-214/218)
- [x] On success: issues a new session via ticket 02's `Sessions.issue`
      with `actingAs` set to the caller's own identity and hard expiry from
      `AdminConfig.maxDuration`; inserts one `admin_impersonation` row via
      ticket 04's `ImpersonationRecords`; leaves the caller's own existing
      session completely untouched; publishes
      `auth.admin.impersonationStarted` (BEH-EA-213/215/218)
- [x] The `admin` `HttpApiGroup`'s `impersonate` endpoint, contract errors,
      and payload/params schemas exist in this plugin's own `AdminApi.ts`
- [x] `packages/admin/test/Admin.test.ts`: domain-level tests for every
      case above, using a plain in-test `canImpersonate` function (no
      `Layer.mock` needed — it is a bare config predicate, not a service)

## Result

Done. `Admin` (`packages/admin/src/Admin.ts`) extends
`AuthPlugin.Service<...>()("admin", { dependsOn: [], tables:
["admin_impersonation"], ... })`; `dependsOn` left unset (empty), the same
corrected convention `@effect-auth/passkey`'s own ticket 06 established —
`Sessions`/`AuthEvents`/`ImpersonationRecords` are reached with a plain
`yield*` inside `make`. `AdminConfig` is a fail-closed `Context.Reference`
(`canImpersonate` defaults to always-deny); `config(partial)` mirrors
`PasswordConfig`/`config()` exactly. `ReasonSchema`
(`Schema.String.pipe(Schema.check(Schema.makeFilter(...)))`) enforces
non-empty-after-trim/≤1000 chars at the contract boundary. `impersonate`
checks self-impersonation, then nested-impersonation, then the gate (in
that order — validation refusals never publish `impersonationDenied`),
then issues the dual-identity session and audit row and publishes
`impersonationStarted`. `AdminApi.ts` declares the `admin` group's
`impersonate` endpoint (`POST /admin/impersonate/:userId`) with its full
error union. `Admin.test.ts` covers every case domain-level; the caller's
own subject passed to `canImpersonate` is a bare, identity-only
`@qadi/core` `AuthSubject` this plugin builds itself (`subjectOf`) — see
`Admin.ts`'s own header comment for why it cannot reach
`@effect-auth/qadi`'s real `SubjectResolver` default instead without
breaking the stratum ordering.
