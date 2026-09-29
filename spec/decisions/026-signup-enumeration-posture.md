# ADR-EA-026: Sign-Up Reveals an Existing Address by Default, With an Opt-In Conceal Mode

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-026 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-29 |
> | Status | Accepted — implemented |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-29): Initial release (TMS-005, TSS-007) |

---

## Context

BEH-EA-086 requires that no endpoint reveal whether an account exists: sign-in answers `InvalidCredentials` uniformly (BEH-EA-114), and `requestReset` and `resendVerification` always answer `202` (BEH-EA-064). `password.signUp` is the one exception that was never recorded: an address that already has an account gets `409 EmailAlreadyExists`, while a fresh one gets `200` and a session. That difference is an account-existence oracle. Closing it changes the endpoint's contract, not just its internals: a fresh sign-up can no longer hand back a session, because doing so for an existing address would mean logging the caller in as somebody else.

Most applications want the plain experience (immediate feedback that an address is taken, immediate session); security-sensitive ones do not want to disclose registration at all. Neither is wrong, and both are cheap to serve.

## Decision

1. **The posture is a configuration choice:** `PasswordConfig.signUpEnumeration`, `"reveal"` (the default) or `"conceal"`.
2. **`"reveal"` is BEH-EA-086's deliberate, documented exception.** `signUp` keeps `409 EmailAlreadyExists` and the immediate session. Its compensating controls are the per-source and per-address rate limits on `signUp` (`signUpByIp`, `signUp`), which bound enumeration by volume; it is not an unmetered oracle.
3. **`"conceal"` answers `202` with an empty body for a fresh and an existing address alike, and issues no session.** A fresh address gets its account created (unverified) and the verification mail; an existing address's owner gets an `account-exists` mail carrying no token. The password is hashed in both branches, the transaction is attempted in both, and both mails are dispatched in the background, so status, body and the dominant cost match. The account is usable after the mailbox is proven, through `signIn`'s verified-email gate (`requireVerifiedEmail`, on by default); disabling that gate while concealing gives up the "no session until the mailbox is proven" property.
4. **Contract:** `POST /password/sign-up` declares two success shapes, `200 SessionDto` and `202` empty, so a client written against either posture type-checks against both. `PasswordShape.signUp` is the reveal operation; `signUpConcealed` is the conceal one, and the HTTP handler picks by configuration.

## Alternatives considered

**Always conceal.** Rejected as the default: it removes the immediate feedback and immediate session most applications rely on, and it needs a working mailer to be usable at all.

**Always reveal, documented only.** Rejected: it leaves security-sensitive deployments with no way to close the oracle short of forking the plugin.

## Consequences

**Positive**: the posture is explicit and testable in both directions; conceal reuses the mail dispatcher (ERS-002) and the existing verification flow.

**Negative**: conceal cannot be adopted transparently by an existing client that expects a session from `signUp`; the two branches still differ by one uncommitted insert, a residual timing difference far smaller than the hash both pay; and an unreachable mailer makes conceal-mode sign-ups silently unusable until it recovers (the `auth.mail.failed` event is the signal).
