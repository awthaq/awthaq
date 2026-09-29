# Verification Tokens

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-08 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) |

---

> awthaq is pre-implementation (see `spec/README.md`). Every signature, requirement, and behavior in this file specifies intended design — drawn from `archive/PRD.md` §13, `archive/design/usage-examples-v4.md` §6.2, and `better-auth/01-core-domain/01-entities-and-invariants.md` §5 — not code that has shipped.

## BEH-EA-057: A verification token is scoped to one purpose

```ts
identifier = `verify-email:${token}` | `reset-password:${token}` | `oauth-state:${nonce}`
           | `verify-phone:${token}` | `change-email:${token}`
```

```text
REQUIREMENT: A `VerificationToken` row MUST carry an identifier whose
             meaning is scoped to exactly one purpose (email verification,
             password reset, OAuth state, and so on); consuming a token
             created for one purpose MUST NOT satisfy a check for another
             purpose, even if the raw token value were somehow reused.
```

SOS-008/BAM-009: two purposes exist for the identity model (BEH-EA-041/042). `verify-phone` proves control of a phone number (an SMS/voice OTP or link): the token is keyed on the *user id* (`userId` on the row), and the normalized E.164 number being proven travels in the payload, so a stale token cannot verify a number the user has since changed. `change-email` proves control of a *new* address: the row's `userId` is the account, the payload carries the new address, the token is mailed to that new address, and its consumption commits together with `Users.changeEmail` + `Users.verifyEmail` (BEH-EA-058). Neither purpose's token can satisfy the other's — or `verify-email`'s — check.

