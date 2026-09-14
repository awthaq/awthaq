# Email-verification sign-in gate + resend endpoint

Type: grilling
Status: resolved

## Question

`Password.ts:468-509`'s `signIn` never reads `emailVerified` — confirmed,
not gated. `verifyEmail` consume exists and is wired (`Password.ts:584-
603`, and `shipping-gaps` ticket 01 already wired the verify-email HTTP
endpoint), but there's no resend-verification endpoint anywhere in
`packages/password/src`.

Decide: whether sign-in should hard-block unverified accounts (upstream's
`EmailNotVerified` 400) or something softer (allow sign-in but flag the
session/response); the resend endpoint's shape and rate-limiting (this
should almost certainly get a `RateLimits` rule per `shipping-gaps`
ticket 02's per-mutating-endpoint policy); whether resend needs its own
throttle beyond IP/identity dual-keying (e.g. cooldown between resends);
and how this interacts with the not-yet-built magic-link plugin (M7) —
does gating logic live somewhere shared so magic-link doesn't reimplement
it, or is this Password-plugin-local for now?

## Answer

Grounded against `Password.ts:407-509` (`signUp`/`signIn`),
`Password.ts:508-533` (`requestReset`'s enumeration-safe pattern),
`PasswordApi.ts:115-180` (endpoint declarations, `EmailAlreadyExists`'s
409-not-401/422 precedent), and `Password.ts:340-385`'s dual rate-limit
registration (inline `rateLimit()` + a separate declarative registry).

**Sign-in — hard block, new `EmailNotVerified` error, checked only
*after* password verification succeeds.** Ordering matters: `signIn`
already always runs `hasher.verify` unconditionally (the `dummyHash`
uniform-cost comment) precisely so a wrong password can never be
distinguished from a nonexistent account. The verification gate must
sit in that same discipline — checked only once `verified` is
confirmed `true`, right before `sessions.issue`, so a caller can never
use it to probe whether a *guessed* password is even close to correct;
only a genuinely correct password ever reveals "verified or not."
`httpApiStatus: 403`, not upstream's `400` — matching `EmailAlreadyExists`'s
own precedent of picking the semantically-correct code over copying
upstream verbatim (403 Forbidden: credentials are valid, the account
state forbids proceeding — closer to the real condition than 400 Bad
Request or 401 Unauthorized).

**Resend — top-level `POST /resend-verification`**, matching
`verifyEmail`'s own top-level convention (`PasswordApi.ts:160-168`'s
comment: account-lifecycle actions aren't nested under `/password/*`).
Payload `{ email: string }` (same shape as `RequestResetPayload`).
Success `HttpApiSchema.Empty(202)`, error `[Api.RateLimited]` only —
copies `requestReset`'s enumeration-safe shape exactly: identical 202
response whether the email doesn't exist, the account is already
verified, or a mail genuinely goes out; only the actual mail differs,
invisible to the caller. New `RATE_LIMITS.resendVerification` entry,
keyed by email like `requestReset`, plus a matching registry entry in
the same `Effect.all([...])` list `Password.ts:349-385` already builds.

**Resend's own throttle — tighter than the generic 5-per-15-min
default.** Unlike password-reset abuse (which mainly burns the
attacker's own attempts), resend-verification abuse is an inbox-flooding
harassment vector against the *target* — recommend `{ limit: 3, window:
Duration.minutes(15) }`, tighter than `RATE_LIMITS.requestReset`'s 5.
Exact numbers aren't load-bearing; the point is deliberately stricter
than the copy-pasted default, not the specific figure.

**Magic-link (M7) — Password-plugin-local, no shared gating function
needed.** Not really a sharing question: a magic-link sign-in *is itself*
proof of inbox control, the same fact password + emailVerified together
establish for `Password` — so magic-link's own future `signIn` should
mark `emailVerified` true on first successful click (implicit
verification), not consult the same "is this account gated" check
`Password.signIn` runs. The one thing that *is* already shared and needs
no new plumbing: `Users.verifyEmail(userId)` already lives in
`@awthaq/core`, not `@awthaq/password` — magic-link calls that same
core primitive directly when it ships, same as `Password.verifyEmail`
does today. Building an abstract shared "gating policy" now, for a
plugin whose actual verification mechanism differs in kind, would be
exactly the speculative infrastructure this map's own standing
preference warns against.
