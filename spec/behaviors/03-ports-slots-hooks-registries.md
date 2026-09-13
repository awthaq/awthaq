# Ports, Slots, Hook Points, and Registries

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-03 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | effect-auth Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Added a cross-reference to ADR-EA-006, previously uncited by any behavior file (CCR-EA-002) |

---

> effect-auth is pre-implementation (see `spec/README.md`). Every signature, requirement, and behavior in this file specifies intended design — drawn from `archive/design/plugins-as-layers.md` §3 and `archive/PRD.md` §9.3 — not code that has shipped.

## BEH-EA-017: Configuration is a `Context.Reference` with a default value

> **See:** [ADR-EA-011](../decisions/011-configuration-service-with-default.md), [ADR-EA-006](../decisions/006-runtime-config-separate-from-installation.md)

```ts
export const PasswordConfig = Context.Reference<{
  readonly minLength: number
  readonly breachCheck: boolean | { readonly onUnavailable: "allow" | "reject" }
  readonly resetTtl: Duration.Duration
  readonly rehashOnLogin: boolean
}>("effect-auth/password/Config", {
  defaultValue: () => ({ minLength: 12, breachCheck: false, resetTtl: Duration.hours(1), rehashOnLogin: true })
})
```

```text
REQUIREMENT: A plugin's options MUST be modeled as a `Context.Reference`
             carrying a `defaultValue`, never as constructor arguments to a
             factory function; a missing override MUST resolve to the
             default, never to an error.
```

`archive/design/plugins-as-layers.md` §3.1 motivates this by what it makes free: because options are read from the environment like any other service, per-tenant and per-test overrides need no mechanism beyond the one `Layer.provide` already offers (`TenantAuthConfig` via `LayerMap.Service` composes tenant-specific `Password.config(...)`/`Sessions.config(...)` Layers exactly as application wiring does). `archive/PRD.md` §5 (Design principle 4) states the same design intent directly: "Configuration is a service with a default... so per-tenant and per-test overrides need no new mechanism."

## BEH-EA-018: An invalid configuration override is a type error against the reference's shape, not a runtime validation failure

```ts
Auth.make([Password, Passkey]).layer.pipe(
  Layer.provide(Password.config({ minLength: 16, breachCheck: { onUnavailable: "reject" } }))
)
```

```text
REQUIREMENT: `Password.config(partial)` MUST type-check `partial` against
             `PasswordConfig`'s declared shape, so that a field of the wrong
             type or an unknown key is rejected by the compiler at the call
             site, never accepted and only later found invalid at boot or
             at first use.
```

`archive/design/plugins-as-layers.md` §3.1 draws the line precisely: "A missing override is never an error: the default applies. A *wrong* override is a type error against the reference's shape." This is the same discipline `research/09-plugin-architecture.md` Q30 names as "installation is code, configuration is data" carried one level further — configuration is *typed* data, validated the same way any other Effect value is validated, not a loosely-typed options bag interpreted by hand-written runtime checks.

## BEH-EA-019: Variants are alternative static layers that remove requirements from `RIn`

```ts
export class Password extends AuthPlugin.Service<Password, PasswordShape>()("password", { /* … */ }) {
  static readonly layer = AuthPlugin.layer(Password, { /* full */ })
  static readonly layerNoReset = AuthPlugin.layer(Password, { /* no mailer required; reset endpoints answer 404 */ })
}

Auth.make([Password.layerNoReset, Passkey])
```

```text
REQUIREMENT: A plugin MAY expose more than one static `Layer` under
             different names, each with its own `RIn`; `Auth.make` MUST
             accept any one of them in place of the plugin class itself,
             and the chosen variant's requirements MUST be visible in
             `auth.layer`'s type.
```

`archive/design/plugins-as-layers.md` §3.2 gives the canonical example: `Password.layerNoReset` drops `Mailer` from the composed `RIn` entirely, because the variant's `make` never reads it and its handlers 404 the reset endpoints instead of calling it. This is designed to let a plugin author offer a smaller-footprint configuration of the same plugin without inventing a second plugin id, a second contract, or a runtime feature flag — the difference is visible in `auth.layer`'s type before any code runs.

## BEH-EA-020: Ports are required in `RIn` and never provided by a plugin's `ROut`

> **See:** [ADR-EA-010](../decisions/010-plugins-require-ports-never-provide.md)

```ts
auth.layer.pipe(
  Layer.provide(PasswordHasher.layerArgon2id),
  Layer.provide(Mailer.layerSes)
)
```

```text
REQUIREMENT: No plugin's Layer MAY include a port service (`PasswordHasher`,
             `Mailer`, `WebAuthn`, `SqlClient`, `Crypto`, `KeyValueStore`,
             `RateLimiter`) in its `ROut`; every port a plugin uses MUST
             remain in that plugin's `RIn` until the application provides
             it.
```

`archive/design/plugins-as-layers.md` §3.3 states the consequence this rule is designed to produce: "a 'bcrypt plugin' is not a plugin at all; it is `BcryptHasher.layer`, which is what it should have been." Because two plugins can never both "provide" the same port, the whole class of conflict a naive plugin model needs a rule for — two plugins both claiming to be *the* password hasher — cannot arise; providing two Layers for one port in application code is a visible, ordinary `Layer.provide` shadow, not a plugin-system special case (`archive/design/usage-examples-v4.md` §17).

## BEH-EA-021: A slot is a `Context.Reference` with a fail-closed default that at most one plugin may override

> **See:** [ADR-EA-012](../decisions/012-slots-exclusive-registries-aggregate.md)

