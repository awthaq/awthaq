# @awthaq/webhooks

Opt-in **signed outbound webhooks** over the event relay: an administrator registers HTTPS endpoints, and every matching auth event is queued per endpoint and POSTed with [Standard Webhooks](https://www.standardwebhooks.com/)-style headers (the scheme Clerk's svix libraries verify), with retry, backoff, a dead-letter state and a delivery log. Specified in [`spec/behaviors/31-webhooks.md`](../../spec/behaviors/31-webhooks.md) (BEH-EA-255 through 262); the design is [ADR-EA-030](../../spec/decisions/030-event-delivery-outbox-relay.md) Decision 7. It is a consumer of `EventRelay` (`@awthaq/core`): the in-process bus is unchanged and no network call sits on any operation's path.

```ts
const auth = Auth.make([Webhooks.Webhooks]); // the admin API: group `webhooks.admin` (admin tier)

// Provide once: the plugin's config (the admin gate!), records, and the ports it requires.
Webhooks.Webhooks.layer.pipe(
  Layer.provide(
    Webhooks.config({ canManageWebhooks: ({ admin }) => isPlatformOwner(admin) }), // denies by default
  ),
  Layer.provideMerge(WebhookRecords.layerSql), // or layerMemory
  /* + Encryption, RateLimiter, HostResolver.layerNode, AuthEvents, Crypto, the admin-tier authentication */
);

// The delivery machinery: the relay that tails the audit log + the worker that sends. One per deployment.
Webhooks.Webhooks.background().pipe(
  Layer.provide(EventRelay.layerCursorSql), // the relay's durable position (core migration 27)
  Layer.provide(FetchHttpClient.layer), // or NodeHttpClient
  /* + AuditLog, WebhookRecords, Encryption, RateLimiter, HostResolver, Crypto */
);
```

Run the plugin's migrations with the rest (`Auth.make(...).migrations`): `webhooks_endpoint` and `webhooks_delivery`.

## What a receiver gets

`POST <your url>` with `content-type: application/json` and:

| Header | Value |
| --- | --- |
| `webhook-id` | the event id: stable across every retry, your idempotency key |
| `webhook-timestamp` | Unix seconds of *this attempt* (each retry is re-stamped) |
| `webhook-signature` | `v1,<base64 HMAC-SHA256>` of `<id>.<timestamp>.<body>` under the endpoint's secret; two space-separated values while a rotation's grace window is open |

The body is `{ version: 1, type, id, timestamp, correlationId?, traceId?, data, client? }`, `data` being the event's own fields. **Identifiers only**: free text about a person is never sent, the client address and user agent only if `includeClientContext` is set, and any field named like a credential or contact detail is always dropped.

Verify with any Standard Webhooks library, or with this one (`WebhookSignature.verify`: replay window both directions, default 5 minutes; constant-time comparison; accepts several secrets during a rotation).

Delivery is **at-least-once**: deduplicate on `webhook-id`. A 2xx is success; any other status, a timeout (`requestTimeout`, 10 s) or a transport failure is retried after `retryBase * retryFactor^(n-1)` (10 s, 30 s, 90 s, ... capped at 6 h) until `maxAttempts` (8), then the delivery is `dead` and kept in the log. Ten dead-lettered deliveries in a row switch the endpoint off. Redirects are not followed and response bodies are never read or stored.

## Administration

Behind `Api.AdminAuthentication` and CSRF, gated by `canManageWebhooks({ admin, action })` (**denies by default**; the action lets you let an auditor read the log while only an owner registers receivers), rate limited per administrator.

| Endpoint | Behavior |
| --- | --- |
| `POST /admin/webhooks/endpoints` | Registers `{ url, description?, eventTags }` (`eventTags` required: exact tags, `family.*`, or `["*"]`). The response carries the `whsec_` secret **once**. `422 InvalidWebhookEndpoint` names the rule that failed. |
| `GET /admin/webhooks/endpoints[/:id]` | List / read. Never a secret. |
| `PATCH /admin/webhooks/endpoints/:id` | URL, description, filter, `enabled` (switch off/on; pending deliveries wait). |
| `DELETE /admin/webhooks/endpoints/:id` | Removes the endpoint and its log. |
| `POST /admin/webhooks/endpoints/:id/rotate-secret` | New secret now (shown once); the previous one keeps signing for `secretGrace` (24 h). |
| `GET /admin/webhooks/endpoints/:id/deliveries` | The log, newest first (`status`, `before`, `limit`): outcomes only (status code or error class), never a payload or a response. |
| `POST /admin/webhooks/deliveries/:id/retry` | Sends a dead delivery again. |

## The safety rules

- **The secret is stored sealed** (`Encryption`, AAD names endpoint and field) and shown once. A delivery whose secret does not decrypt fails as `secret` and is not sent.
- **URLs are an SSRF surface.** https only, no credentials, no private/loopback/link-local/reserved address or internal name, and the name must **resolve** to public addresses only (`HostResolver`), checked when registered and before every attempt. `Webhooks.config({ allowPrivateTargets: true })` (development only) allows `http://localhost`. This narrows DNS rebinding but cannot close it (the HTTP client resolves again): keep egress filtering at the network layer.
- **The queue is separate from the stream.** The relay's transport only enqueues (unique per endpoint and event, so a redelivered batch adds nothing); the worker sends. One dead receiver never holds back another, and a worker that dies leaves its lease to lapse and the row is sent again.
- **Privacy.** Account erasure deletes the delivery rows about the erased user; the data export lists them (outcomes only); finished rows are pruned after `deliveryRetention` (30 days). The `auth.user.deleted` event itself is delivered after erasure and is your consumers' cue to erase their copies.
- **Rate limits.** An endpoint's outbound budget (`deliveryRate`, 300 a minute) makes deliveries wait rather than fail; each administrator has `adminRate` (60 a minute).

## Configuration

`Webhooks.config({...})`: `canManageWebhooks`, `maxEndpoints` (20), `maxAttempts` (8), `retryBase`/`retryFactor`/`retryMax`, `requestTimeout`, `batchSize`/`concurrency`/`pollInterval`/`lease`, `secretGrace`, `disableAfterConsecutiveDead` (10; `0` never), `deliveryRetention`, `includeClientContext` (off), `allowPrivateTargets` (off), `deliveryRate`, `adminRate`, `userAgent`. The administrative operations read the configuration in force per call (a tenant's `Webhooks.config` provided in the calling fiber applies); the background worker is deployment-wide and reads the build-time value.

## Not built

Per-tenant endpoints: audit rows carry no tenant id, so an endpoint is platform-wide. A test-ping endpoint, per-endpoint custom headers, payload transforms and a replay-from-event-id API (use `AuditLog.replay`). Successful administrative mutations are logged, not published as audit events (a denial publishes `auth.admin.actionDenied`). Pinning the connection to the checked address (needs client support), so DNS rebinding is narrowed but not closed.
