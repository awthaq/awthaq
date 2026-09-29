# Device Authorization

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-MOD-13 |
> | Revision | 1.3 |
> | Effective Date | 2026-09-29 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Planning |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-29): Added the security parameters (DAG-004) and the design constraints adopted from better-auth's polling state machine (DAG-005); registered the acceptance scenarios as `@skip @unwired` (DAG-007) <br> 1.2 (2026-09-29): Named the CLI session commands as the first consumer and pointed poll-issued sessions at `BeforeSessionIssue` (CTA-002/DAG-003, CCR-EA-006) <br> 1.3 (2026-09-29): Implemented as `@awthaq/device-authorization` (BEH-EA-299 to 306, [37-device-authorization.md](../behaviors/37-device-authorization.md)) with the CLI's interactive `login` as its first consumer (BEH-EA-307); the sketch below is replaced by the shipped shape, the acceptance scenarios are wired |
---

## What it is
The `DeviceAuthorization` plugin (`@awthaq/device-authorization`) implementing the OAuth 2.0 Device Authorization Grant (RFC 8628): an input-constrained device (a smart TV, a CLI, a set-top box) displays a short user code and a URL, the user completes sign-in on a second device (their phone or laptop), and the first device polls until the grant is approved and receives a session or token. It shares the divert/step-up hook-point machinery `archive/PRD.md` §9.3 defines for `Two-Factor` — the first device's poll loop is diverted (pending, then approved or denied) in the same way a password sign-in is diverted to a 2FA challenge.

## Who asks for it
`archive/PRD.md` §17 lists `DeviceAuthorization` as a Phase-3 official plugin with no further elaboration; no worked example or design discussion exists for it in `archive/design/usage-examples-v4.md` or `archive/design/usage-qadi.md`. `research/03-auth-landscape.md`'s TL;DR situates the grant among CLI/TV/agent-facing authentication rather than the browser-first flows the rest of the matrix targets, grouping it with "the 2026 frontier" of agent/MCP identity work ("agent/MCP identity... is the 2026 frontier") rather than with the enterprise-tier B2B methods (SSO, SAML, SCIM) it is filed alongside in the phase table. The realistic asker is a developer tool or a TV/console application that cannot practically render awthaq's normal browser-based sign-in surface.

## Status
| Property | Value |
|---|---|
| Status | Implemented (BEH-EA-299 to 306; the CLI consumer is BEH-EA-307) |
| Priority | P4 |
| Enabler(s) | E4 — Hook-point step-up/divert wiring |
| Breaking? | Additive: a device-authorization poll is a new endpoint pair (`/device/code`, `/device/token`) and a new divert outcome on top of existing session issuance: nothing about `Sessions`, `Password`, or the MVP contract needs to change shape to add it, per the plugin-as-Layer model in `archive/design/plugins-as-layers.md` where new plugins only add to the merged contract's groups and `RIn`. |

## How it is expressed
```ts
export class DeviceAuthorization extends AuthPlugin.Service<DeviceAuthorization, DeviceAuthorizationShape>()(
  "device_authorization",
  {
    apiVersion: 1,
    contract: DeviceAuthorizationApi,          // groups: device_authorization, .verification, .decision
    tables: ["device_authorization_grant", "device_authorization_client"],
    migrations,
    rateLimits: [/* the default budgets, declared statically (PV-241) */],
  },
) {
  static readonly layer = AuthPlugin.layer(DeviceAuthorization, {
    ports: [ClientAddress.ClientAddress, RateLimiter.RateLimiter],
    handlers: DeviceAuthorizationHandlers,
    contributes: Layer.mergeAll(deviceAuthorizationErasure, deviceAuthorizationExport),
    make: /* requestCode, poll, verify, approve, deny, registerClient, revokeClient, purgeExpired */,
  });
}
```
Three endpoint groups, because the three callers differ: the **device** (`POST /device/code`, `POST /device/token`: form-encoded, anonymous, no CSRF), the **verification page** (`POST /device/verify` under `OptionalAuthentication`, so an anonymous caller still learns `{ user_code, status }`) and the **decision** (`POST /device/approve`, `/deny`, behind `Authentication` and `CsrfProtection`). Clients are public and registered by an operator (configuration, or the `device_authorization_client` table through `registerClient`); no HTTP endpoint registers one, because a client's name is what a person consents to. The session a redeemed grant mints is an ordinary bearer session (`SessionDelivery`), issued through `BeforeSignIn` and `BeforeSessionIssue`, carrying the approving session's `amr`. See the package README and [the behaviors](../behaviors/37-device-authorization.md).

## Worked example
```ts
const auth = Auth.make([DeviceAuthorization.DeviceAuthorization]);
// $ awthaq login --base-url https://auth.acme.com
//   To sign in, open https://app.acme.com/device?user_code=BCDF-GHJK and confirm the code BCDF-GHJK
// (the person signs in on their phone, opens the page, and approves; the terminal is then logged in)
```
The application builds the verification page over `POST /device/verify`, `/approve` and `/deny`; `@awthaq/cli` is the reference device client.

## Security parameters
Fixed now so the plugin, when a milestone schedules it, is built to numbers rather than to taste (DAG-004). Wayfinder ticket 06 makes this plugin the login backend of `@awthaq/cli` (the CLI is an outbound-only client of it), so these are the parameters a CLI login is protected by.

