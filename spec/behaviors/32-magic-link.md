# Magic Link
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-32 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-29 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-29): Initial release (BAM-007, MLO-005, MLO-002, ARF-005 Fix A; wayfinder ticket 05 §2), replacing [MOD-EA-004](../models/04-magic-link.md)'s non-normative sketch |
---

> Status: the `MagicLink` plugin in `@awthaq/magic-link` is implemented and tested (`packages/magic-link/test/MagicLink.test.ts`, `AuthHttp.test.ts`). It shares its channel-credential module with [`EmailOtp`](33-email-otp.md).

## BEH-EA-264: A magic link is consumed only by POST, and its token travels in the URL fragment

```ts
POST /magic-link/request { email }   -> 202
POST /magic-link/verify  { token }   -> SessionDto | MagicLinkConsumed | ...
// no GET route exists under /magic-link
```

```text
REQUIREMENT: The contract MUST declare no GET (or HEAD) endpoint that consumes
             a magic-link token, and the token MUST NOT be accepted from a
             query string. The mailed URL SHOULD carry the token in its
             fragment (`<baseUrl>/magic-link#token=<token>`), which a browser
             never sends to a server, and the application's own page MUST
             POST it to `/magic-link/verify` only after the person acts on it.
```

Mail scanners, link previewers and browser prefetch dereference every URL in a message with a GET. A link that signs a person in on GET is consumed — and a session minted — by the scanner before the person clicks (MLO-005). The fragment additionally keeps the token out of server logs, proxies and `Referer` headers. The interstitial the application needs is a static page: read `location.hash`, show a "Continue" button, POST on click (see the package README).

_Next: [BEH-EA-265](32-magic-link.md#beh-ea-265-requesting-a-link-answers-202-for-every-address-and-mails-at-most-one-link-per-window)_

## BEH-EA-265: Requesting a link answers 202 for every address and mails at most one link per window

```ts
MagicLink.requestLink({ email, ip }): Effect<void, RateLimited>
```

```text
REQUIREMENT: `request` MUST answer `202` identically whether or not the
             address has an account, whether or not a mail is sent and
             whether or not the address is inside its resend window; the
             user lookup, the token and the mail MUST happen in background
             work so neither the body nor the timing of the response depends
             on them (BEH-EA-64). It MUST be rate limited per source (30 per
             15 minutes) and per normalised address (5 per 15 minutes, `+tag`
             variants sharing one bucket). An address MUST be mailed at most
             one link per `resendWindow` (default 60 s), enforced with
             `Verification.reserve` (BEH-EA-63). With `allowSignUp` off, an
             unknown address MUST be answered like any other and not mailed;
             asking for a link MUST NOT create a user.
```

The mail is the template `magic-link` with `{ token: Redacted, expiresAt, url? }` (BEH-EA-57's shared codec); `url` is set when `baseUrl` or `link` is configured. Delivery goes through a `MailDispatch` dispatcher (retries, bounded concurrency, `auth.mail.failed` on loss).

_Previous: [BEH-EA-264](32-magic-link.md#beh-ea-264-a-magic-link-is-consumed-only-by-post-and-its-token-travels-in-the-url-fragment) | Next: [BEH-EA-266](32-magic-link.md#beh-ea-266-presenting-a-link-proves-the-mailbox-and-signs-in-through-the-shared-gate-and-the-mfa-divert)_

## BEH-EA-266: Presenting a link proves the mailbox and signs in through the shared gate and the MFA divert

```ts
MagicLink.verify({ token, ip }, { userAgent }): Effect<IssuedSession, MagicLinkConsumed | RateLimited | HookAborted | TwoFactorRequired | UserSuspended>
```

```text
REQUIREMENT: `verify` MUST decode the token and check its purpose before
             anything is rate limited or consumed, MUST consume it through
             `Verification.consume` (single use; expired, replayed, foreign
             and malformed tokens all the one `MagicLinkConsumed`, 410), and
             then, through the shared channel step: find the user the row
             names or the one owning the address, or — only when `allowSignUp`
             is on and the `BeforeSignUp` veto passes — create one; mark the
             mailbox verified; run `Users.assertCanSignIn`, the
             `BeforeSignIn` veto and `BeforeSessionIssue`; and issue a
             session recorded as `amr ["email"]`. A user with a confirmed
             second factor MUST be diverted to `TwoFactorRequired` and no
             session minted (ARF-005 Fix A).
```

The user is created *after* the proof, never at request time. A magic link never links, unlinks or replaces any credential of an existing account (an existing password credential is untouched). A refusal publishes `auth.user.signInFailed { strategy: "magicLink" }`.

_Previous: [BEH-EA-265](32-magic-link.md#beh-ea-265-requesting-a-link-answers-202-for-every-address-and-mails-at-most-one-link-per-window) | Next: [BEH-EA-267](32-magic-link.md#beh-ea-267-a-magic-link-is-a-verification-row-under-its-own-purpose-with-no-table-of-its-own)_

## BEH-EA-267: A magic link is a Verification row under its own purpose, with no table of its own

```text
REQUIREMENT: A magic-link token MUST be a `Verification` row under the purpose
             `magic-link` with a random 128-bit public id — never the user id
             or the address in the token (ARF-009) — and the address it was
             issued for MUST ride in the row's server-side `payload`. The
             plugin MUST declare no table.
```

The token is `VerificationLink`'s `<identifier>.<secret>`; the user is recovered from the consumed row, and a link for a not-yet-existing user carries the address in its payload so verification knows whom to create. Rows are hashed at rest and purged by the retention sweep like every other verification row.

_Previous: [BEH-EA-266](32-magic-link.md#beh-ea-266-presenting-a-link-proves-the-mailbox-and-signs-in-through-the-shared-gate-and-the-mfa-divert)_
