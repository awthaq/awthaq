# ADR-EA-008: A Plugin Is a Context.Service Class

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-008 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-12 |
> | Status | Accepted — design; implementation deferred |
> | Author | effect-auth Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) |

---

## Context

ADR-EA-001 establishes that a plugin contributes a `Layer`; ADR-EA-002 establishes that plugin identity and requirements are read off that Layer's type. What remains is the concrete shape of the *class* a plugin author writes. PRD §9.1 gives the target shape directly: `export class Password extends AuthPlugin.Service<Password, PasswordShape>()("password", { apiVersion, contract, tables, migrations }) { static readonly layer = AuthPlugin.layer(Password, { dependsOn, make, handlers }) }` — a plugin is a typed service class carrying its contract (`HttpApi`), its table namespace, its migrations, and a `static readonly layer` built by `AuthPlugin.layer`, which composes `Layer.effect(plugin, make)` with the handler layer and any hook taps (`archive/design/plugins-as-layers.md` §2.2: "`AuthPlugin.layer` only does three things: `Layer.effect(plugin, make)`, `Layer.provideMerge` of the handlers ..., and `Layer.mergeAll` of the taps"). Application code then depends on a plugin exactly as it depends on any other service: `const password = yield* Password`.

Two prior models were considered and set aside. This project's own v0.1 design (`archive/design/api-design.md`, explicitly marked "kept for the research trace only — do not use `definePlugin` as current API guidance") modeled a plugin as `definePlugin(spec)`, returning a **frozen record** with a static half (inspectable without executing code, modeled on VS Code's `contributes` blocks) and a runtime half built from validated options — "`definePlugin` requires only `id` + `apiVersion`; every other field is optional and declarative; the returned record is frozen." better-auth's actual shipped model is even thinner: "The entire `BetterAuthPlugin` contract is `id` + optional contributions ... The only required property is `id`" (better-auth/03-plugin-system/01-plugin-contract.md; research/02-better-auth.md Q20, citing `packages/core/src/types/plugin.ts:39` and the plugins docs verbatim: "The only required property is `id`"). Both models keep a plugin's *requirements* — what services, ports, or other plugins it needs — as informal or undeclared information: better-auth has no mechanism by which a missing dependency, an unimplemented capability, or a conflicting plugin id is caught before runtime (research/02-better-auth.md Q20: "`id`-only contracts scale poorly once third-party plugins exist — better-auth's own remediation path (manual upgrade guides, scoped-package lockstep) is evidence"; Q21 independently notes that with declared `Context.Tag` requirements, "`Layer.mergeAll` composition *is* the dependency check — missing requirement = compile error").

## Decision

A plugin is a `Context.Service` class produced by `AuthPlugin.Service<Self, Shape>()(id, { apiVersion, contract, tables, migrations })`. The class carries, as **static, typed properties enforced by the type checker rather than convention**: a literal `id`, an `apiVersion` literal (rejecting cross-generation plugins, PRD §9.2), a `contract` (`HttpApi<"auth", Groups>` whose group ids are constrained by a template-literal type to the plugin's own namespace — `${Id}` or `` `${Id}.${string}` ``), a `tables` list similarly constrained to `` `${Id}_${string}` ``, and `migrations`. Its `static readonly layer`, built by `AuthPlugin.layer`, declares `dependsOn` (other plugin classes, joining `RIn` and fixing migration order in one declaration), a `make` effect (the plugin's own construction, which may `yield*` other plugins, ports, hook points, and its config reference), and `handlers` (an `HttpApiBuilder.group` layer satisfying the contract). `Auth.make` validates the resulting tuple of classes pairwise via `Validate<P>` (ADR-EA-002).

## Alternatives considered

**A frozen, declarative record returned by a `definePlugin` factory** — this project's own v0.1 design (`archive/design/api-design.md`), modeled on VS Code's static `contributes` blocks, valued specifically because it is inspectable without executing any code. Rejected for the reason ADR-EA-001 gives generally: a frozen data record cannot be checked by the type system the way a Layer's `RIn`/`ROut`/`Success`/`Error` channels can, so questions like "is every dependency present" or "does a contribution collide with another plugin's" would have to be answered by a hand-written interpreter walking the record at runtime, reproducing exactly the linker machinery ADR-EA-002 eliminates.

**better-auth's `id`-only plugin object** — the shipped competing-library model, where a plugin is `{ id, init?, endpoints?, middlewares?, hooks?, schema?, migrations?, ... }` with every field but `id` optional and no declared dependency, capability, or namespace mechanism at all (better-auth/03-plugin-system/01-plugin-contract.md §0; research/02-better-auth.md Q20–Q24). Rejected because it provides no compile-time (or even structured runtime) way to detect a missing dependency, a route or table namespace collision, or a duplicate plugin id — research/02-better-auth.md Q24 notes route uniqueness is "documentation-only" ("make sure your paths are unique to avoid conflicts... add the plugin name as a prefix") and cites CVE-2025-71399 as a case where exactly this kind of unenforced convention became a security bug.

## Consequences

**Positive**: Every property a plugin declares is checked by the compiler at its point of declaration — an out-of-namespace group or table name is a type error where the plugin is *defined*, not a runtime collision discovered when two plugins are composed together; a plugin built for a different `apiVersion` is rejected by `Auth.make` before any code runs; application code treats a plugin exactly like any other Effect service (`yield* Password`), so there is no second mental model for "using a plugin" versus "using a service."

**Negative**: Writing a plugin requires understanding `Context.Service` class mechanics, Layer composition, and the `AuthPlugin.Service`/`AuthPlugin.layer` helpers — a materially higher conceptual floor than either the frozen-record or `id`-only models, both of which a newcomer can read top-to-bottom as plain data. Static introspection (the "read the manifest without executing anything" property the frozen-record design offered) is only available for the small subset of a plugin's declaration that lives on the class's static properties (`id`, `apiVersion`, `contract`, `tables`), not for the runtime `make`/`handlers` half.

**Trade-off accepted**: The project accepts a steeper authoring curve — a plugin author must be a competent Effect/Layer author, not merely a JSON-shape author — in exchange for dependency, namespace, and version-generation checking that happens at compile time rather than being either undeclared (better-auth) or deferred to a hand-written runtime interpreter (the frozen-record design).

Not yet implemented — see spec/roadmap.md for milestone.
