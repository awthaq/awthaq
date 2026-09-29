---
"@awthaq/react": minor
---

`@awthaq/react` re-exports `@qadi/react` by name instead of `export *` (BO-007), so an upstream rename or addition fails this package's typecheck instead of silently changing its public API. The same bindings as before are exported, except qadi's devtools instrumentation registry (`gateInstances`, `subscribeGates`, `registerGate`, `updateGateState`, `clearGatesUnsafe`, `GateInstance`, `GateKind`, `GateRenderState`), which is withheld.

Migration: import the gate-instrumentation registry from `@qadi/react` (already a peer dependency) rather than `@awthaq/react`.
