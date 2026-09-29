# @awthaq/passkey

Passkey (WebAuthn) sign-in for awthaq: `Auth.make([Passkey.Passkey])` adds registration, sign-in, step-up re-authentication and credential management for phishing-resistant, passwordless credentials. The cryptography (CBOR/COSE, attestation, signatures) stays in [`@simplewebauthn/server`](https://simplewebauthn.dev) behind the `WebAuthn` port in `@awthaq/ports`; this package is the glue that decides _which challenge, origin, session and user_ a ceremony belongs to — where real WebAuthn CVEs actually land.

Behavior is specified in [`spec/behaviors/17-passkey.md`](../../spec/behaviors/17-passkey.md) (BEH-EA-129 to 136). The browser half is `passkeyClient` in `@awthaq/client`.

## Composition

`Passkey.Passkey.layer` needs these, all provided by the application (nothing is bundled):

| Requirement                                              | Provide with                                                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `WebAuthn` port                                          | `WebAuthn.layerSimpleWebAuthn` (`@awthaq/ports`)                                                                                |
| `ChallengeStore`                                         | `ChallengeStore.layerSql` (multi-instance), `layerMemory` (single process/tests), `layerCookie` (stateless, weaker — see below) |
| `PasskeyCredentials`                                     | `PasskeyCredentials.layerSql` or `layerMemory`                                                                                  |
| `PasskeyUserHandles`                                     | `PasskeyUserHandles.layerSql` or `layerMemory`                                                                                  |
| `RateLimiter` + `RateLimits.layer`, `ClientAddress`      | as for every plugin (`@awthaq/ports`, `@awthaq/core`)                                                                           |
| Core `Users`/`Accounts`/`Sessions`/`AuthEvents`/`Crypto` | your `Auth.make` composition                                                                                                    |

Run `Passkey.Passkey.migrations` (tables `passkey_credential`, `passkey_challenge`, `passkey_user_handle`) with your other plugin migrations. `Passkey.layer` contributes to core's `Erasure.ErasureRegistry`, so account erasure removes the user's credentials and WebAuthn handle in its transaction; there is nothing to provide separately.

```ts
const PasskeyLive = Passkey.Passkey.layer.pipe(
  Layer.provide(
    Passkey.config({
      rpId: "example.com",
      rpName: "Example",
      origins: ["https://example.com"],
    }),
  ),
  Layer.provide(WebAuthn.layerSimpleWebAuthn),
  Layer.provide(ChallengeStore.layerSql),
  Layer.provide(PasskeyCredentials.layerSql),
  Layer.provide(PasskeyUserHandles.layerSql),
);
```

The defaults (`rpId: "localhost"`, `origins: ["http://localhost:3000"]`) are development values; override every one for a real deployment.

## Configuration (`Passkey.config({...})`)

| Option                   | Default                                                       | What it does                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rpId`, `rpName`         | `localhost`, `awthaq`                                         | The relying party.                                                                                                                                                                                                                                                                                                                                                                                             |
| `origins`                | `["http://localhost:3000"]`                                   | Exact `(scheme, host, port)` origins a ceremony may come from (never a bare host). A web origin's host must be `rpId` or a subdomain. A native Android app's origin, `android:apk-key-hash:<base64url SHA-256 of the signing certificate>`, is listed verbatim and is exact-match (exempt from the web host check); publish the matching Digital Asset Links statement for `rpId` (Apple: Associated Domains). |
| `allowedTopOrigins`      | `[]`                                                          | Top-level origins a ceremony may run _embedded_ under (a cross-origin iframe). A ceremony reporting `crossOrigin: true` is refused unless its `topOrigin` is listed.                                                                                                                                                                                                                                           |
| `attestation`            | `"none"`                                                      | Attestation conveyance to request: `none`, `indirect`, `direct`, `enterprise`. **A request, not a verification** — see `attestationPolicy`.                                                                                                                                                                                                                                                                    |
| `attestationPolicy`      | none                                                          | `{ trustedAaguids, rejectSelfAttestation? }`: refuses registrations with no attestation, a self-signed one (default), or an authenticator model outside the allow-list. Without it, requesting attestation logs a warning. An allow-list, **not** FIDO MDS3 validation; certificate chains are only validated against roots you install in `@simplewebauthn/server`'s global settings.                         |
| `authenticatorSelection` | `{ residentKey: "preferred", userVerification: "preferred" }` | Passed to the browser. `userVerification: "required"` is enforced on registration and sign-in.                                                                                                                                                                                                                                                                                                                 |
| `conditionalCreate`      | `true`                                                        | Enables `register/options/conditional` (silent registration after a password sign-in). It always requests a **discoverable credential** (`residentKey: "required"`), so U2F-only and early-CTAP2 security keys cannot complete it — a fleet of those should set `false`. It is also unavailable under `userVerification: "required"`, since the browser cannot produce UV=1 for it.                            |
| `ceremonyTimeout`        | 4m30s                                                         | The `timeout` the browser is told for every ceremony. It must not exceed the server's five-minute challenge TTL (BEH-EA-132) — the layer refuses to build otherwise — so the prompt never outlives its challenge.                                                                                                                                                                                              |
| `hints`, `extensions`    | none                                                          | WebAuthn L3 `hints` (`security-key`, `client-device`, `hybrid`) and client extension inputs added to every options response.                                                                                                                                                                                                                                                                                   |
| `counterAnomalyPolicy`   | `"flag"`                                                      | What a signature-counter regression (a possibly cloned key) does. `"flag"`: audit it, flag the credential, still sign in, and require user verification on that credential from then on. `"reject"`: additionally fail with `PasskeyCounterAnomaly`.                                                                                                                                                           |
| `enumerationSecret`      | random per process                                            | Keys the decoy `allowCredentials` an unknown email receives. Set one shared value when running several instances, or decoys differ between them.                                                                                                                                                                                                                                                               |
| `reauthMaxAgeSeconds`    | 5 minutes                                                     | Enrolling a passkey requires a session authenticated this recently; older sessions get `PasskeyReauthRequired` and must step up first (`passkey.reauthenticate`).                                                                                                                                                                                                                                              |

## Challenge stores

`ChallengeStore.guarantees` states what each backend really promises:

- `layerMemory` and `layerSql`: single-use (a challenge is deleted on every verification attempt, matching or not) and replace-on-issue. `layerSql` claims atomically. Expired, never-consumed challenges are reclaimed on every issue, and `sweepExpired` reclaims them on demand.
- `layerCookie`: **stateless**, HMAC-signed, no server storage — it cannot mark a value used, so a captured challenge stays replayable until its TTL. `Passkey.layer` logs a warning when it is in use. Prefer `layerSql`.

## Endpoints

`passkey` (authenticated): `POST /passkey/register/options`, `.../options/conditional`, `.../verify`. `passkey.authenticate` (anonymous, rate-limited, CSRF-protected): `POST /passkey/authenticate/options`, `.../verify`. `passkey.credentials` (authenticated): `GET /passkey/credentials`, `PATCH`/`DELETE /passkey/credentials/:id`, `GET /passkey/signals`. `passkey.reauthenticate` (authenticated): `POST /passkey/reauthenticate/options`, `.../verify` (UV always required; refreshes the session's authentication time).

Notable behavior:

- **Sign-in is enumeration-safe.** Every failure after the challenge check answers the same `InvalidCredentials`, an unknown email gets deterministic decoy `allowCredentials`, and an unknown credential id costs the same signature verification as a bad signature.
- **One stable WebAuthn user handle per user**, sent as `user.id` in every registration ceremony and checked against the `userHandle` a discoverable credential returns.
- **Registration requires user presence** except for Conditional Create; a registration whose credential id is already registered fails `PasskeyAlreadyRegistered`.
- **Signals.** `GET /passkey/signals` feeds the browser's WebAuthn Signals API (see the client below) so a deleted passkey stops being offered.

## Native clients

`POST /passkey/authenticate/verify` honours `X-Awthaq-Token-Delivery: bearer`: the session token comes back in the response body's `token` field and no cookie is set (the session is delivered through `@awthaq/server`'s shared `SessionDelivery`, like every other sign-in). Storage (Keychain/Keystore) is the app's responsibility. Any other header value answers `400 InvalidTokenDelivery` before the ceremony is consumed.

## Client

`passkeyClient` in `@awthaq/client` wraps `@simplewebauthn/browser`: feature detection (`getClientCapabilities`), `registerPasskey`, `registerPasskeyConditional`, `authenticate` (button flow, or conditional-UI autofill with `autoFill: true` — give the username input `autocomplete="username webauthn"`), `reauthenticate`, credential management, and fire-and-forget Signals (`allAcceptedCredentials` after a delete and after every sign-in; `signalCurrentUserDetails()` for a profile change; `unknownCredential` only from the signed-in `reauthenticate`).

## Recovery

There is no self-service recovery when a passkey is the only way into an account. The plugin refuses to strand an account — removing a user's last remaining credential fails `PasskeyLastCredential` (the core `Accounts` last-credential guard, BEH-EA-134, which also counts passwords and linked OAuth accounts) — but a lost device with no other credential is a support case. Pair passkeys with a second credential type (a password, email verification or a magic link) and let users add it before they rely on a passkey alone.

## Limits

- No passkey-first sign-up: a passkey is added to an existing account by a freshly authenticated session.
- No FIDO MDS3 attestation validation (deferred, BEH-EA-135); `attestationPolicy` is an AAGUID allow-list.
- The session issued by a passkey sign-in does not yet record the client address or user agent, and carries no authentication-method (`amr`) assurance signal; both are tracked with the shared session work.
- Credentials registered before the stable user handle shipped stored a random handle no authenticator holds, so their discoverable assertions fail the `userHandle` check; those users re-register.
