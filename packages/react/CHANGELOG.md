# @awthaq/react

## 0.2.0

### Minor Changes

- b8fb23c: Requires `@qadi/core`, `@qadi/http` and `@qadi/react` `^0.8.0` (was `^0.7.0`).
  
  `@qadi/http` 0.8.0 answers the `RequirePermission` refusals with typed bodies instead of empty ones so a generated `HttpApiClient` can decode them: a 403 `AccessDenied` carries qadi's public denial view (`subjectId`, `policyTag`, `reason`; never the evaluation trace), a 403 `UndischargedObligation` its tag, a 502 resolver outage its tag plus at most one identifying attribute (never the cause or the resolver's own message); the wiring-mistake 500 stays empty. BEH-EA-157 / REQ-EA-440 (PV-230).
  
  Migration: bump the three `@qadi/*` dependencies to `^0.8.0` together; a host that asserted an empty 403 or 502 body from `RequirePermission` now sees the typed view.
- b771d36: `@awthaq/react` re-exports `@qadi/react` by name instead of `export *` (BO-007), so an upstream rename or addition fails this package's typecheck instead of silently changing its public API. The same bindings as before are exported, except qadi's devtools instrumentation registry (`gateInstances`, `subscribeGates`, `registerGate`, `updateGateState`, `clearGatesUnsafe`, `GateInstance`, `GateKind`, `GateRenderState`), which is withheld.
  
  Migration: import the gate-instrumentation registry from `@qadi/react` (already a peer dependency) rather than `@awthaq/react`.

### Patch Changes

- Updated dependencies [8dd72b6]
- Updated dependencies [3514b28]
- Updated dependencies
- Updated dependencies
  - @awthaq/client@0.2.0
  - @awthaq/api@0.2.0

## 0.1.0

### Patch Changes

- @awthaq/api@0.1.0
  - @awthaq/client@0.1.0
