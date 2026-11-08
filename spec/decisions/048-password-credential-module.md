# ADR-EA-048: The Password Credential Is One Module of `@awthaq/password`, Under One Policy

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-048 |
> | Revision | 1.0 |
> | Effective Date | 2026-11-08 |
> | Status | Accepted — implemented |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-11-08): Initial release (architecture plan 27) |

---

## Context

Eight sites in three packages open-coded "the password credential of user X": find the account, read the hash, verify it under a timing floor against a dummy hash, check the policy, hash, then update or link. They drifted:

- three policies. `@awthaq/password` screened against a breach corpus and honoured `Password.config` and its tenant overrides; the administrator's `AdminConfig.passwordPolicy` defaulted to a length check, and `awthaq seed admin` had its own 12-character minimum. Neither of the last two screened, and neither saw `Password.config`;
- three outage answers, with four `orDie` sites returning 500 where the interface declared `StoreUnavailable` (503);
- two KDF placements and two timing-floor scopes;
- one non-atomic credential change: `changePassword` wrote the hash, revoked the caller's other sessions and rotated its own as separate commits.

The administrator's knob existed because "`Admin` cannot depend on the password plugin", a constraint [ADR-EA-040](040-plugin-exposes-domain-services.md) removed.

## Decision

1. **One module.** `PasswordCredential` (key `awthaq/plugin/password/Credential`) is the only code that reads or writes the password credential (the `accounts` row with `providerId = "password"`, `subject = userId`, no issuer, BEH-EA-044) or runs the `PasswordHasher` on it. Its interface is:
   - `verify`: resolves the claimant, reads its credential and runs exactly one real verify (against a boot-time dummy hash when there is no credential), the whole effect held to the timing floor in force; one `Refused` answer for every refusal;
   - `rehashIfStale`: upgrades the credential a verify proved;
   - `accept`: the policy;
   - `linkFor`: the sign-up unit's credential;
   - `set`: replace or link; `replace`: replace only, never link; `has`.
2. **Placement.** It lives in `@awthaq/password` and is exposed under ADR-EA-040. A trusted dependent lists `Password` in `dependsOn` (`AdminAccounts`) or reads it from the application context (`awthaq seed admin`). It is not a core module:
   - one plugin verifies;
   - the policy is `Password`'s configuration (BEH-EA-120), decided per tenant (EP-007);
   - its breach check is an outbound HTTP integration the domain stratum does not make.

   [ADR-EA-010](010-plugins-require-ports-never-provide.md) is untouched: `PasswordHasher` stays a port the application provides, and an exposed module is not a port.
3. **One policy.** `PasswordConfig`'s minimum length and breach screening (with its `onUnavailable` posture) govern every path that sets a password. `AdminConfig.passwordPolicy` and the CLI's own minimum are removed.
4. **Order is typed.** A write takes only an `Accepted`, which only `accept` mints; a rehash takes only a `Proof`, which only `verify` mints. Both are `Brand.nominal` over an object, with no exported constructor.
5. **Where work runs.** The policy never runs inside a transaction (its breach check is a network call, BEH-EA-117). A write runs inside the caller's unit of work. Sign-up hashes before its unit, so both enumeration-concealing branches do equal work ([ADR-EA-026](026-signup-enumeration-posture.md)). A reset hashes only once its token is consumed, so an unknown token costs no KDF. A lost link race inside the caller's unit is read again (the account store's insert is `ON CONFLICT DO NOTHING`), and three lost races are `StoreUnavailable`.
6. **Exemption.** Operator imports (`UserImport`, `@awthaq/migrate-*`) store a foreign hash and set no password. They are exempt, as [ADR-EA-038](038-sign-in-and-sign-up-are-core-modules.md) §3 exempts them from `SignUp`; they name `Accounts.PASSWORD_PROVIDER_ID`, never a literal.
7. **Pinned.** `packages/password/test/PasswordCredentialSeams.test.ts` holds the discipline the compiler cannot: `PASSWORD_PROVIDER_ID`, `findCredentialHash`/`updateCredentialHash` and `hasher.verify/hash/needsRehash` appear only at counted, named sites.

## Consequences

**Positive.** One place to change or audit how a password is checked or set. Uniform cost and the policy are tested once, at the module's interface. An administrator-set or seeded password is screened, and follows the tenant's `Password.config`. `changePassword` commits as one unit. No credential path turns a store outage into a defect.

**Negative.** `AdminAccounts` requires `Password` (`Auth.make([Admin, Password, AdminAccounts])`; a tuple without it does not compile). Administrator and CLI hosts now call the breach-check provider (configurable, fail-open by default). An administrator's KDF, and `changePassword`'s, run inside their transaction, holding a pooled connection for one derivation; both paths are rare or budgeted. A host whose layer type is emitted names the exposed service (`PasswordCredential.PasswordCredential`) like any other exposed service.

## Alternatives considered

- **A core module resolved by `make`, like `SignIn`.** Rejected: it moves the policy out of `Password`'s configuration, or breach screening into a port, and brings the HIBP call into core.
- **Core mechanism with the policy injected by each caller.** Rejected: it keeps one policy per caller.
- **A `PasswordPolicy` port.** Rejected: ADR-EA-010 makes ports application wiring, while the policy is plugin configuration with per-tenant overrides.
- **Keep `AdminConfig.passwordPolicy` and document it.** Rejected: its default silently skips screening.
- **Split `setUserPassword` into its own plugin so only it depends on `Password`.** Not taken: `setUserEmail` already needs Password's `POST /change-email/confirm` to complete, and no composition uses `AdminAccounts` without `Password`.

## Related

ADR-EA-010 (`PasswordHasher` stays a required port), ADR-EA-011 (`PasswordConfig` stays a `Context.Reference` with a default), ADR-EA-026 (equal work in conceal mode), ADR-EA-028 (no credential path dies on an outage), ADR-EA-037 (`changePassword`'s events are released on commit), ADR-EA-038 §3 (the import exemption), ADR-EA-040 (the exposure mechanism; its second user). BEH-EA-114, BEH-EA-116, BEH-EA-117, BEH-EA-119, BEH-EA-120, BEH-EA-206, BEH-EA-221, BEH-EA-345.
