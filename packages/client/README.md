# @awthaq/client

Effect `HttpApiClient` bindings for the awthaq contract: the generated client,
the CSRF client middleware (self-bootstrapping), error-code derivation, a
session store, an opt-in Promise facade and the passkey ceremony helper. It is
isomorphic — browser, Node and edge runtimes — and adds no transport of its own:
every method is the one `HttpApiClient` generated from your api.

Spec: [`spec/behaviors/22-client-effect.md`](../../spec/behaviors/22-client-effect.md)
(BEH-EA-169–176). The reactive (`AtomHttpApi`) layer lives in
[`@awthaq/react`](../react/README.md), built on this package.

## The client

`make` (and `makeWith`, `group`, `endpoint`, `urlBuilder`) are `HttpApiClient`'s
own functions, re-exported — never re-declared wrappers — so the literal group and
endpoint names of *your* composed `auth.api` survive:

```ts
import { AuthClient } from "@awthaq/client";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { auth } from "./auth.ts"; // your Auth.make(...) result

const program = Effect.gen(function* () {
  const client = yield* AuthClient.make(auth.api, { baseUrl: "/api/auth" });
  return yield* client.password.signIn({ payload: { email, password } });
}).pipe(Effect.provide(AuthClient.CsrfClientLive), Effect.provide(FetchHttpClient.layer));
```

## Cookie mode and CSRF

Every mutating production group declares the `CsrfProtection` middleware, and it is
`requiredForClient`, so a cookie-mode client **does not type-check** until you
provide its client half. `CsrfClientLive` is that half: it echoes the
`__Host-csrf` cookie as `x-csrf-token` (double-submit).

It is self-bootstrapping. The server mints the cookie on *any* response through
a guarded group — including the 403 that rejects a request for lacking it — so a
cold browser's first mutation carries no cookie. `CsrfClientLive` then sends no
header (never an empty one) and, on a `CsrfRejected` whose response left a fresh
cookie behind, retries the request **once** with it. A second rejection, or one
with the same cookie as was sent, reaches your code untouched.

`csrfClientLayer({ readCookie, bootstrapRetry })` builds the same layer with a
custom cookie reader (a server-side caller reads its request's `Cookie` header —
`@awthaq/next`'s server-action client does) or the retry switched off.
`AuthClient.readCookie` is the browser reader.

The `{ csrf: false }` contract variant for bearer clients is not built yet
(`Auth.make` has no composition-level CSRF opt-out); native/bearer mode
(MNA-006) is not shipped.

## Errors as data: `ErrorCodes`

`AuthClient.ErrorCodes<typeof auth.api>` is the set of `_tag` literals your i18n
catalog must cover, derived mechanically from the contract — endpoint errors plus
their middleware's (`Unauthenticated`, `CsrfRejected`, ...) — so it cannot drift
from what a call can actually fail with.

## Promise facade

`toPromiseFacade(client)` wraps an already-built client so non-Effect code gets
Promises from the *same* generated methods (BEH-EA-176). Two modes:

```ts
import { AuthClient } from "@awthaq/client";

declare const client: Parameters<typeof AuthClient.toPromiseFacade>[0];

// default: rejects with the endpoint's tagged contract error
const rejecting = AuthClient.toPromiseFacade(client);

// { mode: "result" }: always resolves a Result<A, E>, E being the endpoint's error union
const facade = AuthClient.toPromiseFacade(client, { mode: "result" });
```

In `result` mode a non-Effect caller narrows `result.failure._tag` with
exhaustiveness checking. Defects (transport, decoding) reject in both modes.

## Session store

`SessionStore` / `SessionStoreLive` hold the current `SessionDto` for Effect
programs. `hydrate(initial)` is SSR seeding: the first non-null value wins, so a
slow client refetch can never clobber what the server rendered; `set` always
overwrites (a real sign-in, sign-out or refresh).

## Session model

The session is an opaque server-side session behind an `HttpOnly` cookie — there
is no token on the client to store, decode or refresh. Server-side rotation
replaces refresh loops (`SessionConfig.touchEvery`); reading the session is a
`GET /session`, not an SDK call (`useAtomValue(sessionAtom)` in
[`@awthaq/react`](../react/README.md) is the `onAuthStateChanged` analogue, and it
revalidates on window focus). An idle tab therefore learns about expiry or
revocation the next time it is focused or acts.

## Passkeys

`PasskeyClient.passkeyClient(client)` drives the browser WebAuthn ceremonies
(`registerPasskey`, `authenticate`, conditional UI, list/rename/delete) over a
`PasskeyApi` client slice; ceremony failures are typed
(`PasskeyClientError.PasskeyUserCancelled`, ...).

```ts
import { PasskeyClient } from "@awthaq/client";

declare const passkeyApi: Parameters<typeof PasskeyClient.passkeyClient>[0];

const passkeys = PasskeyClient.passkeyClient(passkeyApi);
const authenticate = () => passkeys.authenticate({ autoFill: true });
```