- **User code.** 8 characters drawn uniformly from the 20-symbol unambiguous consonant alphabet `BCDFGHJKLMNPQRSTVWXZ` (no vowels, so no accidental words; no `0/O`, `1/I/L` confusables beyond `L`, which is kept) — about 34.6 bits, the example RFC 8628 §6.1 gives. Displayed `XXXX-XXXX`. Input is normalized (uppercased, `-` and spaces stripped) and then matched **exactly**; no fuzzy or prefix matching. Stored as a SHA-256 hash and looked up by that hash, so the lookup is constant-time by construction and a database read yields no usable code.
- **Device code.** 32 CSPRNG bytes, base64url, stored hashed (SHA-256) like a session secret; never logged.
- **Lifetimes.** `expires_in` defaults to 15 minutes (`DeviceAuthorizationConfig`, a `Context.Reference` with a default). The poll `interval` is 5 seconds; a poll arriving sooner answers `slow_down` and the server-side interval is raised by 5 seconds (RFC 8628 §3.5).
- **Rate limits** (the `RateLimiter` port, BEH-EA-105, registered through the plugin's rule registry like `Password.ts`'s `RATE_LIMITS`): `POST /device/code` 5 per TTL per IP; the verification/approval endpoint 5 failed user-code lookups per 15 minutes, per IP and per session; `/device/token` enforces `interval` per `device_code` (a violation is `slow_down`, not a `429`).
- **Session issuance.** The approved poll calls `Sessions.issue` for the claimed user through `Hooks.BeforeSessionIssue` (wayfinder ticket 03), so a `TwoFactor` divert applies to a device login exactly as to a password one, and the resulting session records the device's address and user agent (BEH-EA-054).

## Design constraints
Adopted from the better-auth polling state machine analysed in `better-auth/05-mfa-and-verification/08-device-authorization-and-one-tap.md` §A.1–A.6, restated here as awthaq's own normative intent (DAG-005; the analysis stays non-normative evidence, `spec/README.md`). They are BEH-EA-299 to 306 in [37-device-authorization.md](../behaviors/37-device-authorization.md).

1. **State advances only** `pending → approved | denied`; a terminal state never returns to `pending`.
2. **Approve and deny are compare-and-swap** on `status = pending` (and, for approval, on the row already being claimed by the approving session's user), so two racing decisions cannot both win.
3. **Redemption runs every fallible check first** (client and ownership checks, user lookup, hooks), and only then performs an **atomic conditional consume** (`id` + owner + `status = approved`). Side effects — the session — run strictly after the claim, so under concurrent polls a session is issued **at most once** and a losing poller never observes a session minted from a code it did not win (`invalid_grant`).
4. **Server-side `slow_down`.** `lastPolledAt` is updated on every poll that passes the interval check, *including* ones about to be rejected as pending, expired or denied, so a client cannot dodge throttling by polling a dead code.
5. **Garbage collection on discovery.** An expired row is deleted the first time a poll discovers it (`expired_token`); a denied row is deleted on observation (`access_denied`). The verification page rejects an expired code without deleting it.
6. **Verification is idempotent for one session and impossible for another.** A session that opens the verification page claims an unclaimed pending code (compare-and-swap on `status = pending` and no user yet); repeated visits by the same session are a no-op, a different session cannot claim it. Only the claiming user sees the client and scope context; anyone else sees `{ user_code, status }`. Approval without a prior claim is refused.
7. **User-code entropy, alphabet and rate limits** are as in [Security parameters](#security-parameters).
8. **The client MUST add 5 seconds to its polling interval on every `slow_down`** (RFC 8628 §3.5); `@awthaq/cli`'s login loop does, and never polls faster than the server-advised interval.

## What is missing
The plugin ships the endpoints, not the page: the verification UI is the application's to build over `verify`, `approve` and `deny`. `scope` is advisory (the approval page shows it and the grant records it; the minted session carries the user's own authority), so a scope-limited device credential is `@awthaq/api-key`'s job, not this plugin's. Core's `Retention.sweep` does not know plugin tables, so a host that wants scheduled purging of grants nobody polled again calls `purgeExpired` from its own retention job. The user-code hash is SHA-256 (the model fixes it): it keeps a usable code out of backups and logs, it does not withstand offline guessing of 34.6 bits, which is why a code lives 15 minutes and every failed lookup spends a budget.

**First consumer: the CLI ([BEH-EA-307](../behaviors/26-cli.md#beh-ea-307-interactive-login-is-the-device-authorization-grant-polled-with-backoff)).** The `login` command of [26-cli.md](../behaviors/26-cli.md#beh-ea-227-session-commands-login-logout-whoami-are-outbound-only-clients-of-a-running-auth-server) is the first client of `/device/code` and `/device/token`: it requests a code, prints the user code and verification URI, and polls on a schedule that starts at the server's `interval`, widens by 5 seconds on `slow_down` and stops on `expired_token`. It is an outbound client only (BEH-EA-208). The session it receives is issued through the same `Hooks.BeforeSessionIssue` divert point as every other login method (`packages/core/src/Hooks.ts`), so a second factor or a policy hook applies to a device grant exactly as it does to a password sign-in; an approving session that already proved a second factor (`amr` `mfa`) is not asked for one again ([BEH-EA-304](../behaviors/37-device-authorization.md)).

## Verification
`packages/device-authorization/test/` (the plugin over both record stores, and the wire), `packages/cli/test/DeviceLogin.test.ts` (the CLI against a real server on a real socket) and the wired scenarios in `features/features/05-authentication-methods/28-device-authorization.feature` (polling states, `slow_down`, at-most-once redemption, expiry cleanup, claim idempotency, the user-code rate limits, the session's device metadata); the Postgres run of the plugin's suites is part of `pnpm run test:pg`.

_Related: [00 — Adoption Matrix](00-adoption-matrix.md)_
