# ADR-EA-015: Qadi Bridge Path Selection

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-015 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-12 |
> | Status | Accepted — design; implementation deferred |
> | Author | effect-auth Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-002) |

---

## Context

ADR-EA-009 establishes that effect-auth ships two integration paths into qadi — Path A (`AuthorizedSubject`, decide-in-handler, `behaviors/19-qadi-bridge-path-a.md`) and Path B (`SubjectExtractor`/`RequirePermission`, declared-permission annotations, `behaviors/20-qadi-bridge-path-b.md`) — but states only that both exist and how each works, not when an application building a new endpoint should reach for one over the other. `behaviors/20-qadi-bridge-path-b.md`'s BEH-EA-159 comes closest to answering this on its own, stating that "an endpoint that gates on subject state alone (no loaded resource to evaluate against) SHOULD use Path B; an endpoint whose decision depends on a loaded resource's attributes MUST use Path A, because Path B has no resource to hand the policy" — but this is a single functional requirement embedded in the Path B behavior file, not a decision record an application author or a plugin author would think to consult when the question is "which bridge do I use here," and it does not address the secondary considerations that also bear on the choice: whether an endpoint should appear in the permission registry (BEH-EA-158), and whether an endpoint sits inside `HttpApi` at all (bare `HttpRouter` routes use `addGuardedRoute`, BEH-EA-152, which is built on the same `SubjectExtractor` Path B uses, not on Path A's request-scoped `CurrentSubject`).

No ADR currently states the selection criteria as a decision in its own right, which leaves two costs unaddressed: first, an application with both bridges wired (BEH-EA-160's `AuthzLive`) has no single place that states the rule beyond one behavior requirement buried in Path B's own file; second, a plugin author extending the contract with a new endpoint has to reconstruct the reasoning (resource-dependence, registry visibility, contract-vs-bare-router placement) from three separate behavior files rather than reading one decision that names all three factors together.

## Decision

An endpoint's choice of qadi bridge is governed by three factors, in order of how strongly each one constrains the choice:

1. **Resource dependence is the primary and non-negotiable factor.** An endpoint whose authorization decision depends on a loaded resource's attributes (an ownership check against a fetched row, a field-level projection of a record already read from the database) MUST use Path A — `guard`, `enforce`, `enforceProjected`, `filter`, or `decide` (BEH-EA-146) — because Path B's `RequirePermission` evaluates its policy from the `RequiredPermission` annotation alone, before any handler code runs, and therefore has no resource to hand the policy (BEH-EA-159). An endpoint that gates on subject state alone (a role check, a plan-tier check, anything answerable without first loading the target resource) SHOULD use Path B.
2. **Permission-registry visibility is a secondary factor that can tip a resource-independent endpoint toward Path B even when Path A would also technically work.** Only Path B's `RequiredPermission` annotations are readable by `registerApi`/`permissionRegistryRoute` (BEH-EA-158) without executing any handler; an endpoint an operator wants to see in `GET /__permissions` — because it is administratively significant, or because the registry is being used as a living audit surface for what a role can reach — is a reason to prefer Path B for a resource-independent endpoint even where Path A's `AuthorizedSubject` plus a manual `check` call would have been equally capable of enforcing the same policy.
3. **Contract placement decides the mechanism when the endpoint is not inside `HttpApi` at all.** A bare `HttpRouter` route outside the typed contract has no `HttpApiMiddleware` chain for `AuthorizedSubject` to attach to, so it MUST use `addGuardedRoute` (BEH-EA-152), which is built on the same `SubjectExtractor` Path B's `RequirePermission` uses — this is a constraint of where the route lives, not an endorsement of Path B's annotation style for that route, and it applies even to a route that is otherwise resource-dependent (BEH-EA-152's own CSV-export example fetches a resource and still goes through `SubjectExtractor`, because `guard`'s Path-A-style witness is available through `addGuardedRoute` too — the factor being decided here is *which extractor supplies the subject*, not which qadi call shape evaluates the policy).

Both bridges remain available in the same application simultaneously, wired from one shared `AuthzLive` root over one `auth.layer` (BEH-EA-160) — this ADR is guidance for choosing per-endpoint, not a decision to standardize on a single path application-wide.

## Alternatives considered

**Standardizing on Path A alone (dropping Path B and its declared-permission annotations)**, on the reasoning that Path A's `guard`/`enforce`/`check` calls are already a strict superset of what a resource-less policy check needs, so a second bridge mechanism is arguably redundant. This was rejected because it would give up the one property Path A cannot replicate: a permission registry derivable from the contract alone, without executing any handler (BEH-EA-158's "reads the manifest, never runs the application," matching the CLI's own posture in file 26). An application that wants `GET /__permissions` to be a complete, statically-derivable list of every guarded endpoint and the permission each requires cannot get that from Path A, because Path A's authorization calls live inside handler bodies where no static tool can enumerate them without executing (or statically analyzing) arbitrary handler code; Path B's annotations exist specifically so that enumeration is instead a schema read.

## Consequences

**Positive**: An application author has one place — this ADR — that states the deciding question ("does this endpoint's decision need a loaded resource?") before either path's own file, so the choice is made once per endpoint rather than re-derived from BEH-EA-159 in isolation each time. The registry-visibility and contract-placement factors are named as secondary considerations explicitly, so an author is not left assuming resource-dependence is the only axis that matters when a resource-independent endpoint's registry visibility is also a legitimate reason to prefer Path B.

**Negative**: The three factors do not always agree, and this ADR does not fully resolve every case where they conflict — a resource-independent endpoint that an operator wants in the permission registry (favoring Path B) but that a team has already built extensive Path-A tooling around (custom `enforceProjected` wrappers, shared `hideDenied`/`outagesAreDefects` catches per BEH-EA-147/148) is left to a judgment call this ADR does not fully adjudicate; an application with both bridges wired therefore still requires editorial discipline (a code-review convention, or a lint rule not yet specified anywhere in this specification) to keep endpoints from drifting toward whichever bridge a given author reached for out of habit rather than the criteria stated here.

**Trade-off accepted**: The project accepts that path selection remains partly a matter of engineering judgment rather than something `Auth.make`'s type checker can enforce — unlike the compile-time guarantees ADR-EA-002 and ADR-EA-012 provide for plugin composition, nothing prevents an author from wiring a resource-dependent decision through Path B's annotation style in a way that silently cannot express what it needs (Path B has no resource to hand the policy, so the failure mode here is that the endpoint simply cannot be built that way, not that it compiles into a security hole) — the cost accepted is authoring friction and a rebuilt decision rather than a type error, in exchange for not constraining the two bridges' designs to make path selection itself type-checkable, which neither `behaviors/19-qadi-bridge-path-a.md` nor `behaviors/20-qadi-bridge-path-b.md` was designed to support.

Not yet implemented — see spec/roadmap.md for milestone.
