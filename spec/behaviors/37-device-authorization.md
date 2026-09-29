# Device Authorization
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-37 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-29 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-29): Initial release (implementing [MOD-EA-013](../models/13-device-authorization.md) as `@awthaq/device-authorization`; DAG-004, DAG-005, DAG-007, wayfinder tickets 06 and 10) |
---

> `@awthaq/device-authorization` composes as `Auth.make([DeviceAuthorization])` and serves three groups: `device_authorization` (`POST /device/code`, `POST /device/token`, the anonymous back channel a device speaks), `device_authorization.verification` (`POST /device/verify`, under `OptionalAuthentication`) and `device_authorization.decision` (`POST /device/approve`, `POST /device/deny`, behind `Api.Authentication`). It is the OAuth 2.0 Device Authorization Grant ([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628)): an input-constrained client shows a short code, the person approves it on a second, signed-in device, and the client's poll receives an ordinary bearer session. It is the login backend of `@awthaq/cli` ([BEH-EA-227](26-cli.md), [BEH-EA-307](26-cli.md#beh-ea-307-interactive-login-is-the-device-authorization-grant-polled-with-backoff)). The numbers and the state machine are fixed in [MOD-EA-013](../models/13-device-authorization.md) "Security parameters" and "Design constraints"; this file is where they become requirements.

## BEH-EA-299: A code request mints a hashed device code and an unambiguous user code for a registered client

```ts
DeviceAuthorization.requestCode({ clientId, scope, ip }, { verificationBase }): Effect<CodeIssued, InvalidClient | InvalidScope | RateLimited>
// POST /device/code  client_id=…&scope=…  ->  { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval }
```

```text
REQUIREMENT: `POST /device/code` MUST be form-encoded, anonymous and free of
             any CSRF check (a device is not a browser). It MUST answer only
             for a registered, unrevoked client (`invalid_client` otherwise)
             and only for scopes that client is registered for
             (`invalid_scope`). The user code MUST be 8 symbols drawn
             uniformly (rejection sampling, no modulo bias) from the 20-symbol
             alphabet `BCDFGHJKLMNPQRSTVWXZ` (about 34.6 bits) and displayed
             `XXXX-XXXX`; the device code MUST be 32 CSPRNG bytes, base64url.
             Both MUST be stored only as their SHA-256 hash and looked up by
             it; neither MUST be logged or published. `expires_in` MUST
             default to 15 minutes and `interval` to 5 seconds
             (`DeviceAuthorizationConfig`). A user code MUST be normalised
             (upper-cased, hyphens and whitespace stripped) and then matched
             exactly: no fuzzy or prefix matching. `verification_uri` MUST be
             `DeviceAuthorizationConfig.verificationUri`, else the request's
             own origin plus `/device`, and `verification_uri_complete` MUST
             add `?user_code=`.
```