MLO-009/ARF-007/ARF-009: the mailed form is `<purpose>:<publicId>.<secret>`, built and parsed only by `VerificationLink` (`@awthaq/core`), which every plugin that mails a token uses. `publicId` is 128 random bits and identifies the token, never the user (the user is recovered from the consumed row's `userId`, so no mailed artifact carries a user id or a UUIDv7 timestamp); `decode(raw, purpose)` refuses a malformed token or another purpose's, before any rate limit or consume. Mail data for a token is `{ token: Redacted, expiresAt, url? }` (`VerificationLink.mailData`), the `url` present when the application configured a link builder.

`better-auth/01-core-domain/01-entities-and-invariants.md` §5.1 documents `Verification` as "a generic, single-purpose ephemeral keyed value store," whose `identifier` is an arbitrary string whose meaning is defined entirely by the caller that created the row. awthaq's plan adopts the same generic entity but requires the purpose to be encoded in the identifier's own naming convention, so a password-reset token and an email-verification token are structurally distinct rows even when both happen to exist for the same user at once.

**Caller-formatted values (BCR-005).** `issue` mints the value itself: 256-bit hex by default, or — with `format: { _tag: "Numeric", digits }` (4 to 10 digits) — a uniformly random decimal code drawn by rejection sampling over `Crypto.randomBytes`, never a string the caller supplies, so hashing and single-use cannot be bypassed. The input type requires `maxAttempts` whenever a `format` is given (a short value without a guess budget does not type-check). `@awthaq/magic-link`'s `EmailOtp` is the consumer (BEH-EA-271).


## BEH-EA-058: A verification token's consumption and the state change it authorizes commit in one transaction

> **Invariant:** [INV-EA-009](../invariants.md#inv-ea-009-a-verification-token-is-consumable-exactly-once-inside-the-same-transaction-as-the-state-change-it-authorizes)

```text
REQUIREMENT: Marking a verification token consumed and applying the state
             change it authorizes (a password reset, an email-verification
             flip) MUST commit under one SQL transaction, so that no window
             exists in which the token is marked consumed but the change
             has not applied, or the change has applied but the token
             remains replayable.
```

`archive/PRD.md` §13 and §18 both require tokens to be "single-use in-transaction." `archive/design/usage-examples-v4.md` §6.1 is the worked confirmation of this for password reset: `confirmReset` both consumes the token and rotates the password (and, per BEH-EA-053, issues a fresh session while revoking others) as one operation, so a race between two requests bearing the same token cannot apply the change twice or leave it applied with the token still valid.

## BEH-EA-059: Replaying an already-consumed or unknown token publishes `auth.token.replay`

> **Invariant:** [INV-EA-010](../invariants.md#inv-ea-010-verification-token-replay-is-observable--every-consumption-attempt-after-the-first-publishes-an-event)

```ts
yield* client.verification.confirm({ params: { token: Redacted.make(t) } })
// replaying the same token: 410 TokenConsumed, and event "auth.token.replay" is published
```

```text
REQUIREMENT: A consumption attempt against a token that has already been
             consumed, has expired, or does not exist MUST both fail the
             request and publish an `auth.token.replay` event to
             `AuthEvents` (see [13-events.md](13-events.md)).
```

`archive/design/usage-examples-v4.md` §6.2 documents the exact response shape (`410 TokenConsumed`) alongside the event. Without a distinguishable, queryable signal, an attacker probing stale reset or verification links is indistinguishable from ordinary user error in any downstream monitoring; publishing the event is designed to make replay attempts a first-class operational signal, independent of whatever the audit table separately records (see [13-events.md](13-events.md#beh-ea-100-the-audit-table-is-the-durable-record-of-record-independent-of-the-pubsub-stream)).

## BEH-EA-060: A verification token is hashed at rest

```text
REQUIREMENT: The value compared at consumption time MUST be a hash of the
             token the caller presents, never the token's plaintext stored
             and compared directly.
```

`better-auth/01-core-domain/01-entities-and-invariants.md` §5.1 documents this as a supplier-side confidentiality hardening the base contract explicitly allows: "the same identifier, hashed the same way, must always resolve to the same row." awthaq's plan treats this the same way it treats session secrets (BEH-EA-050): a disclosure of the verification-token table must not itself be sufficient to complete a password reset or email confirmation the token was meant to gate.

## BEH-EA-061: A verification token carries an expiry, treated as invalid before physical removal

```text
REQUIREMENT: A verification token past its `expiresAt` MUST be treated as
             invalid by every read operation immediately, even before any
             cleanup process has physically deleted the row.
```

`better-auth/01-core-domain/01-entities-and-invariants.md` §5.1 states this as a lifecycle property of the entity, not of whatever garbage-collection process eventually removes expired rows: "rows past this instant are treated as already invalid by every read operation, even before they are physically removed." awthaq's plan follows the same rule so that expiry enforcement never depends on the timeliness of a background sweep.

**As shipped (CSG-003, ADR-EA-033):** the physical removal that rule anticipates is `Retention.sweep`, an explicit, opt-in operation (`Retention.layerScheduled` runs it on `RetentionConfig.sweepInterval`; nothing else calls it). `Verification.purgeExpired(before)` deletes tokens consumed or expired before the cutoff and reservations expired before it, in bounded batches, in both layers; the sweep passes `now - verificationForensicWindow` (default 90 days), so a consumed row stays as replay evidence (BEH-EA-058) for that window and a live token is never touched. Ordinary reads and `issue` still never delete history (`packages/core/test/Retention.test.ts`).

## BEH-EA-062: Consuming a verification token is race-safe — at most one concurrent caller succeeds

```text
REQUIREMENT: When multiple callers race to consume the same token
             identifier, at most one MUST receive the non-expired row as a
             success; every other concurrent caller MUST receive "not
             found," and the row MUST be gone afterward regardless of which
             caller won.
```

`better-auth/01-core-domain/01-entities-and-invariants.md` §5.2 documents this as the `consume-verification-value` operation's core guarantee, with an explicit blame rule alongside it: a caller that proceeds with a state change without gating on a non-null consume result is responsible for the resulting violation — the race-safety guarantee protects only callers that actually check the result. awthaq's plan carries the same operation and the same blame assignment into its own `Verification` domain service.

**Bounded guesses (SOS-004).** An issued token may carry a `maxAttempts` budget. A wrong presentation against the *live* row spends one attempt — in the same atomic step as the consume (`layerMemory`'s `Ref.modify`; `layerSql`'s single `UPDATE attempts = attempts + 1, consumedAt = CASE WHEN attempts + 1 >= maxAttempts ...`, core migration 28) — and the row is burned at the budget, so the right value no longer works. The failure is still the uniform `TokenConsumed`; a token with no budget, an unknown identifier and an expired row are untouched, exactly as before.


## BEH-EA-063: A reservation-style identifier answers "who claimed this first," independent of any column-level uniqueness

```text
REQUIREMENT: A caller that needs to claim an identifier exclusively (a
             replay tombstone, a mutual-exclusion lock) MUST receive `true`
             only for the first reservation of that identifier and `false`
             for every subsequent one, for as long as the reservation has
             not expired; a store unable to make this atomic MUST fail
             closed rather than report a false success.
```

`better-auth/01-core-domain/01-entities-and-invariants.md` §5.2 documents this as a distinct operation from ordinary consumption — `reserve-verification-value` — used, for example, to serialize the "promote an unverified user on email proof" operation (§2.3) against a concurrent second promotion of the same user. awthaq's plan reuses the same generic `Verification` entity for this purpose rather than introducing a second, lock-specific table.

**The resend window (MLO-002).** `reserve` is the resend-window primitive: `MagicLink` and `EmailOtp` reserve `<purpose>-resend:<normalised address>` for their `resendWindow` before minting and mailing a second artifact, so two concurrent requests (or a client hammering "resend") send one message, below and independent of the rate limiter (BEH-EA-268, BEH-EA-272).


## BEH-EA-064: Purpose-scoped flows respond uniformly regardless of whether their target exists

```ts
yield* client.password.requestReset({ payload: { email } })   // always 202, even for unknown emails
```

```text
REQUIREMENT: A verification-token-issuing endpoint (password reset,
             email-verification resend) MUST return the same status and
             body whether or not the submitted identifier (email) resolves
             to an existing account. Uniformity extends to latency: the token
             issue and mail send for the "exists" branch MUST run outside the
             response path (dispatched in the background), so both branches do
             the same work before responding and a slow or failing mail
             provider changes neither the response time nor its status.
```

`archive/design/usage-examples-v4.md` §6.1 fixes the concrete response: `requestReset` always answers `202`, whether the email belongs to a real account or not. This is the verification-token analogue of BEH-EA-027's uniform `InvalidCredentials`: an endpoint that answered differently for "no such account" would let an attacker enumerate registered emails one request at a time, defeating the same enumeration-safety goal `archive/PRD.md` §18 states for the sign-in path.

_Previous: [BEH-EA-056](07-sessions.md#beh-ea-056-session-secret-verification-is-a-constant-time-comparison-over-a-fixed-length-hash)_
_Next: [BEH-EA-065](09-authentication-middleware.md#beh-ea-065-the-authentication-middleware-tries-a-cookie-handler-first-in-its-declared-security-record)_
