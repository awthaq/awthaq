# API Keys
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-MOD-07 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | effect-auth Engineering |
> | Classification | Planning |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) |
---

## What it is

A credential type for server-to-server and CI callers rather than interactive
users: a caller creates a named, scoped, long-lived key; the raw key is shown
once and only its hash is stored; presenting it on a request resolves to an
`ApiKey` principal rather than a `User` principal. It is effect-auth's answer
to "how does a non-human caller authenticate," and its scopes are what qadi
turns into permissions on the other side of the authorization boundary.
Nothing described here exists yet — effect-auth is pre-implementation.

## Who asks for it

`research/07-passwords-2fa.md` Q59 surveys four production implementations
(Stripe, WorkOS AuthKit, Clerk, better-auth's `apiKey` plugin) that converge on
the same shape — hash-at-rest, show-once, scoped, an explicit principal kind
rather than a mocked user session — which is strong evidence this is asked
for by essentially any application that exposes an API to scripts, CI
pipelines, or other services rather than only to browsers.

## Status

| Property | Value |
|---|---|
| Status | Planned-Phase2 |
| Priority | P1 |
| Enabler(s) | E3 — Principal-type extension |
| Breaking? | Additive to the principal shape, not breaking it — `archive/PRD.md` §10 defines `SessionView { principal, user, session, subject }` with `principal` already open to more than one tag; adding an `ApiKeyPrincipal` case is a new variant on an existing union, not a change to `User`'s shape or to the MVP contract. |

## How it would be expressed

Following `archive/PRD.md` §9.1's `AuthPlugin.Service` shape:

```ts
export class ApiKey extends AuthPlugin.Service<ApiKey, ApiKeyShape>()("apiKey", {
  apiVersion: 1,
  contract: ApiKeyApi,
  tables: ["api_key"],
  migrations
}) {
  static readonly layer = AuthPlugin.layer(ApiKey, {
    dependsOn: [Users],
    make: Effect.gen(function*() {
      const config = yield* ApiKeyConfig       // prefix, default expiry
      /* create(name, scopes, expiresIn) -> { key: Redacted<string> } shown once, hash stored
         resolve(presented) -> ApiKeyPrincipal { keyId, scopes } for the strategy chain */
      return ApiKey.of({ create, list, revoke, resolve })
    }),
    handlers: ApiKeyHandlers
  })
  static readonly config = (c: Partial<ApiKeyConfigShape>) => Layer.succeed(ApiKeyConfig, { ...defaults, ...c })
}
```

An `ApiKeyPrincipal` participates in the same `Authentication` middleware
strategy chain `archive/PRD.md` §10 describes for cookie and bearer schemes —
it would be a third scheme tried in declaration order, not a parallel
authentication system.

## Worked example

Adapted from `archive/design/usage-examples-v4.md` §20 ("API keys and service
principals"), fence already `ts` in the source:

```ts
const plugins = [password(), apiKey({ prefix: "ak_" })] as const

const { key } = yield* client.apiKey.create({ payload: { name: "ci", scopes: ["project:read"], expiresIn: "90 days" } })
// key: Redacted<"ak_…"> shown once; only its hash is stored

// server-to-server call
curl -H "x-api-key: ak_…" https://app.example.com/machine/projects
// CurrentPrincipal → ApiKeyPrincipal { keyId, scopes: ["project:read"] } ; SubjectResolver maps scopes to qadi permissions
```

The qadi side of this interaction — described for reference shape only, not
copied as authoritative content — is documented in `archive/design/usage-qadi.md`,
which shows an `ApiKey` principal resolving to a subject with
`id: "apikey:<keyId>"` and `permissions` equal to the key's scopes, alongside
an equivalent `Service` principal kind (`id: "service:<name>"`) for
non-key-based service-to-service callers. On the effect-auth side, this means
the `ApiKey` plugin's job stops at producing a scoped principal; turning
scopes into qadi permissions is the `SubjectResolver` slot's job, not this
plugin's.

## What is missing

Everything: no contract, no `ApiKeyPrincipal` case in a `CurrentPrincipal`
union that does not yet exist, no hashing/storage implementation, no
`SubjectResolver` wiring, no test. Undecided questions carried over from
`research/07-passwords-2fa.md` Q59 include: key format (`{prefix}_{secret}`
with 32 CSPRNG bytes is recommended, not adopted), whether to store a
human-readable `start` prefix for list UX, rotation-with-grace-window
behavior, and whether the transport is `x-api-key`, `Authorization: Bearer`,
or both. None of this has been decided beyond the row in `archive/PRD.md` §17.

## Verification

None yet — no test exists.

_Related: [00 — Adoption Matrix](00-adoption-matrix.md)_
