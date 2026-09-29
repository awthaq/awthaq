# Device Authorization

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-MOD-13 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Planning |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-29): Added the security parameters (DAG-004) and the design constraints adopted from better-auth's polling state machine (DAG-005); registered the acceptance scenarios as `@skip @unwired` (DAG-007) |
---

## What it is
A plan for a `DeviceAuthorization` plugin implementing the OAuth 2.0 Device Authorization Grant (RFC 8628): an input-constrained device (a smart TV, a CLI, a set-top box) displays a short user code and a URL, the user completes sign-in on a second device (their phone or laptop), and the first device polls until the grant is approved and receives a session or token. It shares the divert/step-up hook-point machinery `archive/PRD.md` §9.3 defines for `Two-Factor` — the first device's poll loop is diverted (pending, then approved or denied) in the same way a password sign-in is diverted to a 2FA challenge.

## Who asks for it
`archive/PRD.md` §17 lists `DeviceAuthorization` as a Phase-3 official plugin with no further elaboration; no worked example or design discussion exists for it in `archive/design/usage-examples-v4.md` or `archive/design/usage-qadi.md`. `research/03-auth-landscape.md`'s TL;DR situates the grant among CLI/TV/agent-facing authentication rather than the browser-first flows the rest of the matrix targets, grouping it with "the 2026 frontier" of agent/MCP identity work ("agent/MCP identity... is the 2026 frontier") rather than with the enterprise-tier B2B methods (SSO, SAML, SCIM) it is filed alongside in the phase table. The realistic asker is a developer tool or a TV/console application that cannot practically render awthaq's normal browser-based sign-in surface.

## Status
| Property | Value |
|---|---|
| Status | Planned-Phase3 |
| Priority | P4 |
| Enabler(s) | E4 — Hook-point step-up/divert wiring |
| Breaking? | Additive: a device-authorization poll is a new endpoint pair (`/device/code`, `/device/token`) and a new divert outcome on top of existing session issuance: nothing about `Sessions`, `Password`, or the MVP contract needs to change shape to add it, per the plugin-as-Layer model in `archive/design/plugins-as-layers.md` where new plugins only add to the merged contract's groups and `RIn`. |

## How it would be expressed
No plugin-class sketch exists in `archive/PRD.md` beyond the one-line mention in §17. A plausible shape, consistent with the `AuthPlugin.Service` pattern in `archive/PRD.md` §9.1 and the divert hook-point machinery §9.3 describes for `Two-Factor`:
```ts
export class DeviceAuthorization extends AuthPlugin.Service<DeviceAuthorization, {
  requestCode(): Effect.Effect<{ deviceCode: string; userCode: string; verificationUri: string; interval: number }>
  poll(deviceCode: string): Effect.Effect<SessionView, DeviceAuthorizationPending | DeviceAuthorizationDenied | DeviceAuthorizationExpired>
  approve(userCode: string): Effect.Effect<void, InvalidUserCode>          // completed on the second, authenticated device
}>()("deviceAuthorization", {
  apiVersion: 1,
  contract: DeviceAuthorizationApi,
  tables: ["device_authorization_grant"],
  migrations
}) {
  static readonly layer = AuthPlugin.layer(DeviceAuthorization, {
    dependsOn: [Sessions, Users],
    make: Effect.gen(function*() {
      const config = yield* DeviceAuthorizationConfig   // code length, poll interval, expiry
      /* not yet designed beyond this shape */
      return DeviceAuthorization.of({ requestCode, poll, approve })
    }),
    handlers: DeviceAuthorizationHandlers
  })
}
```
The class sketch above remains a sketch — it is drawn only from the general `AuthPlugin.Service` pattern and RFC 8628's three-endpoint structure — but the *behaviour* it must have is no longer speculative: [Security parameters](#security-parameters) and [Design constraints](#design-constraints) below fix it in awthaq's own words, and the acceptance scenarios are registered in `features/features/05-authentication-methods/28-device-authorization.feature`.

## Worked example
No worked example drafted yet. Neither `archive/design/usage-examples-v4.md` nor `archive/design/usage-qadi.md` carries a Device Authorization section as of this revision.

## Security parameters
Fixed now so the plugin, when a milestone schedules it, is built to numbers rather than to taste (DAG-004). Wayfinder ticket 06 makes this plugin the login backend of `@awthaq/cli` (the CLI is an outbound-only client of it), so these are the parameters a CLI login is protected by.

