# @awthaq/react

## 0.2.0

### Minor Changes

- 349acb4: awthaq now builds on stable effect 4.1 and takes effect, `@effect/*`, qadi and React from the host application instead of bundling them.
  
  - **effect 4.0.0-rc.116 → 4.1.2, qadi 0.8 → 0.11.** Module paths follow effect's stable layout (`effect/http`, `effect/http-api`, `effect/sql`, `effect/encoding/*`).
  - **Peer dependencies.** Every package except `@awthaq/cli` declares `effect` (and, where used, `@effect/*`, `@qadi/*`, React) as `peerDependencies` with a range (`effect: ^4.1.0`, `@qadi/*: ^0.11.0`), so an application has exactly one copy of each. Install them next to awthaq. `pnpm package:smoke` now fails a package that bundles one of them or publishes an exact or prerelease peer.
  - **Crypto services (breaking).** effect 4.1 removed the `Crypto` service. Layers now require effect's `SecureRandom`, `Digest` and/or `Mac` (`effect/crypto/*`) instead; `NodeCrypto.layer` provides all of them, and `@awthaq/ports`' `WebCrypto.layer` now provides the same three over `globalThis.crypto` (`WebCrypto.Services`). Helpers that took a `Crypto` take the specific service: `Hmac.hmacSha256(mac, ...)`, `SecretHash.digest(hasher, ...)`, `Totp.hotp/totp/verifyTotp(mac, ...)`, `RecoveryCodes.generate(random, ...)`, `UserCode.generate(random)` / `hash(hasher, ...)`, and `VerificationLink.issue`/`EmailChange.request` deps take `random` instead of `crypto`. Random bytes and digests no longer fail, so the `PlatformError` → `StoreUnavailable` paths they fed are gone.
  - **`@awthaq/react`** re-exports qadi 0.11's seeded-decision API (`DecisionOutcome`, `SeededAllow`, `SeededDeny`, `isSeeded`, `outcomeOf`, `permits`, `ClientDecision`, `SeededDecision`); the new gate-registry instrumentation (`makeGateRegistry`, `useGateInstances`) is left to `@qadi/react`.
- 1cef4be: Built against `@qadi/core`, `@qadi/http` and `@qadi/react` 0.12 (the peer ranges move from `^0.11.0` to `^0.12.0`). `@awthaq/qadi`'s `ObligationHandlers.reauth` is an `ObligationHandler` of 0.12, so it takes the `{ question, decision }` discharge and reads `decision.obligations`; `onObligations: ObligationHandlers.reauth` is unchanged. `@awthaq/react` re-exports the new `useQuestions` hook (the devtools dock feed, `useDevtoolsFeed` and `runtimeLayer`, stays on `@qadi/react`).
  
  Migration: a host with an endpoint that declares neither `RequiredPermission` nor `publicEndpoint` (or that `RequirePermission` does not cover) now fails at startup, when `guardApi` is built, with `AccessNotDeclared` or `RequirePermissionNotAttached`, instead of serving a 500 per request: annotate the endpoint. A direct call `ObligationHandlers.reauth([...obligations])` becomes `ObligationHandlers.reauth({ question, decision })`; guard a Path B `HttpApi` with `guardApi(Api)` (replaces `RequirePermissionLive` and `registerApi`, provide `PermissionRegistryLive` once where the stack is composed) and see the `@qadi/http` 0.12 changelog for the rest.
- b8fb23c: Requires `@qadi/core`, `@qadi/http` and `@qadi/react` `^0.8.0` (was `^0.7.0`).
  
  `@qadi/http` 0.8.0 answers the `RequirePermission` refusals with typed bodies instead of empty ones so a generated `HttpApiClient` can decode them: a 403 `AccessDenied` carries qadi's public denial view (`subjectId`, `policyTag`, `reason`; never the evaluation trace), a 403 `UndischargedObligation` its tag, a 502 resolver outage its tag plus at most one identifying attribute (never the cause or the resolver's own message); the wiring-mistake 500 stays empty. BEH-EA-157 / REQ-EA-440 (PV-230).
  
  Migration: bump the three `@qadi/*` dependencies to `^0.8.0` together; a host that asserted an empty 403 or 502 body from `RequirePermission` now sees the typed view.
- b771d36: `@awthaq/react` re-exports `@qadi/react` by name instead of `export *` (BO-007), so an upstream rename or addition fails this package's typecheck instead of silently changing its public API. The same bindings as before are exported, except qadi's devtools instrumentation registry (`gateInstances`, `subscribeGates`, `registerGate`, `updateGateState`, `clearGatesUnsafe`, `GateInstance`, `GateKind`, `GateRenderState`), which is withheld.
  
  Migration: import the gate-instrumentation registry from `@qadi/react` (already a peer dependency) rather than `@awthaq/react`.
- 6ca84e6: A mutation against an endpoint the composed contract declares with a `SessionLifecycle` marker refetches the session (and the subject) on its own (ADR-EA-045, BEH-EA-178): `makeReactClient` always installs `ReactClient.sessionInvalidation`, the client half of the five markers, beside the default transport or a caller-supplied `httpClient`. A failed (non-2xx) mutation invalidates nothing.
  
  Migration: drop `reactivityKeys: [SESSION_KEY]` from mutations against declared endpoints (keeping it is harmless); a mutation of your own outside the contract that changes the session still passes it.

### Patch Changes

- Updated dependencies [a06b7c5]
- Updated dependencies [1cef4be]
- Updated dependencies [8dd72b6]
- Updated dependencies [3514b28]
- Updated dependencies [349acb4]
- Updated dependencies
- Updated dependencies
- Updated dependencies [d82b7a4]
- Updated dependencies [36951f5]
- Updated dependencies [401a719]
- Updated dependencies [fc20f74]
- Updated dependencies [9cdebdd]
  - @awthaq/client@0.2.0
  - @awthaq/api@0.2.0

## 0.1.0

### Patch Changes

- @awthaq/api@0.1.0
  - @awthaq/client@0.1.0
