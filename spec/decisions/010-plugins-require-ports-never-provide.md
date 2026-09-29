# ADR-EA-010: Plugins Require Ports and Never Provide Them

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-010 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-12 |
> | Status | Accepted — enforced at the type level by `Auth.make` (JH-008) |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-29): Corrected the bcrypt example to the shipped verify-only `LegacyPasswordVerifiers` mechanism (SAM-002) |

---

## Context

Stratum 2, Ports (PRD §11), defines a small set of capability interfaces every deployment needs an implementation of — `Crypto`, `KeyValueStore`/`RateLimiter`, `SqlClient`, `PasswordHasher`, `Mailer`, `WebAuthn` — each with `layer`/`layerNoop`/`layerMemory` variants. An earlier design shape allowed a plugin to *provide* a port implementation itself — "the old design let a plugin 'provide the hasher' and needed a conflict rule" (`archive/design/plugins-as-layers.md` §3.3) — which immediately raises the question of what happens when two installed plugins both attempt to provide `PasswordHasher`: a conflict-resolution rule has to exist, and that rule has to be enforced by something (a runtime linker, informal convention, or "last one wins" merge-order accident), none of which is a good foundation for a security-sensitive capability like a password hasher or a mailer. `research/01-effect-ecosystem.md` Q11 arrives at the same conclusion independently, noting that swapping capability implementations via `Layer.provide`/`Layer.provideMerge` means "precedence follows composition order" when duplicate tags are in play, and recommending explicit, deliberate wiring rather than "relying on incidental merge order."

## Decision

A plugin **requires** ports — they appear only in its Layer's `RIn`, never in `ROut` — and only the **application** provides port implementations, exactly once, at the top of the composition (`auth.layer.pipe(Layer.provide(PasswordHasher.layerArgon2id), Layer.provide(Mailer.layerSes))`, `archive/design/plugins-as-layers.md` §5). A component that would have been "a bcrypt plugin providing `PasswordHasher`" under the old model is, under this decision, not a plugin at all: it is not a plugin at all. For a legacy format an application is migrating away from, it is a verify-only entry in `PasswordHasher.LegacyPasswordVerifiers`, a `Context.Reference` the application provides like any port configuration (`@awthaq/migrate-auth0`'s `bcryptVerifier` is the shipped example, used for Auth0 and Supabase/GoTrue imports; `@awthaq/migrate-firebase` and `@awthaq/migrate-better-auth` ship the others) — while argon2id/scrypt remain the only algorithms `hash()` ever produces, so a legacy format is retired by rehash-on-login, never adopted as a standing target. As for any port implementation, "which is what it should have been" (`archive/design/plugins-as-layers.md` §3.3). Because two plugins cannot both provide one port (plugins never provide ports at all), the conflict this ADR exists to prevent — two implementations of one port in scope — cannot happen by construction; it becomes a visible, deliberate ordering choice the application makes in its own composition code, not a plugin-authoring hazard requiring a linker-enforced conflict rule.

## Alternatives considered

**Plugins may provide port implementations, with a conflict rule to arbitrate duplicates** — the project's own earlier design, per `archive/design/plugins-as-layers.md` §3.3's account of "the old design." This was rejected because it requires inventing and enforcing an arbitration policy (which plugin's `PasswordHasher` wins, and by what rule) for something that is fundamentally an *application deployment decision* (which hashing algorithm, which mail provider), not a property of any individual plugin; `research/01-effect-ecosystem.md` Q11 reaches the same conclusion, favoring capabilities declared as services with a safe default that applications override explicitly via `Layer.provide` rather than through incidental multi-plugin merge order.

## Consequences

**Positive**: "Two plugins implementing one port" is listed among the situations that "cannot happen by construction" (`archive/design/plugins-as-layers.md` §1) — there is no conflict-detection code to write or test for this case, because the type system's Layer composition rules make it structurally impossible. Port selection is visible, singular, and owned by the application's own composition code, which is exactly where a security- or infrastructure-sensitive choice (which password hasher, which mailer, which rate-limit store) belongs.

**Negative**: Every application must explicitly provide every port a plugin (transitively) requires before `Layer.launch` will accept the composed Layer — there is no "one plugin came with a reasonable default hasher built in" convenience; ports left unprovided remain visible in `auth.layer`'s `RIn` (as PRD §9.2's table notes: "a port has no implementation" fails at `Layer.launch`), which is caught early but does add boilerplate to every application's setup relative to a model where a sensible default plugin could have supplied it.

**Trade-off accepted**: awthaq trades the convenience of a plugin shipping its own working port default for the guarantee that port selection is always an explicit, visible, application-level decision — accepting that every new application must wire up `PasswordHasher`, `Mailer`, and any other required port itself, rather than inheriting an implicit choice from whichever plugin happened to bundle one.

Not yet implemented — see spec/roadmap.md for milestone.