- **User code.** 8 characters drawn uniformly from the 20-symbol unambiguous consonant alphabet `BCDFGHJKLMNPQRSTVWXZ` (no vowels, so no accidental words; no `0/O`, `1/I/L` confusables beyond `L`, which is kept) — about 34.6 bits, the example RFC 8628 §6.1 gives. Displayed `XXXX-XXXX`. Input is normalized (uppercased, `-` and spaces stripped) and then matched **exactly**; no fuzzy or prefix matching. Stored as a SHA-256 hash and looked up by that hash, so the lookup is constant-time by construction and a database read yields no usable code.
- **Device code.** 32 CSPRNG bytes, base64url, stored hashed (SHA-256) like a session secret; never logged.
- **Lifetimes.** `expires_in` defaults to 15 minutes (`DeviceAuthorizationConfig`, a `Context.Reference` with a default). The poll `interval` is 5 seconds; a poll arriving sooner answers `slow_down` and the server-side interval is raised by 5 seconds (RFC 8628 §3.5).
- **Rate limits** (the `RateLimiter` port, BEH-EA-105, registered through the plugin's rule registry like `Password.ts`'s `RATE_LIMITS`): `POST /device/code` 5 per TTL per IP; the verification/approval endpoint 5 failed user-code lookups per 15 minutes, per IP and per session; `/device/token` enforces `interval` per `device_code` (a violation is `slow_down`, not a `429`).
- **Session issuance.** The approved poll calls `Sessions.issue` for the claimed user through `Hooks.BeforeSessionIssue` (wayfinder ticket 03), so a `TwoFactor` divert applies to a device login exactly as to a password one, and the resulting session records the device's address and user agent (BEH-EA-054).

## Design constraints
Adopted from the better-auth polling state machine analysed in `better-auth/05-mfa-and-verification/08-device-authorization-and-one-tap.md` §A.1–A.6, restated here as awthaq's own normative intent for Phase 3 (DAG-005; the analysis stays non-normative evidence, `spec/README.md`). A BEH-EA range is allocated when the plugin enters a roadmap milestone.

1. **State advances only** `pending → approved | denied`; a terminal state never returns to `pending`.
2. **Approve and deny are compare-and-swap** on `status = pending` (and, for approval, on the row already being claimed by the approving session's user), so two racing decisions cannot both win.
3. **Redemption runs every fallible check first** (client and ownership checks, user lookup, hooks), and only then performs an **atomic conditional consume** (`id` + owner + `status = approved`). Side effects — the session — run strictly after the claim, so under concurrent polls a session is issued **at most once** and a losing poller never observes a session minted from a code it did not win (`invalid_grant`).
4. **Server-side `slow_down`.** `lastPolledAt` is updated on every poll that passes the interval check, *including* ones about to be rejected as pending, expired or denied, so a client cannot dodge throttling by polling a dead code.
5. **Garbage collection on discovery.** An expired row is deleted the first time a poll discovers it (`expired_token`); a denied row is deleted on observation (`access_denied`). The verification page rejects an expired code without deleting it.
6. **Verification is idempotent for one session and impossible for another.** A session that opens the verification page claims an unclaimed pending code (compare-and-swap on `status = pending` and no user yet); repeated visits by the same session are a no-op, a different session cannot claim it. Only the claiming user sees the client and scope context; anyone else sees `{ user_code, status }`. Approval without a prior claim is refused.
7. **User-code entropy, alphabet and rate limits** are as in [Security parameters](#security-parameters).
8. **The client MUST add 5 seconds to its polling interval on every `slow_down`** (RFC 8628 §3.5); `@awthaq/cli`'s login loop does, and never polls faster than the server-advised interval.

## What is missing
This is one of the two least-designed rows in the matrix, alongside SCIM. Beyond the one-line mention in `archive/PRD.md` §17, there is no `DeviceAuthorizationApi` contract and no code; the interaction with the `BeforeSessionIssue` hook point, the user-code and rate-limit parameters and the polling state machine are now specified above but not built. The BEH-EA range and the wire contract are allocated when a roadmap milestone schedules the plugin.

## Verification
No code exists, so no test does. The acceptance scenarios (polling states, `slow_down`, at-most-once redemption, expiry cleanup, claim idempotency, the user-code rate limits, the session's device metadata) are registered as `@skip @unwired` in `features/features/05-authentication-methods/28-device-authorization.feature`, so they are pinned before the implementation.

_Related: [00 — Adoption Matrix](00-adoption-matrix.md)_
