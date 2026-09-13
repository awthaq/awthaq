# ADR-EA-003: HttpApi Is the API Contract

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-003 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-12 |
> | Status | Accepted — design; implementation deferred |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) |

---

## Context

awthaq's stratum 1, Contract (PRD §10), must exist independently of any server code, because it is "what the client imports" (PRD §8) — schemas, errors, and endpoint shapes need to be shared, unmodified, between server and client without a second hand-written description of the API. Better-auth's own architecture shows what happens without a single typed contract: client plugins are a *separate* interface from server plugins (`$InferServerPlugin`, `getActions`, `pathMethods`) that must mirror the server plugin's shape by convention, inference collapses across repository boundaries, and route paths are inferred by a lossy kebab-to-camel-case convention rather than carried as a single value (research/02-better-auth.md Q29). The PRD's explicit benchmark is "one contract, no duplication" (research/01-effect-ecosystem.md Q ref: "PRD §22 explicitly wants 'one contract, no duplication' and cites better-auth's server→client inference as the benchmark").

Effect's `HttpApi` (in `effect/unstable/httpapi` under the v4 target, ADR-EA-007) is designed precisely for this: a single value describing groups, endpoints, payload/success/error schemas, and security requirements, from which both a server implementation (`HttpApiBuilder`) and a fully-typed client (`HttpApiClient.make`, `AtomHttpApi.Service`) are derived without any separate description (research/01-effect-ecosystem.md: "`HttpApiClient` already derives a fully typed client from an `HttpApi` definition — 'Deriving a Client' is a first-class HttpApi feature"). Each plugin's contract becomes its own `HttpApiGroup`, merged via `HttpApi.addHttpApi`, so that a plugin's endpoints, errors, and middleware requirements are one artifact rather than a server-side description plus a client-side mirror.

## Decision

`HttpApi` (and its constituents `HttpApiGroup`, `HttpApiEndpoint`, `HttpApiMiddleware`) is awthaq's API contract, in full: every plugin's contract is an `HttpApiGroup` (or several, one per sub-namespace) with schema payloads and `Schema.TaggedError` errors carrying their own `httpApiStatus`; core owns the root groups (`session`: current, list, signOut, revoke, revokeOthers, per PRD §10); applications merge contracts via `Auth.api`, sugar over `HttpApi.addHttpApi`, which refuses duplicate group ids. `Authentication` and `CsrfProtection` are declared as `HttpApiMiddleware.Service`s directly on the contract — `Authentication`'s `security` record is itself the strategy chain (v4 tries schemes in declaration order and returns the first success), and `CsrfProtection` declares `requiredForClient: true` so a generated client cannot type-check without implementing the client half of CSRF (PRD §10). Because contract and handlers are drawn from the same plugin tuple (ADR-EA-001, ADR-EA-002), a contract without handlers — or handlers without a contract — cannot be constructed (`archive/design/plugins-as-layers.md` §1: "impossible: `api` and `layer` come from one tuple").

## Alternatives considered

**Separate server- and client-facing plugin interfaces**, better-auth's model: a `BetterAuthPlugin` describing endpoints server-side, and an independent `$InferServerPlugin`-based client plugin that infers paths from the server plugin by a lossy naming convention and must be manually kept parallel (research/02-better-auth.md Q29, citing `packages/core/src/types/plugin-client.ts:94`). This was rejected because it reintroduces exactly the duplication `HttpApi` exists to eliminate, and because better-auth's own chronic "get-session type collapse" bugs (#5538, cited in the same research entry) demonstrate the maintenance cost of keeping two hand-synchronized descriptions of one API in sync across a monorepo or, worse, across separate client/server repositories.

## Consequences

**Positive**: One typed value produces both the server implementation and every client (`HttpApiClient.make` for plain Effect clients, `AtomHttpApi.Service` for reactive React/Next.js clients, PRD §16); error codes for i18n catalogs derive from the same contract; adding a plugin's group to `auth.api` automatically extends every downstream client's type with zero hand-written glue.

**Negative**: `HttpApi` in the v3 line is officially "Unstable" with a known middleware-skipping bug class and no dedicated web guide (research/01-effect-ecosystem.md: "officially 'Unstable' ... a known middleware-skipping bug class (#6121), and no streaming/SSE in v3"); awthaq's public contract surface is therefore coupled to the stability trajectory of one still-evolving Effect module, mitigated in v1 by targeting v4 where `HttpApi` streaming and the more mature `addHttpApi`/multi-scheme middleware land (ADR-EA-007).

**Trade-off accepted**: awthaq commits its entire public contract surface to `HttpApi`'s API shape and its evolution; a breaking change to `HttpApi` between v4 milestones is a breaking change to every awthaq plugin's contract, with no independent contract abstraction layer standing between the two.

Not yet implemented — see spec/roadmap.md for milestone.
