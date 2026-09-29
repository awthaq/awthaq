# @awthaq/webhooks

Opt-in **signed outbound webhooks** over the event relay: an administrator registers HTTPS endpoints, and every matching auth event is queued per endpoint and POSTed with [Standard Webhooks](https://www.standardwebhooks.com/)-style headers (the scheme Clerk's svix libraries verify), with retry, backoff, a dead-letter state and a delivery log. Specified in [`spec/behaviors/34-webhooks.md`](../../spec/behaviors/34-webhooks.md) (BEH-EA-275 through 282, 299 through 304); the design is [ADR-EA-030](../../spec/decisions/030-event-delivery-outbox-relay.md) Decision 7. It is a consumer of `EventRelay` (`@awthaq/core`): the in-process bus is unchanged and no network call sits on any operation's path.

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
  Layer.provide(WebhookTransport.layerNodePinned), // connects to the address the host was pinned to (below)
  /* + AuditLog, WebhookRecords, Encryption, RateLimiter, HostResolver, Crypto */
);
```

Run the plugin's migrations with the rest (`Auth.make(...).migrations`): `webhooks_endpoint` and `webhooks_delivery`. `WebhookTransport.layerHttpClient` wraps any `HttpClient` for runtimes without `node:https`; it cannot pin the connection, so DNS rebinding is then narrowed, not closed.

## What a receiver gets

`POST <your url>` with `content-type: application/json` and:

| Header | Value |
| --- | --- |
| `webhook-id` | the event id: stable across every retry, your idempotency key |
| `webhook-timestamp` | Unix seconds of *this attempt* (each retry is re-stamped) |
| `webhook-signature` | `v1,<base64 HMAC-SHA256>` of `<id>.<timestamp>.<body>` under the endpoint's secret; two space-separated values while a rotation's grace window is open |

The body is `{ version: 1, type, id, timestamp, correlationId?, traceId?, tenantId?, data, client? }`, `data` being the event's own fields and `tenantId` the tenant (organization id) the event happened in. **Identifiers only**: free text about a person is never sent, the client address and user agent only if `includeClientContext` is set, and any field named like a credential or contact detail is always dropped.

Verify with any Standard Webhooks library, or with this one (`WebhookSignature.verify`: replay window both directions, default 5 minutes; constant-time comparison; accepts several secrets during a rotation).

Delivery is **at-least-once**: deduplicate on `webhook-id`. A 2xx is success; any other status, a timeout (`requestTimeout`, 10 s) or a transport failure is retried after `retryBase * retryFactor^(n-1)` (10 s, 30 s, 90 s, ... capped at 6 h) until `maxAttempts` (8), then the delivery is `dead` and kept in the log. Ten dead-lettered deliveries in a row switch the endpoint off. Redirects are not followed and response bodies are never read or stored.

## Administration

Behind `Api.AdminAuthentication` and CSRF, gated by `canManageWebhooks({ admin, action })` (**denies by default**; the action lets you let an auditor read the log while only an owner registers receivers), rate limited per administrator.

| Endpoint | Behavior |
| --- | --- |
| `POST /admin/webhooks/endpoints` | Registers `{ url, description?, eventTags, headers? }` (`eventTags` required: exact tags, `family.*`, or `["*"]`). The response carries the `whsec_` secret **once**. `422 InvalidWebhookEndpoint` names the rule that failed. |
| `GET /admin/webhooks/endpoints[/:id]` | List / read. Never a secret. |
| `PATCH /admin/webhooks/endpoints/:id` | URL, description, filter, `headers` (replaces the set; `null` clears), `enabled` (switch off/on; pending deliveries wait). |
| `DELETE /admin/webhooks/endpoints/:id` | Removes the endpoint and its log. |
| `POST /admin/webhooks/endpoints/:id/rotate-secret` | New secret now (shown once); the previous one keeps signing for `secretGrace` (24 h). |
| `GET /admin/webhooks/endpoints/:id/deliveries` | The log, newest first (`status`, `before`, `limit`): outcomes only (status code or error class), never a payload or a response. |
| `POST /admin/webhooks/deliveries/:id/retry` | Sends a dead delivery again. |
| `POST /admin/webhooks/endpoints/:id/test` | Queues a signed synthetic `webhook.test` event for the endpoint (see below). |

### Per tenant

Endpoints belong to a tenant (BEH-EA-300, [ADR-EA-018](../../spec/decisions/018-tenancy-is-an-organization.md)): an endpoint is stamped, when it is registered, with the ambient `TenantContext` (`Organization.tenantMiddleware` provides it per request; `Tenant.withTenant(id)` per unit of work), and hears **only that tenant's events**. The event envelope carries the tenant (`Published.tenantId`, the value the audit row's `"tenantId"` column stores), so the routing needs no second lookup. Administration is scoped the same way: a tenant administrator lists, reads, edits, tests, rotates and deletes only their own endpoints, `maxEndpoints` is a per-tenant budget, and another tenant's endpoint or delivery is answered exactly like an id that does not exist. The platform's own endpoints (registered outside any tenant scope) hear the events that belong to no tenant, and every tenant's only with `platformEndpointsHearAllTenants: true` (an operator's SIEM feed is a deliberate choice, never a default); a platform administrator who needs to administer a tenant's endpoints acts inside that tenant's scope. A single-tenant deployment never sees any of this: every tenant is `None` and everything matches.

### The test ping

`POST .../test` (action `testEndpoint` for the gate) queues one `webhook.test` delivery `{ version, type: "webhook.test", id, timestamp, tenantId?, data: { endpointId } }` and returns its (pending) log row: the request itself makes no network call. The worker sends it exactly like any other delivery (signed under the current secret, URL re-checked and pinned, rate limited, logged), once: a failure is `dead` at once and does not count toward `disableAfterConsecutiveDead`. Read the outcome from `GET .../deliveries`. A disabled endpoint is refused (`422`).

### Audit

Each successful mutation publishes one audit event (BEH-EA-302): `auth.webhooks.endpointCreated`, `endpointUpdated` (with the *names* of the fields changed), `secretRotated`, `endpointDeleted` and `testQueued`, naming the administrator and the endpoint and nothing typed by the administrator (no URL, description, filter or secret). A refused or failed call publishes none (a denial publishes `auth.admin.actionDenied`). A tenant can subscribe its own endpoint to `auth.webhooks.*`.

### Custom headers

`headers` on creation and update adds request headers to every delivery (an `Authorization` token, an API key) beneath the delivery's own (BEH-EA-304). The values are credentials: sealed with `Encryption` (AAD naming endpoint and field), never returned (`EndpointDto.headerNames` lists the names), and bounded: at most 10, a name of `a-z0-9-`, a value of 1 to 1024 printable ASCII characters (no line breaks), and nothing the delivery sets itself or that changes the request (`host`, `content-*`, `user-agent`, `connection`, `transfer-encoding`, `upgrade`, `cookie`, `webhook-*`, `proxy-*`, `sec-*`, ...).

## The safety rules

- **The secret is stored sealed** (`Encryption`, AAD names endpoint and field) and shown once. A delivery whose secret does not decrypt fails as `secret` and is not sent.
- **URLs are an SSRF surface.** https only, no credentials, no private/loopback/link-local/reserved address or internal name, and the name must **resolve** to public addresses only (`HostResolver`), checked when registered and before every attempt. `Webhooks.config({ allowPrivateTargets: true })` (development only) allows `http://localhost`.
- **The connection is pinned to the address that was checked** (BEH-EA-303). Each attempt resolves the host once (`HostResolver.pin`), refuses unless every answer is public, and `WebhookTransport.layerNodePinned` connects to the first answer as an IP literal with the URL's own name as `Host` and as the TLS server name (the certificate is verified against the registered name), judging the address once more before it connects. Nothing is resolved between the check and the connect, so there is nothing to rebind; the name is re-resolved on every attempt. Keep egress filtering at the network layer as a second line.
- **The queue is separate from the stream.** The relay's transport only enqueues (unique per endpoint and event, so a redelivered batch adds nothing); the worker sends. One dead receiver never holds back another, and a worker that dies leaves its lease to lapse and the row is sent again.
- **Privacy.** Account erasure deletes the delivery rows about the erased user; the data export lists them (outcomes only); finished rows are pruned after `deliveryRetention` (30 days). The `auth.user.deleted` event itself is delivered after erasure and is your consumers' cue to erase their copies.
- **Rate limits.** An endpoint's outbound budget (`deliveryRate`, 300 a minute) makes deliveries wait rather than fail; each administrator has `adminRate` (60 a minute).

## Configuration

`Webhooks.config({...})`: `canManageWebhooks`, `maxEndpoints` (20, per tenant), `maxAttempts` (8), `retryBase`/`retryFactor`/`retryMax`, `requestTimeout`, `batchSize`/`concurrency`/`pollInterval`/`lease`, `secretGrace`, `disableAfterConsecutiveDead` (10; `0` never), `deliveryRetention`, `includeClientContext` (off), `allowPrivateTargets` (off), `platformEndpointsHearAllTenants` (off), `deliveryRate`, `adminRate`, `userAgent`. The administrative operations read the configuration in force per call (a tenant's `Webhooks.config` provided in the calling fiber applies); the background worker is deployment-wide and reads the build-time value.

## Not built

Payload transforms (an endpoint receives the versioned document as documented; a consumer that wants another shape maps it on receipt) and a replay-from-event-id API: replay an event with `AuditLog.replay({ after })` from your own code and, for a delivery that exists, `POST /admin/webhooks/deliveries/:id/retry`.
