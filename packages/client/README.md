# @awthaq/client

Isomorphic Effect client derived from the merged contract.

**Shipped**: `AuthClient` (BEH-EA-169–176: `make`/`makeWith`/`group`/`endpoint`/`urlBuilder` are `HttpApiClient`'s own functions, plus the session store and a Promise facade) and `PasskeyClient` (the browser-side WebAuthn ceremony helper over `@simplewebauthn/browser`, layered on an already-built `PasskeyApi` client).

The reactive `AtomHttpApi` binding lives in [`@awthaq/react`](../react). A reauth demand is decodable with `Api.isReauthRequired` from `@awthaq/api`.

See [`spec/behaviors/22-client-effect.md`](../../spec/behaviors/22-client-effect.md).
