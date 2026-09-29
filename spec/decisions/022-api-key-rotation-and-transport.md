# ADR-EA-022: API Keys and Client Secrets Rotate With a Bounded Dual-Validity Window; Keys Travel in `x-api-key`, `Authorization: Bearer` Is Reserved for JWTs

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-022 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-29 |
> | Status | Accepted — implemented |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-29): Initial release (OCM-005, OCM-002, MAPS-003, MAPS-004) |

---

## Context

`@awthaq/api-key` ships two machine credentials (wayfinder ticket 10): a long-lived API key, and a `client_credentials` client secret that mints short-lived service JWTs. Ticket 10 fixed their format, hash-at-rest and token endpoint but left two operational questions open (`spec/models/07-api-keys.md`): how a credential is replaced without an outage, and which HTTP header carries it. Both have a wrong answer that only shows up in production: a hard cut-over makes every rotation a coordinated deploy, and two overlapping transports make the authentication chain ambiguous (a string that could be a key or a JWT gets probed against both).

## Decision

1. **Rotation is dual-validity for a bounded, configurable window.** `rotate(keyId, { gracePeriod? })` mints a successor (same name and scopes, `rotatedFrom` naming the predecessor) and sets the predecessor's `expiresAt` to `now + gracePeriod`, never later than its existing expiry. Both keys resolve until the window ends, then only the successor does. `ApiKeyConfig.rotationGrace` defaults to 24 hours and `maxRotationGrace` (default 30 days, mirroring `JwtConfig.keyGracePeriod`) bounds what a caller may ask for; a longer request is refused `ApiKeyLifetimeInvalid`. `revoke` stays immediate and independent of rotation. A rotation publishes `auth.apiKey.rotated`.
2. **A client keeps at most two valid secrets.** `rotateClientSecret(clientId, { gracePeriod? })` makes the current hash the previous one, valid until `now + gracePeriod`, and installs the new hash; rotating again while the previous secret is still in its window retires that older one. Both stored hashes are compared on every token request, found or not, so a wrong secret, a rotated-out secret and an unknown client are indistinguishable.
3. **API keys travel in the `x-api-key` request header only.** `Authorization: Bearer` is reserved for JWTs (session-less principal tokens from `@awthaq/jwt`, and the service tokens `client_credentials` mints), so the two strategies never double-try one credential. `client_credentials` accepts `client_secret_post` and `client_secret_basic` (RFC 6749 §2.3.1).
4. **Machine credentials are resolved through a registry, and reach only groups that declare the machine tier.** Plugins add a credential type to `@awthaq/server`'s credential-resolver registry (ADR-EA-012: an aggregating registry, not a slot) instead of a scheme per credential type: keys claim the `apiKey` carrier by prefix, service tokens claim the `bearer` carrier by JOSE `typ` (`service+jwt`, distinct from `@awthaq/jwt`'s `at+jwt`). `Api.Authentication` stays the *user* tier — it admits a claimed credential only when it resolves to a `User` — and a separate `Api.MachineAuthentication` (the same chain plus the `x-api-key` scheme) is what a group meant for CI, scripts or services declares. An API key or service token therefore never reaches the many handlers that assume a session.
5. **The header name is fixed** (`x-api-key`, an `HttpApiSecurity` scheme in the contract), not per-deployment configurable: the contract is static and generated clients and OpenAPI documents must agree with the server.

## Alternatives considered

**No grace window: rotation is revoke-and-create.** Rejected: it makes every rotation an outage window unless client and server deploy in lock-step, which is the reason operators avoid rotating at all.

**Accept both `x-api-key` and prefix-sniffed `Authorization: Bearer`.** Rejected: the second transport buys little (every client that can set one header can set the other) and puts key material on a header that proxies, gateways and APM tools already treat as a JWT.

**A third scheme on `Api.Authentication` itself.** Rejected: it edits the contract for every new credential type and, worse, makes every `Authentication` group reachable by API keys, whose handlers assume `UserPrincipal` and treat anything else as a wiring defect (a 500, not a 403).

## Consequences

**Positive**: rotation needs no coordination; a leaked-key response is immediate (`revoke`) while routine rotation is smooth; the transports are unambiguous; a plugin adds a credential type with a Layer alone; existing user-facing groups cannot be reached by machine credentials.

**Negative**: during a grace window two credentials are live, so an operator rotating because of compromise must `revoke` (or use `gracePeriod: 0`), not wait; a service token already minted outlives its client's revocation by at most `serviceTokenTtl` (default 15 minutes, the accepted price of stateless verification); a group that should accept both users and machines must declare `MachineAuthentication` and handle every principal kind.
