# @awthaq/device-authorization

The OAuth 2.0 **Device Authorization Grant** ([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628)) for awthaq: an input-constrained client (the `awthaq` CLI, a TV, a set-top box) shows the person a short code, the person approves it on a second, signed-in device, and the client's poll receives an ordinary **bearer session**. It is the login backend of `awthaq login` ([BEH-EA-307](../../spec/behaviors/26-cli.md)). Mounted under the shared `"auth"` id: groups `device_authorization`, `device_authorization.verification` and `device_authorization.decision`.

See [`spec/models/13-device-authorization.md`](../../spec/models/13-device-authorization.md) (the security parameters and the polling state machine this implements) and [`spec/behaviors/37-device-authorization.md`](../../spec/behaviors/37-device-authorization.md) (BEH-EA-299 to BEH-EA-306).

## Composition

`DeviceAuthorization` has no plugin dependency: it uses core's `Users`, `Sessions`, `AuthEvents`, the hook points and the erasure and export registries, and the ports `RateLimiter` and `ClientAddress`. It requires `DeviceGrantRecords` and `DeviceClientRecords` (`layerMemory`, or `layerSql` migrated with `DeviceAuthorization.migrations`), `RateLimits`, `Crypto`, and the plugin's own hook points. The application provides them.

```ts
import { Auth } from "@awthaq/core";
import { DeviceAuthorization, DeviceClientRecords, DeviceGrantRecords } from "@awthaq/device-authorization";

const auth = Auth.make([DeviceAuthorization.DeviceAuthorization]);

const layers = Layer.mergeAll(
  DeviceGrantRecords.layerSql,
  DeviceClientRecords.layerSql,
  DeviceAuthorization.DeviceAuthorizationHooksLive,
  DeviceAuthorization.config({
    // The page YOUR application serves for the person to type the code into.
    verificationUri: "https://app.example.com/device",
  }),
);
```

The awthaq CLI works with the default configuration: `awthaq-cli` is a registered client out of the box, so installing the plugin is what turns `awthaq login` on.

## The flow

```text
device                              server                               person (second device)
  |  POST /device/code client_id=… -> |                                        |
  |  <- device_code, user_code, ...   |                                        |
  |  shows  "BCDF-GHJK"  and the URL  |                                        |
  |                                   |   POST /device/verify {user_code}  <-  | signed in: claims the code, sees
  |                                   |   POST /device/approve {user_code} <-  | which client asks for what
  |  POST /device/token (poll) ->     |                                        |
  |  <- authorization_pending | slow_down | access_denied | expired_token
  |  <- 200 { access_token, token_type: "Bearer", expires_in, scope }
```

- **`POST /device/code`** — form-encoded, anonymous, no CSRF (a device is not a browser). The user code is 8 symbols of `BCDFGHJKLMNPQRSTVWXZ` (about 34.6 bits, shown `XXXX-XXXX`); the device code is 32 CSPRNG bytes. Both are stored only as SHA-256 hashes.
- **`POST /device/verify`, `/approve`, `/deny`** — JSON, with the person's session cookie or bearer token and the CSRF token. Opening the page claims an unclaimed code for that user (a compare-and-swap); only the claiming user sees the client and scope, anyone else sees `{ user_code, status }`. Approving a code nobody claimed is refused. An impersonation session cannot decide. Build your page on these three calls.
- **`POST /device/token`** — the poll. Answers are RFC 6749 §5.2 bodies (`{"error": "authorization_pending"}`, status 400). A poll before the interval is `slow_down` (the server-side interval rises by 5 seconds); an expired or denied grant is deleted the first time a poll sees it. **A client must add 5 seconds to its interval on every `slow_down`**; `awthaq login` does.
- **The session** is an ordinary one: revoked, listed and expired like every other, recording the device's address and user agent and the approving session's `amr`. It is delivered as a bearer token (`Cache-Control: no-store`, no cookie). It goes through `BeforeSignIn` and `BeforeSessionIssue`, so a second factor or a policy hook applies as to a password sign-in; an approving session that already proved a second factor (`amr` `mfa`) is not asked again, and a diverted grant ends as `access_denied`.
- **Scope** is advisory: the approval page shows it and the grant records it, but the minted session is the user's own session with the user's own authority. Ask for a scope-limited credential from `@awthaq/api-key` instead if you need one.

## Clients

A client is public (RFC 8628: the device code is the credential): an id, a name the approval page shows, and the scopes it may request. Register them in configuration or at runtime, as an operator:

```ts
DeviceAuthorization.config({
  clients: [{ clientId: "living-room-tv", name: "Living-room TV", scopes: ["playback"] }],
});
// or, from a seed script:
yield* plugin.registerClient({ name: "Set-top box", scopes: ["playback"] });
yield* plugin.revokeClient(clientId);
```

There is deliberately no HTTP endpoint that registers a client: its name is what a person consents to on the approval page.

## Configuration (`DeviceAuthorization.config({...})`)

| Option                  | Default                                    |                                                                                         |
| ----------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------- |
| `expiresIn`             | 15 minutes                                 | `expires_in`                                                                            |
| `interval`              | 5 seconds                                  | the starting poll interval                                                              |
| `verificationUri`       | unset: `<request origin>/device`           | set it in production (`awthaq doctor` warns): the unset default trusts `Host` headers   |
| `clients`               | `[{ clientId: "awthaq-cli", ... }]`        | beside any registered at runtime                                                        |
| `requiredAssurance`     | unset                                      | the weakest `Assurance` an approving session may have (`aal2` demands a second factor)  |
| `codeRateLimit`         | 5 / 15 min per address, 600 per client     | `POST /device/code`                                                                     |
| `userCodeRateLimit`     | 5 failed lookups / 15 min per address and per session | verify, approve and deny share the budget                                   |
| `invalidGrantRateLimit` | 50 / 15 min per address                    | unknown, foreign or spent device codes                                                  |

## Hooks, events and personal data

- `BeforeDeviceApproval` (veto) and `AfterDeviceApproval` (observe) surround an approval; provide `DeviceAuthorizationHooksLive` once.
- `auth.deviceAuthorization.approved` / `.denied` are audit events (approver and client, nothing secret); the redeemed session announces itself as an ordinary sign-in with the strategy `deviceAuthorization`.
- The plugin contributes to account erasure and to the data-subject export. `purgeExpired` deletes grants past their expiry; call it from your retention job (rows a poll finds expired are already deleted on discovery).

## Limits

- The grant is consumed before the session is minted, so a session-store outage in that instant costs the person one retry of the whole flow, never a second session.
- The user-code hash is SHA-256: it stops a database read or a backup yielding a usable code, it does not withstand offline guessing of a 34.6-bit space. That is why the code lives 15 minutes and every failed lookup spends a budget.
