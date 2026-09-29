# @awthaq/client

> **This describes a planned package.** awthaq is pre-implementation (see [`../../spec/README.md`](../../spec/README.md)); no line of source in this package has shipped yet. This README states intent, not shipped behavior.

Client. AtomHttpApi client and session atom — the isomorphic Effect client derived from the merged contract.

**Planned first module:** AuthClient.ts (spec/behaviors/22-client-effect.md, BEH-EA-169–176)

See [`spec/overview.md`](../../spec/overview.md) for the full package map this fits into.

## Bearer (native, CLI, server-to-server) clients

The session token rotates on the server's throttled touch (there is no grace window), so a bearer client must capture the rotated token from every response:

```ts
const program = Effect.gen(function* () {
  const store = yield* AuthClient.BearerTokenStore; // AuthClient.BearerTokenStoreMemory, or your own (Keychain/Keystore)
  yield* store.set(Redacted.make(tokenFromSignIn));
  return yield* AuthClient.make(api, {
    baseUrl,
    transformClient: AuthClient.bearerTransformClient(store),
  });
});
```

`bearerTransformClient` attaches `Authorization: Bearer <token>` and stores the `set-auth-token` header (`Api.ROTATED_TOKEN_HEADER`) whenever a response carries it. On the typed `Unauthenticated` error, re-authenticate and `store.set` a fresh token. Keep `set-auth-token` intact through proxies, expose it via CORS if cross-origin, and never log it.
