# Email-verification sign-in gate + resend endpoint

Type: grilling
Status: open

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
