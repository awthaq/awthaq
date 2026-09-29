# Password Authentication
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-15 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Corrected BEH-EA-113's research citation to the precise Q48 finding it refers to (CCR-EA-002) |
---

> This file describes planned behavior. No code implementing it exists yet; awthaq is pre-implementation.

## BEH-EA-113: Sign-up issues a pending user and a verification mail

```ts
signUp: (input: { email: string; password: Redacted<string> }) => Effect<SessionView, WeakPassword>
```

```text
REQUIREMENT: `password.signUp` MUST create the user and session in one
             transaction and MUST dispatch a verification mail without
             blocking the response on delivery.
```

MNA-001/WPS-004: `signUp`, `signIn` and `changePassword` deliver the session through `@awthaq/server`'s shared `SessionDelivery` — the session cookie by default, or, when the request carries `X-Awthaq-Token-Delivery: bearer`, the raw token in the response's optional `token` field with no cookie (an unrecognised value answers `400 InvalidTokenDelivery` before anything is minted; BEH-EA-066).

CSD-003: every session the password plugin mints (`signUp`, `signIn`, and the rotated one `changePassword` returns) records the request's resolved client address (through the `ClientAddress` port) and its `User-Agent`, bounded to 512 characters, so the session device list (BEH-EA-054) has data; `@awthaq/oauth`'s callback and `@awthaq/passkey`'s `authenticateVerify` do the same.