```ts
export const SubjectResolver = Context.Reference<SubjectResolverShape>(
  "effect-auth/slot/SubjectResolver", { defaultValue: () => identityOnly }
)

static readonly layer = AuthPlugin.layer(Roles, {
  make: /* … */,
  slots: [Layer.effect(SubjectResolver, resolverWithRoles)]
})
```

```text
REQUIREMENT: A slot's default value MUST apply whenever no installed
             plugin overrides it, and MUST fail closed (least authority,
             never least friction) rather than grant broader access than an
             explicit override would; overriding a slot MUST place it in
             the overriding plugin's Layer `ROut`, which is what makes two
             overrides pairwise-detectable (BEH-EA-012).
```

`archive/PRD.md` §7 names `SubjectResolver`'s default as "identity only" — a subject with no roles, no permissions, nothing beyond its own id — precisely so that installing no authorization-bearing plugin at all yields the least-privileged, not the most-permissive, resolution. `research/13-modularity-foundations.md`'s reading of Baldwin & Clark frames a slot as a design rule frozen early: it is a hidden module's replaceable *decision*, exclusive by construction, rather than a registry entry that could silently accumulate more than one contributor.

## BEH-EA-022: A veto hook point may abort or amend, and its taps run in dependency order

```ts
export class BeforeSignUp extends HookPoint.Service<BeforeSignUp>()("auth.user.signUp", { kind: "veto", input: SignUpInput }) {}

const CompanyEmail = BeforeSignUp.tap((input) =>
  input.email.endsWith("@acme.com") ? Effect.succeed(input) : HookAbort.fail({ code: "EMAIL_DOMAIN_NOT_ALLOWED" }))
```

```text
REQUIREMENT: A hook point declared `kind: "veto"` MUST allow a tap to
             either abort the operation with a typed `HookAbort` or return a
             transformed value that later taps and the operation itself
             observe; taps at one hook point MUST run in dependency order,
             then declared `order`, then plugin id.
```

`research/09-plugin-architecture.md` Q27 draws this from Tapable's typed hook classes (`SyncBailHook`, `SyncWaterfallHook`) while explicitly rejecting Tapable's registration-order semantics and Babel's famously reversed plugin/preset ordering rule, in favor of a small, declared, and printable order (`effect-auth plugin list --hooks`, `archive/design/usage-examples-v4.md` §14). Because a hook point is itself a service (`HookPoint.Service`), "may this plugin abort" is answered by the point's declared `kind`, not by convention a tap author must remember.

## BEH-EA-023: An observe hook point is fail-isolated; a divert hook point returns a typed alternative outcome

```ts
export class AfterSignIn extends HookPoint.Service<AfterSignIn>()("auth.signIn", { kind: "observe", input: Session }) {}

const Welcome = AuthHooks.tap(Hooks.afterSignUp, (user) => Mailer.use((m) => m.send({ to: user.email, template: "welcome" })))
```

```text
REQUIREMENT: A hook point declared `kind: "observe"` MUST NOT allow a
             failing tap to fail the operation it observes; a hook point
             declared `kind: "divert"` MUST allow a tap to return a typed
             alternative outcome the caller is required to handle, rather
             than the operation's ordinary success value.
```

`archive/design/usage-examples-v4.md` §14 states the observe guarantee directly: "cannot fail sign-in even if it throws." `archive/PRD.md` §13's `BeforeSessionIssue` and the two-factor flow in §9 are the canonical `divert` example: a divert tap can turn an ordinary sign-in into a `TwoFactorRequired` outcome the client is designed to catch (`archive/design/usage-examples-v4.md` §9) — a step-up path expressed as a typed alternative return, not as a side channel or a thrown exception an unrelated caller must know to catch.

## BEH-EA-024: Tapping a hook point nobody defines is a compile error, and registries aggregate through `Layer.effectDiscard`, ordered and frozen at first read

> **Invariant:** [INV-EA-005](../invariants.md#inv-ea-005-a-hook-tap-on-an-undefined-hook-point-keeps-the-application-from-compiling)

```ts
static readonly layer = AuthPlugin.layer(Invite, {
  make: /* … */,
  taps: [
    BeforeUserDelete.tap((u) => Invite.use((i) => i.purgeFor(u.id))),
    RateLimits.rule({ group: "acme.invite", endpoint: "create", limit: 10, window: "10 minutes" })
  ]
})
```

```text
REQUIREMENT: Tapping a hook point MUST place that point's service in the
             tapping plugin's Layer `RIn`; if no installed plugin's Layer
             provides that point in its `ROut`, the composed application
             `Layer` MUST fail to compile the same way a missing port does.
             A registry service MUST aggregate its contributions via
             `Layer.effectDiscard` writes ordered by dependency, then
             declared `order`, then plugin id, and MUST freeze at first
             read.
```

`archive/design/plugins-as-layers.md` §3.4 and §3.6 draw the contrast this entry is built on: a slot is exclusive because two overrides of one `Context.Reference` are ambiguous, while a registry (hook taps, event subscribers, rate-limit rules, session claims, OpenAPI tags) is designed to aggregate because many contributions to it are exactly what is wanted. `archive/design/plugins-as-layers.md` §1 lists "a plugin taps a hook point nobody defines" as a row in its compiler-catches-this table with the same enforcement mechanism as a missing port: the point's service remains in `RIn` until some plugin's `ROut` supplies it, so a mistyped hook-point key or a tap left behind after its defining plugin is uninstalled is a type error, never a silent no-op.

_Previous: [BEH-EA-016](02-plugin-composition-validate.md#beh-ea-016-the-linker-still-performs-two-runtime-checks-the-type-system-cannot-express-cycle-detection-and-migration-ordering)_
_Next: [BEH-EA-025](04-contract-stratum.md#beh-ea-025-a-principal-is-a-tagged-union-carrying-a-zanzibar-shaped-reference)_
