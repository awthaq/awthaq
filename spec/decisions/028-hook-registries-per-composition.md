# ADR-EA-028: Hook Registries Belong to the Composition, and a Tap Requires Its Point

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-028 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-29 |
> | Status | Accepted — implemented |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-29): Initial release (ELC-001, JH-002/003/004, PERS-003, NAM-002) |

---

## Context

A hook point's tap registry lived in the closure of the module that declared it. The first `run` anywhere in the process froze it for everyone, so a suite that rebuilt a composition died with `HookPointFrozen`, erasure taps had to be shipped as opt-in side exports, and tap ordering could only use a process-global registration counter. `tap()` also returned a `Layer` with no requirement, so tapping a point nobody provides compiled, contradicting INV-EA-005.

## Decision

1. **The registry is allocated by the point's own built layer.** `Point.layer` creates the registrations when it is built; `Point.tap(handler, options)` returns `Layer<never, never, Point>` and registers through the point's service. Freezing (BEH-EA-024) is per built layer, and tapping an unprovided point leaves the point in the composition's `RIn`, so `Layer.launch` refuses to compile (INV-EA-005, `HookPoint.types.test.ts`). A tap must be built in the same layer graph as its point (memoized by layer reference, as `Hooks.HooksLive` is); two unrelated builds are two unrelated registries.
2. **Ordering is the spec's three keys, as a pure function.** `TapOptions.owner` is any value with an `id` and `dependsOn` (an `AuthPlugin` class is one). `HookPoint.compareTaps` orders by dependency level (a plugin's taps run after those of every plugin it depends on; application taps last), then declared `order`, then plugin id. The same comparator drives the runtime chain, each point's `resolved` introspection, and `Auth.make(...).manifest.hooks`.
3. **Taps are statically declarable.** `AuthPlugin.layer(Self, { taps: [Point.declareTap(handler, { order })] })` installs them with the plugin as owner and records `{ point, order }` on the plugin, so the resolved order is printable without building any layer (BEH-EA-096). The tapped points join the plugin layer's `RIn` like ports do.
4. **Run semantics**: observe taps run one after another in resolved order, each failure caught, logged (sanitized) and counted; a veto tap's amended value and a divert tap's outcome are checked against the point's own schema with `Schema.is`, and an invalid one is a `HookTapOutputInvalid` defect that never reaches the guarded operation.
5. **Every sign-in-completing flow consults `BeforeSignIn`** (a veto, after the credential is proven and before `BeforeSessionIssue`) and every user-creating path consults `BeforeSignUp`; `AfterSignUp` observes the commit. A veto surfaces as the typed `HookAborted` (403).

## Alternatives considered

**A `PluginOrder` reference provided by `Auth.make`.** Rejected: the point layer is usually provided outside the composed plugin layer, so it would not see the reference at build time, and a total topological index would make `order` and plugin id meaningless between plugins. Dependency depth read off the owners' `dependsOn` needs no composition context.

**Keeping erasure taps opt-in.** Rejected: the singleton that forced it is gone; erasure itself moves to a core registry (ADR-EA-031) because a veto hook is the wrong shape for "must run, must abort the transaction on failure".

## Consequences

**Positive**: compositions are independent; the compiler enforces INV-EA-005; the resolved order is inspectable.

**Negative**: a tap built in a *different* layer graph from its point silently has no effect (the compiler cannot see two graphs); a test that builds the point and the tap in separate `Effect.provide` calls must merge them.