ERS-002/EEM-002: the dispatch is owned, not fire-and-forget: `@awthaq/core`'s `MailDispatch` runs each mail in a `FiberSet` in the plugin's scope, retries a `retryable` `MailDeliveryFailed` (`Mailer.send`'s typed failure) with jittered exponential backoff, bounds concurrent sends, publishes `auth.mail.failed` (template and user id, never the recipient or token) when a mail is lost, and on shutdown waits up to `drainTimeout` for in-flight mail before interrupting the rest. The three background mails (sign-up verification, reset, resend) share it; an authenticated flow such as an organization invitation surfaces `MailDeliveryFailed` to its caller instead.

`usage-examples-v4.md` §6.2 fixes the shape: `signUp` sends a verification mail as a side effect, and the caller receives a `SessionView` immediately rather than waiting on mail delivery. Not awaiting the send keeps the sign-up response time independent of the mail provider's latency and, per `research/05-oauth-oidc.md` Q48's `Mailer`-capability recommendation ("Fire-and-forget: core wraps sends with `Effect.forkDaemon`/`waitUntil`-style detached execution so request latency and error surface don't leak account existence (enumeration resistance...)"), avoids a timing side-channel that a slow-vs-fast response could otherwise leak about whether the address already had an account. Q48 lives in the OAuth research file because it was written to answer a delivery question that first came up in the OAuth/verification-linking context, but the finding itself is general to any mail send awthaq issues from a request path — password sign-up's verification mail included — which is why this citation names the specific question rather than the file's title.

_Previous: [BEH-EA-112](14-rate-limiting.md#beh-ea-112-testing-with-a-permissive-limiter) | Next: [BEH-EA-114](15-password.md#beh-ea-114-uniform-invalidcredentials-on-sign-in)_

## BEH-EA-114: Uniform InvalidCredentials on sign-in

```ts
export class InvalidCredentials extends Schema.TaggedError<InvalidCredentials>()("InvalidCredentials", {}) {}
```

```text
REQUIREMENT: `password.signIn` MUST fail with the same `InvalidCredentials`
             error and the same response latency whether the email is unknown,
             the password is wrong, or the account has no password credential
             at all; it MUST NOT distinguish these cases in the response.
```

PRD §10 states this directly: "`InvalidCredentials` is uniform to prevent enumeration." An attacker probing `signIn` cannot use a different error, status, or timing to learn which emails have accounts — the constant-time hash comparison and the single error shape together remove the oracle. `usage-examples-v4.md` §1.2 shows the wire shape: `401 {"_tag":"InvalidCredentials"}`, regardless of which of the three underlying reasons applied.

**Timing floor (TSS-006).** A verify runs at the *stored* hash's cost, so a row still on a cheaper legacy hash (bcrypt awaiting rehash) would answer faster than the dummy-hash path an unknown email takes. `PasswordConfig.signInTimingFloor` closes that: by default (`"calibrated"`) the layer times a verify of its boot-time dummy hash and holds `signIn`'s credential check (lookup plus verify, success and failure alike) to at least 1.25 times that; a `Duration` fixes the floor and `"off"` disables it. `changePassword` and `reauthenticate` hold their verify to the same floor. The residual: a hash *costlier* than the floor (a high-cost legacy bcrypt) still takes longer than the floor and stays distinguishable until it has been rehashed.

**Verified-email gate (FAMS-003).** After the credentials are confirmed, `signIn` refuses an unverified account (`403 EmailNotVerified`), so the gate can never be used to probe a password. `PasswordConfig.requireVerifiedEmail` (default `true`) turns it off for a deployment whose imported users were never verified in the source system; such a deployment either calls `Users.verifyEmail` for the users the source had verified, or keeps the gate off and restricts unverified users downstream.

_Previous: [BEH-EA-113](15-password.md#beh-ea-113-sign-up-issues-a-pending-user-and-a-verification-mail) | Next: [BEH-EA-115](15-password.md#beh-ea-115-passwordhasher-is-a-port-the-plugin-never-provides)_

## BEH-EA-115: PasswordHasher is a port the plugin never provides

> **See:** [ADR-EA-010](../decisions/010-plugins-require-ports-never-provide.md)

```ts
Layer.provide(PasswordHasher.layerArgon2id)   // default
Layer.provide(PasswordHasher.layerScrypt)     // WebCrypto-only runtimes
```

```text
REQUIREMENT: The `Password` plugin MUST require `PasswordHasher` as a port and
             MUST NOT bundle or default to a hashing implementation of its own;
             the application supplies exactly one `PasswordHasher` Layer.
```

This is ADR-EA-010 applied to the plugin most likely to tempt an exception: hashing feels like it belongs to the password plugin, but treating it as a port is what lets a WebCrypto-only runtime swap in `layerScrypt` without forking the plugin, and what lets a test swap in a fast insecure hasher without touching plugin code. `argon2id` is the recommended default (PRD §11, §18) but the plugin's dependency on `PasswordHasher` is what the type checker actually enforces — omit the port Layer and `Auth.layer` does not compile.

_Previous: [BEH-EA-114](15-password.md#beh-ea-114-uniform-invalidcredentials-on-sign-in) | Next: [BEH-EA-116](15-password.md#beh-ea-116-rehash-on-login)_

## BEH-EA-116: Rehash on login

```text
REQUIREMENT: On a successful sign-in, if the stored hash's parameters are
             below the currently configured `PasswordHasher` floor (or the
             hash is in a foreign, unparseable or over-ceiling format), the
             password MUST be rehashed with current parameters in the same
             request and the stored hash MUST be replaced. A stored hash
             stronger than the configured target MUST NOT be rewritten
             unless the deployment opts into `exact` semantics.
```

TTE-005: a stored hash is the branded `PasswordHasher.PhcHash` end to end: `hash` returns one, `verify`/`needsRehash` require one, `Accounts` stores and returns `Redacted<PhcHash>`, and the only places that mint one are trust boundaries (the hasher, a repository reading a stored column, a migration import). A bare string cannot be verified or stored as a credential by accident.

ERS-001: KDF work is bounded, and can be moved off the event loop. The calling-thread layers admit at most `AUTH_PASSWORD_HASH_CONCURRENCY` (default 4) concurrent hash/verify derivations, legacy verifiers included; `PasswordHasherWorkerPool` provides the same hashers with the derivation in a pool of `AUTH_PASSWORD_HASH_WORKER_POOL_SIZE` worker threads (an opt-in Layer swap needing the application's worker platform). Hashes are identical either way; parsing, ceilings, the rehash policy and the constant-time comparison always run on the calling thread. Password hashing belongs on a long-running runtime, not an edge/Workers tier (ERAS-004).

PHS-002: the default `AUTH_PASSWORD_REHASH_POLICY=floor` rewrites only a hash weaker than the target (argon2: `m` or `t` below it; scrypt: `N` or `r` below it; `p` alone never triggers), so lowering the configured cost can never silently downgrade existing hashes. `AUTH_PASSWORD_REHASH_POLICY=exact` restores the earlier "any difference" behavior for an operator who deliberately lowers cost. Both layers also refuse, without running the KDF, any stored hash claiming a cost above a configurable ceiling (ACS-006), and `layerArgon2id` compares digests itself in constant time rather than through hash-wasm's `argon2Verify` (PHS-001).


Argon2id parameters (memory cost, iterations, parallelism) are expected to be raised over the life of an application as hardware improves; without rehash-on-login, every account hashed under the old parameters stays weaker than a newly created one indefinitely, since a stored hash is never touched again after creation. Rehashing opportunistically at the one moment the plaintext password is available — sign-in — closes that gap without a bulk migration, mirroring the "hashed at rest" security posture PRD §18 requires generally.

_Previous: [BEH-EA-115](15-password.md#beh-ea-115-passwordhasher-is-a-port-the-plugin-never-provides) | Next: [BEH-EA-117](15-password.md#beh-ea-117-reset-revokes-other-sessions-in-the-same-transaction)_

## BEH-EA-117: Reset revokes other sessions in the same transaction

```ts
yield* client.password.requestReset({ payload: { email } })     // always 202, even for unknown emails
yield* client.password.confirmReset({ payload: { token, password: newPassword } })
```

```text
REQUIREMENT: `password.requestReset` MUST respond identically for a known and
             an unknown email; `password.confirmReset` MUST consume the reset
             token and revoke every other session for the account in the same
             transaction that sets the new password. `confirmReset` MUST
             evaluate the password policy before consuming the token (a weak
             password never burns it, and no breach-check network call runs
             inside the transaction), MUST refuse a token of another purpose
             or for an account with no password credential as `TokenConsumed`
             (never a defect), and MUST mark the account's email verified —
             the mailed token proves the same mailbox control `verifyEmail`
             does. `requestReset` for an existing account with no password
             credential MUST mail `reset-password-unavailable` (no token)
             instead of a reset link.
```

`usage-examples-v4.md` §6.1 states both halves: the request endpoint answers `202` unconditionally, so an attacker cannot use it to test which emails are registered, and confirmation both consumes the token and revokes other sessions "in the same transaction that sets the new password" — so a session an attacker obtained before the legitimate reset does not survive it. This is the reset-token half of the purpose-scoped, single-use Verification design that file 08 specifies for tokens generally.

_Previous: [BEH-EA-116](15-password.md#beh-ea-116-rehash-on-login) | Next: [BEH-EA-118](15-password.md#beh-ea-118-verification-and-replay)_

## BEH-EA-118: Verification and replay

```ts
yield* client.verification.confirm({ params: { token } })
// replaying the same token: 410 TokenConsumed, and event "auth.token.replay" is published
```

```text
REQUIREMENT: Confirming an already-consumed verification token MUST fail with
             `TokenConsumed` (410) and MUST publish `auth.token.replay`; it
             MUST NOT silently succeed or silently no-op.
```

A replayed token is evidence worth keeping even though the action it would have performed must not repeat: it may indicate a token that leaked (forwarded email, shared clipboard, a proxy that retried a request). Publishing `auth.token.replay` on the shared `AuthEvents` bus (file 13) lets an application wire an alert without the password plugin itself knowing anything about alerting — the plugin's job stops at "this is a replay," recorded as a typed, observable fact.

_Previous: [BEH-EA-117](15-password.md#beh-ea-117-reset-revokes-other-sessions-in-the-same-transaction) | Next: [BEH-EA-119](15-password.md#beh-ea-119-breach-check-is-fail-open-by-default-fail-closed-by-config)_

## BEH-EA-119: Breach-check is fail-open by default, fail-closed by config

```ts
password({ breachCheck: true })                                       // the default: HIBP unreachable → fail-open
password({ breachCheck: { onUnavailable: "reject" } })                 // fail-closed
password({ breachCheck: false })                                      // opt out (air-gapped deployments)
```

```text
REQUIREMENT: When `breachCheck` is enabled and the breach-database provider is
             unreachable, sign-up MUST proceed (fail-open) unless the
             application has explicitly configured `onUnavailable: "reject"`;
             the default posture MUST be documented, not silently chosen.
```

PHS-006/PHS-004: screening is **on by default** (NIST SP 800-63B §3.1.1.2 makes checking against compromised-password lists a SHALL; the k-anonymity range API discloses only a 5-character SHA-1 prefix), fail-open, and turning it off is the one line `breachCheck: false`. "Unavailable" means everything short of a well-formed range listing: a transport error, a non-2xx status, a 200 whose body is not a listing (an HTML error page, an empty or truncated body), and a lookup that exceeds `breachCheckTimeout` (3 s by default) — so a black-holed egress can neither hang sign-up nor read as "not breached".

`usage-examples-v4.md` §6.3 states the default outcome directly — "HIBP unreachable → fail-open by default" — and gives the escape hatch for operators who would rather block sign-up than risk admitting a breached password. Fail-open is the default because a third-party outage should not be able to take down account creation for an application that has no other dependency on that provider; fail-closed is available because some deployments' risk posture prefers exactly that trade in the other direction. Either way the choice is explicit configuration, never an accident of how the HTTP call to the provider happened to fail.

_Previous: [BEH-EA-118](15-password.md#beh-ea-118-verification-and-replay) | Next: [BEH-EA-120](15-password.md#beh-ea-120-password-policy-is-configuration-not-a-plugin-variant)_

## BEH-EA-120: Password policy is configuration, not a plugin variant

```ts
password({ breachCheck: true, minLength: 12 })
Password.config({ minLength: 16 })
// signUp with a pwned password → 422 WeakPassword { hints: ["appears in known breaches"] }
```

```text
REQUIREMENT: `minLength`, `breachCheck` and related policy knobs MUST be
             `Password`'s `Context.Reference` configuration, overridable by a
             Layer; changing them MUST NOT change the plugin's contract, table
             set, or migrations.
```

This is ADR-EA-011 ("Configuration Is a Service With a Default") applied to the password plugin specifically: `WeakPassword` is a typed error the contract already declares, and tightening `minLength` from 8 to 16 changes only which inputs trigger it, not the shape of the endpoint. A contract test in the testing harness (file 25, `runPluginContractTests`'s "options do not change the contract hash" check) holds this invariant for every option the plugin exposes, password policy included.

ESS-006/EHA-007: the static half of the policy lives in the contract: every email payload field is `EmailContract.Email` from `@awthaq/api` (a shape check, non-normalizing: one `@`, no whitespace, local part at most 64, domain with a dot, at most 254 in all) and every password field is capped at 1024 characters, so malformed input answers `400` before any rate limit, hasher or database is touched. `minLength` and the breach check stay in `checkPolicy` because they read the runtime configuration a static schema cannot. The endpoints that need a live session (`change-password`, `reauthenticate`) form the `password.account` group with group-level `Authentication`, the same convention `passkey` and `jwt` follow; their wire paths are unchanged.

_Previous: [BEH-EA-119](15-password.md#beh-ea-119-breach-check-is-fail-open-by-default-fail-closed-by-config) | Next: [BEH-EA-121](16-oauth.md#beh-ea-121-pkce-s256-is-structural-not-optional)_

## BEH-EA-259: A credential reset consults BeforeCredentialReset before anything is rewritten

> **See:** [BEH-EA-093](12-hooks.md#beh-ea-093-a-divert-tap-returns-a-typed-alternative-outcome-the-caller-must-handle), [BEH-EA-261](31-two-factor.md#beh-ea-261-a-sign-in-with-a-confirmed-second-factor-is-diverted-and-no-session-exists-until-it-passes)

```ts
POST /password/confirm-reset { token, password, secondFactorCode? } -> 204 | TokenConsumed | WeakPassword | SecondFactorRequired | HookAborted | RateLimited
Hooks.BeforeCredentialReset   // veto: { userId, secondFactorCode? }
```

```text
REQUIREMENT: `confirmReset` MUST run the `BeforeCredentialReset` veto inside
             its transaction — after the emailed token is consumed and before
             the credential is rewritten and the user's sessions revoked — so
             a refusal rolls the consume back (on SQL) and changes nothing.
             A veto with the code `TWO_FACTOR_REQUIRED` MUST surface as the
             typed `SecondFactorRequired` (401); any other veto code as the
             typed `HookAborted`. An account with no tap installed, or with
             no second factor, MUST reset exactly as before.
```

Possession of the mailbox alone must not be able to downgrade an account a stronger factor protects (ARF-005): without the veto, an emailed link could revoke every session and rewrite the credential of a passkey-and-TOTP-protected account. `@awthaq/two-factor`'s `credentialResetGate` is the tap: for an account with a confirmed second factor it demands a TOTP or recovery code in `secondFactorCode`, and a valid one is spent only when the reset commits. `Password.layer` requires the point, so every composition that installs `Password` already provides it through `Hooks.HooksLive`.