A user-code collision with a live row draws again rather than failing. The hash is SHA-256 (`SecretHash`), not a password KDF: the user code is short-lived (15 minutes), rate limited on every lookup ([BEH-EA-303](37-device-authorization.md#beh-ea-303-failed-user-code-lookups-and-code-requests-spend-rate-limit-budgets)) and only ever a lookup key, so the hash's job is that a database read, a backup or a log yields no usable code, not that it withstands offline guessing of a 34.6-bit space.

_Next: [BEH-EA-300](37-device-authorization.md#beh-ea-300-the-poll-answers-the-rfc-8628-states-enforces-its-interval-and-cleans-up-on-discovery)_

## BEH-EA-300: The poll answers the RFC 8628 states, enforces its interval and cleans up on discovery

```ts
DeviceAuthorization.poll({ deviceCode, clientId, ip }, { userAgent }): Effect<RedeemedGrant, AuthorizationPending | SlowDown | AccessDenied | ExpiredToken | InvalidGrant | …>
// POST /device/token  grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=…&client_id=…
```

```text
REQUIREMENT: The state MUST only advance `pending -> approved | denied`; a
             terminal state MUST NOT return to `pending`. A poll MUST answer,
             each as an RFC 6749 §5.2 body (`error`, HTTP 400):
             `invalid_grant` for a device code that is unknown, another
             client's or already redeemed; `slow_down` for a poll arriving
             before the grant's `interval` has elapsed, raising the
             server-side interval by 5 seconds (RFC 8628 §3.5) and carrying the
             new value; `expired_token` past `expires_in`;
             `access_denied` for a denied grant; `authorization_pending` while
             undecided. `lastPolledAt` MUST be updated on every poll that
             passes the interval check, including one about to be rejected as
             pending, expired or denied, so polling a dead code cannot dodge
             throttling. An expired row MUST be deleted the first time a poll
             discovers it, and a denied row on observation; the verification
             endpoint MUST reject an expired code without deleting it. Another
             `grant_type` MUST be `unsupported_grant_type` and an empty
             `device_code` `invalid_request`.
```

A poll that arrives too soon is a `slow_down`, never a `429`. The interval check reads `lastPolledAt` and is deliberately not a compare-and-swap: two polls arriving together both pass it and race at the redemption claim ([BEH-EA-304](37-device-authorization.md#beh-ea-304-redemption-issues-an-ordinary-bearer-session-only-after-winning-an-atomic-claim)), where exactly one wins. A client MUST add 5 seconds to its interval on every `slow_down` ([BEH-EA-307](26-cli.md#beh-ea-307-interactive-login-is-the-device-authorization-grant-polled-with-backoff)).

_Previous: [BEH-EA-299](37-device-authorization.md#beh-ea-299-a-code-request-mints-a-hashed-device-code-and-an-unambiguous-user-code-for-a-registered-client) | Next: [BEH-EA-301](37-device-authorization.md#beh-ea-301-opening-the-verification-page-claims-an-unclaimed-code-for-the-first-user-and-shows-context-only-to-them)_

## BEH-EA-301: Opening the verification page claims an unclaimed code for the first user and shows context only to them

```ts
DeviceAuthorization.verify({ userCode, ip }, caller: Option<Caller>): Effect<VerificationView, InvalidUserCode | RateLimited>
// POST /device/verify  { user_code }  ->  { user_code, status, client?, scope?, expires_at? }
```

```text
REQUIREMENT: A signed-in user opening the verification page MUST claim an
             unclaimed pending code with a compare-and-swap on `status =
             pending` and no user yet; opening it again as the same user MUST
             be a no-op and a different user MUST NOT be able to claim it.
             Only the claiming user MUST be shown the client (id and name),
             scope and expiry; an anonymous caller, an impersonation session
             or any other user MUST receive only `{ user_code, status }`. An
             anonymous caller MUST NOT claim. A malformed, unknown or expired
             code MUST be one `InvalidUserCode` (404).
```

_Previous: [BEH-EA-300](37-device-authorization.md#beh-ea-300-the-poll-answers-the-rfc-8628-states-enforces-its-interval-and-cleans-up-on-discovery) | Next: [BEH-EA-302](37-device-authorization.md#beh-ea-302-approve-and-deny-are-compare-and-swap-decisions-by-the-claiming-user-only)_

## BEH-EA-302: Approve and deny are compare-and-swap decisions by the claiming user only

```ts
DeviceAuthorization.approve({ userCode, ip }, caller): Effect<VerificationView, InvalidUserCode | UserCodeNotClaimed | DeviceApprovalRefused | RateLimited | HookAborted>
DeviceAuthorization.deny({ userCode, ip }, caller): Effect<VerificationView, InvalidUserCode | UserCodeNotClaimed | DeviceApprovalRefused | RateLimited>
// POST /device/approve | /device/deny  { user_code }  ->  { user_code, status }
```

```text
REQUIREMENT: Both endpoints MUST sit behind `Api.Authentication` and
             `Api.CsrfProtection`. A decision MUST be a compare-and-swap on
             `status = pending`, on the row being claimed by the deciding user
             and on the grant not having expired, so two racing decisions
             cannot both win and a terminal state never returns to pending.
             Approving or denying a code no user has claimed MUST be refused
             (`UserCodeNotClaimed`, 409); a code claimed by another user MUST
             be indistinguishable from an unknown one (`InvalidUserCode`). An
             impersonation session (`actingAs`) MUST NOT decide
             (`DeviceApprovalRefused`, 403). When
             `DeviceAuthorizationConfig.requiredAssurance` is set, an approving
             session whose `amr` does not reach that `Assurance` level MUST be
             refused the same way; a denial is never gated on assurance. An
             approval MUST first run the `BeforeDeviceApproval` veto (a
             refusal is the typed `HookAborted`), MUST record the approving
             session's `amr` on the grant, MUST publish
             `auth.deviceAuthorization.approved` (a denial
             `auth.deviceAuthorization.denied`) and then run
             `AfterDeviceApproval`.
```

_Previous: [BEH-EA-301](37-device-authorization.md#beh-ea-301-opening-the-verification-page-claims-an-unclaimed-code-for-the-first-user-and-shows-context-only-to-them) | Next: [BEH-EA-303](37-device-authorization.md#beh-ea-303-failed-user-code-lookups-and-code-requests-spend-rate-limit-budgets)_

## BEH-EA-303: Failed user-code lookups and code requests spend rate-limit budgets

```text
REQUIREMENT: Through the `RateLimiter` port and registered in the plugin's rule
             registry ([BEH-EA-107](14-rate-limiting.md)), `POST /device/code`
             MUST be limited to 5 requests per 15 minutes per source address
             and per registered client (600 per 15 minutes by default; an
             unregistered `client_id` MUST NOT create a bucket). The
             verification, approve and deny endpoints MUST share one budget of
             5 *failed* user-code lookups per 15 minutes per source address
             and per session: a lookup MUST be refused before it is evaluated
             once the budget is spent (`RateLimited`, 429), so the correct code
             is refused too until the window passes, and only a failure MUST
             spend it. `POST /device/token` MUST limit unknown, foreign or
             spent device codes per source address, and MUST enforce its
             `interval` per device code as `slow_down`, never a `429`.
             A refusal MUST publish `auth.rateLimit.exceeded` naming the rule
             and never the key.
```

The limits are configuration (`codeRateLimit`, `userCodeRateLimit`, `invalidGrantRateLimit`); the numbers above are the defaults the model fixes. Rotating source addresses does not reset the per-session budget, and a session opening pages with different addresses does not reset the per-address one.

_Previous: [BEH-EA-302](37-device-authorization.md#beh-ea-302-approve-and-deny-are-compare-and-swap-decisions-by-the-claiming-user-only) | Next: [BEH-EA-304](37-device-authorization.md#beh-ea-304-redemption-issues-an-ordinary-bearer-session-only-after-winning-an-atomic-claim)_

## BEH-EA-304: Redemption issues an ordinary bearer session, only after winning an atomic claim

```text
REQUIREMENT: Redeeming an approved grant MUST run every fallible check before
             the claim — client and ownership, the user lookup,
             `Users.assertCanSignIn` (`UserSuspended`), the `BeforeSignIn`
             veto (`HookAborted`) and the `BeforeSessionIssue` divert — and
             only then perform an atomic conditional consume (`id`, the
             approving user and `status = approved`). The session MUST be
             minted strictly after the consume was won: of two concurrent
             polls exactly one MUST receive a session and the other
             `invalid_grant`. The session MUST be an ordinary one
             (`Sessions.issue` for the approving user, so it is revoked,
             listed and expired like any other), MUST record the polling
             device's client address and user agent, MUST carry the approving
             session's `amr`, MUST be delivered as a bearer token
             (`SessionDelivery`, `Cache-Control: no-store`, no cookie) in the
             RFC 6749 §5.1 body (`access_token`, `token_type: Bearer`,
             `expires_in`, `scope`), and MUST be announced as an ordinary
             sign-in (`auth.session.issued`, `auth.user.signedIn` with the
             strategy `deviceAuthorization`, `AfterSignIn`). A divert MUST end
             the grant as `access_denied` (a device cannot answer a challenge).
```

A `@awthaq/two-factor` gate applies exactly as to a password sign-in, with one refinement: an `amr` that already records `mfa` (which only that plugin's own completed challenge writes) is not asked for a second factor again, so a user who approves from a session that proved one can log a device in. The grant is consumed before the session is minted, so a failure of the session store after the claim (`StoreUnavailable`, 503) costs the person one retry of the whole flow, never a second session. The token is a bearer credential to the account: it authenticates `Authorization: Bearer <token>` wherever a session does, and `awthaq logout` revokes it server-side.

_Previous: [BEH-EA-303](37-device-authorization.md#beh-ea-303-failed-user-code-lookups-and-code-requests-spend-rate-limit-budgets) | Next: [BEH-EA-305](37-device-authorization.md#beh-ea-305-clients-are-public-registered-by-an-operator-and-revocable)_

## BEH-EA-305: Clients are public, registered by an operator and revocable

```ts
DeviceAuthorization.registerClient({ name, clientId?, scopes? }): Effect<DeviceClientView, ClientExists | ClientInvalid>
DeviceAuthorization.revokeClient(clientId): Effect<boolean>
DeviceAuthorization.listClients: Effect<ReadonlyArray<DeviceClientView>>
```

```text
REQUIREMENT: A client MUST be a public client (RFC 8628: the device code is
             the credential): an id, a name the approval page shows, and the
             scopes it may request. Clients MUST come from
             `DeviceAuthorizationConfig.clients` (default: the `awthaq` CLI's
             `awthaq-cli`) or from the `device_authorization_client` table
             through `registerClient`, an operator's programmatic call; no
             HTTP endpoint MUST register a client, because a client's name is
             what a person consents to. A configured id MUST NOT be
             re-registered. A revoked client MUST NOT obtain a code; grants it
             already holds run out on their own.
```

_Previous: [BEH-EA-304](37-device-authorization.md#beh-ea-304-redemption-issues-an-ordinary-bearer-session-only-after-winning-an-atomic-claim) | Next: [BEH-EA-306](37-device-authorization.md#beh-ea-306-grants-are-audited-erased-exported-and-retained-like-any-personal-data)_

## BEH-EA-306: Grants are audited, erased, exported and retained like any personal data

```text
REQUIREMENT: The plugin MUST contribute to account erasure (deleting every
             grant the user claimed or decided) and to the data-subject
             export (client, scope, status and dates of those grants, never a
             code or a hash), through `Erasure.contribute` and
             `DataExport.contribute` installed with `AuthPlugin.layer`'s
             `contributes`, so a composition without the registries does not
             compile (ADR-EA-031). Decisions MUST be audit events carrying
             the approver and the client and nothing secret
             (`auth.deviceAuthorization.approved` / `.denied`, ADR-EA-029).
             `purgeExpired` MUST delete every grant past its expiry and report
             how many; rows a poll discovers expired are already deleted on
             discovery ([BEH-EA-300](37-device-authorization.md#beh-ea-300-the-poll-answers-the-rfc-8628-states-enforces-its-interval-and-cleans-up-on-discovery)), so the call is an operator's sweep for grants nobody
             polled again.
```

The plugin owns two tables (`device_authorization_grant`, `device_authorization_client`) created by append-only, dialect-branched migrations run through the plugin ledger; `Retention.sweep` in core does not know plugin tables, so a host that wants scheduled purging calls `purgeExpired` from its own retention job, as it does `Webhooks`' delivery pruning.

_Previous: [BEH-EA-305](37-device-authorization.md#beh-ea-305-clients-are-public-registered-by-an-operator-and-revocable)_
