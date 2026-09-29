# Hooks

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-12 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) |

---

> awthaq is pre-implementation (see `spec/README.md`). Every signature, requirement, and behavior in this file specifies intended design — drawn from `archive/design/plugins-as-layers.md` §3.4 and `archive/design/usage-examples-v4.md` §14 — not code that has shipped.

## BEH-EA-089: A hook point is declared as a service carrying its own `kind`

> **See:** [ADR-EA-001](../decisions/001-plugins-contribute-layers.md)

```ts
export class BeforeSignUp extends HookPoint.Service<BeforeSignUp>()("auth.user.signUp", { kind: "veto", input: SignUpInput }) {}
export class AfterSignIn  extends HookPoint.Service<AfterSignIn>()("auth.signIn", { kind: "observe", input: Session }) {}
```

```text
REQUIREMENT: `HookPoint.Service` MUST require a `kind` ("veto", "observe",
             or "divert") and an `input` schema at the point's own
             definition; nothing about a point's failure semantics may be
             decided later, by whichever plugin happens to tap it.
```

`archive/design/plugins-as-layers.md` §3.4 fixes a hook point as "a service holding a registry cell," whose defining plugin (or core) chooses its `kind` once. `research/09-plugin-architecture.md` Q27 draws the contrast this design is built to avoid: Tapable's hook classes (`SyncHook`, `SyncBailHook`, `SyncWaterfallHook`) encode failure semantics in the type, which awthaq's plan follows, rather than better-auth's array-of-`{matcher, handler}` hooks, where "before" and "after" are a naming convention a tap author must respect rather than a property the point itself enforces.

## BEH-EA-090: A veto tap may abort the operation with a typed `HookAbort`

```ts
const CompanyEmail = BeforeSignUp.tap((input) =>
  input.email.endsWith("@acme.com") ? Effect.succeed(input) : HookAbort.fail({ code: "EMAIL_DOMAIN_NOT_ALLOWED" }))
```

```text
REQUIREMENT: A tap on a `kind: "veto"` hook point MUST be able to return a
             `HookAbort` failure that stops the operation the point guards,
             surfaced to the caller as a typed error naming the abort's
             `code`.
```

**As shipped (NAM-002/SCP-008):** core declares the six points `spec/overview.md` lists — `BeforeSignUp`, `AfterSignUp`, `BeforeSignIn`, `BeforeSessionIssue`, `AfterSignIn`, `BeforeUserDelete`. `BeforeSignUp` (input `{ email, name, strategy }`) guards every user-creating path, password sign-up and the OAuth first-login creation alike; `BeforeSignIn` (input `{ userId, email, strategy }`) guards every sign-in-completing flow (password, OAuth, passkey) once the credential is proven and before `BeforeSessionIssue`. An abort reaches the caller as `HookAborted` (HTTP 403) and no session is issued. `docs/migrations/authjs.md` maps Auth.js's `signIn` callback onto these points.

**As shipped (JH-004):** a veto tap's returned value is checked against the point's own `input` schema (and a divert tap's diverted value against its outcome schema) before it reaches the next tap or the guarded operation; a value that fails is a `HookTapOutputInvalid` defect naming the point and the tap's owner, never a value the operation acts on.

`archive/design/usage-examples-v4.md` §14 is the worked example of this exact case — a company restricting sign-up to its own email domain by tapping `Hooks.beforeSignUp` — and shows the abort reaching the caller as a structured `{ code, message }` rather than a generic failure. This is designed to let a veto tap enforce a business rule (domain allow-listing, a custom eligibility check) without the plugin that defines the hook point needing to know about that rule in advance.

## BEH-EA-091: A veto tap may instead amend the value, and multiple taps on one point run in dependency order

```ts
const Normalize = AuthHooks.tap(Hooks.beforeSignUp, (input) => Effect.succeed({ ...input, email: input.email.toLowerCase() }), { order: "pre" })
```

```text
REQUIREMENT: A tap on a `kind: "veto"` hook point MUST be able to return a
             transformed value that subsequent taps and the operation
             itself observe in place of the original input; when more than
             one tap is registered on the same point, they MUST run in
             dependency order, then declared `order`, then plugin id.
```

`archive/design/usage-examples-v4.md` §14 shows `Normalize` running with `{ order: "pre" }` ahead of a hypothetical later veto check, so that a case-normalization amendment is guaranteed to apply before any tap that compares the email against a domain allow-list — the ordering rule from `research/09-plugin-architecture.md` Q27 (topo, then explicit order, then id; never plain registration order) is what makes that guarantee something an author can rely on rather than something that happens to work today.

## BEH-EA-092: An observe tap is fail-isolated — a throwing observer cannot fail the operation it observes

```ts
const Welcome = AuthHooks.tap(Hooks.afterSignUp, (user) => Mailer.use((m) => m.send({ to: user.email, template: "welcome" })))
```

```text
REQUIREMENT: A failure raised by a tap on a `kind: "observe"` hook point
             MUST be caught, logged, and MUST NOT propagate to fail the
             operation the point observes.
```

**As shipped (JH-002):** observe taps run inline, one after another in the resolved order (BEH-EA-091), so a later tap starts only after an earlier one completes and a slow tap adds latency to the observed operation — heavy work belongs in a forked fiber or an `AuthEvents` subscriber (BEH-EA-103). A failing tap is logged under the stable name `auth.hook.observer.error` (error level carries only a sanitized tag/message; the raw cause is debug level, EOTS-005) and counted in `awthaq_hook_observer_error_total`; later taps still run.

`archive/design/usage-examples-v4.md` §14 states this guarantee in one line: "observe: cannot fail sign-in even if it throws." `archive/PRD.md` §18 extends the same isolation to event observers generally. Without this isolation, an unrelated third-party plugin's welcome-email tap failing (a `Mailer` outage, a template bug) would fail every sign-up in the system — the opposite of what an "after the fact, side-effecting" hook is meant to be.

## BEH-EA-093: A divert tap returns a typed alternative outcome the caller must handle

```ts
yield* client.password.signIn({ payload }).pipe(
  Effect.catchTag("TwoFactorRequired", ({ challengeId }) =>
    client.twoFactor.verify({ payload: { challengeId, code: Redacted.make(totp) } }))
)
```

```text
REQUIREMENT: A tap on a `kind: "divert"` hook point MUST be able to redirect
             the guarded operation to a distinct, typed outcome (not the
             operation's ordinary success value and not an ordinary
             failure), and every caller of that operation MUST be able to
             pattern-match on the diverted outcome the same way they
             pattern-match on any other tagged result.
```

`archive/PRD.md` §13 names `BeforeSessionIssue` as the canonical `divert` point, and `archive/design/usage-examples-v4.md` §9 shows the two-factor plugin's step-up flow as the worked example: an ordinary `password.signIn` call is diverted into a `TwoFactorRequired` outcome the client catches and answers with a second call, rather than the sign-in either succeeding outright or failing outright. This is what lets a step-up authentication flow be added by installing a plugin, with no change to the password plugin's own definition.

**As shipped (ARF-005, THS-001).** `@awthaq/two-factor` is the first divert consumer: `Hooks.BeforeSignIn` returns `TwoFactorRequired { challenge }` for a user with a confirmed second factor, and every first-factor sign-in (password, magic link, email OTP) handles the alternative through the shared finalisation step, so no session exists until the challenge is proved. The divert context carries `amr`, the methods already proved, and `Hooks.BeforeCredentialReset` (a veto, `{ userId, secondFactorCode? }`) is consulted by `confirmReset` inside its transaction (BEH-EA-256).


## BEH-EA-094: Tapping a hook point nobody defines is a type error, not a silent no-op

> **Invariant:** [INV-EA-005](../invariants.md#inv-ea-005-a-hook-tap-on-an-undefined-hook-point-keeps-the-application-from-compiling)

```text
REQUIREMENT: A `Layer` built from `SomePoint.tap(...)` where no installed
             plugin's Layer provides `SomePoint` in its `ROut` MUST leave
             that service in the composed application's `RIn`, causing
             `Layer.launch` to refuse to compile — identical in kind to a
             missing port (BEH-EA-020).
```

This restates BEH-EA-024 from the tap author's point of view: **As shipped (ELC-001):** a point's tap registry belongs to the point's own built layer, and `SomePoint.tap(...)` returns a `Layer` that *requires* `SomePoint`; launching it without the point's layer is a compile error (`packages/core/test/HookPoint.types.test.ts`). Freezing (BEH-EA-024) is per composition: two compositions built from one module never share taps or a frozen state.

`archive/design/plugins-as-layers.md` §1 lists this exact row in its compiler-catches-this table, and the failure mode it replaces is a plugin author mistyping a hook-point key, or leaving a tap registered after the plugin that defined the point has been uninstalled, and getting a tap that silently never fires — indistinguishable, at runtime, from a tap that fires correctly zero times.

## BEH-EA-095: A shared table's hook-mediated extension is the only way a plugin observes another plugin's core data without altering its table

> **Invariant:** [INV-EA-016](../invariants.md#inv-ea-016-a-plugin-cannot-alter-a-shared-table-outside-its-declared-extension-points)

```ts
BeforeUserDelete.tap((u) => Invite.use((i) => i.purgeFor(u.id)))
```

```text
REQUIREMENT: A plugin that needs to react to a change in core-owned data
             (a user being deleted, a session being issued) MUST do so by
             tapping a hook point core exposes for that purpose, never by
             querying or altering core's tables directly from its own
             migration or service code.
```

**As shipped (CSG-001/DRS-002, ADR-EA-033):** erasure — the one reaction that must not be optional or swallowed — is no longer a `BeforeUserDelete` tap the host opts into. `Erasure.AccountErasure.eraseAccount` runs the `BeforeUserDelete` veto first, then, in one `SqlTransaction`, every plugin's `Erasure.contribute` contribution, the core rows and the audit pseudonymization, then publishes `auth.user.deleted`. A plugin's layer (`AuthPlugin.layer(Self, { contributes })`) requires `Erasure.ErasureRegistry`, so omitting the registry does not compile; a contribution that fails rolls everything back (`packages/core/test/AccountErasure.test.ts`). The schema remains FK-less by design (SEA-001): no database-level cascade exists, and none is needed.

`archive/design/plugins-as-layers.md` §8 shows exactly this pattern: the `Invite` plugin purges its own `acme.invite_invitation` rows for a deleted user by tapping `BeforeUserDelete`, a point core defines, rather than by declaring a foreign key into `users` and relying on a database-level cascade the linker would have to know about. This is the hook-system's contribution to the shared-table isolation BEH-EA-040 requires at the persistence stratum: cross-plugin reactions are explicit, typed, and ordered, never implicit database-level side effects.

## BEH-EA-096: The resolved order of every hook point's taps is introspectable without running any code

```
awthaq plugin list --hooks
```

```text
REQUIREMENT: The fully resolved tap order for every hook point in a
             composed application MUST be derivable from the installed
             plugin tuple alone (dependency order, then declared `order`,
             then plugin id) and printable by tooling, without executing
             any tap.
```

**As shipped (JH-003/PERS-003):** `TapOptions.owner` names the contributing plugin, and one comparator (`HookPoint.compareTaps`: dependency level, then declared `order`, then plugin id; application taps last) orders both the runtime chain and the manifest. A plugin declares its taps statically with `AuthPlugin.layer(Self, { taps: [Point.declareTap(handler, { order })] })`; `Auth.make(...).manifest.hooks` prints every declared tap per point in resolved order without building any layer, and each point's service exposes `resolved` at runtime. The `awthaq plugin list --hooks` command itself belongs to the CLI (`manifest.hooks` is its data source).

`archive/design/usage-examples-v4.md` §14 states this directly: "Resolved order is printable: `awthaq plugin list --hooks`." Because the ordering inputs (each plugin's `dependsOn`, each tap's declared `order`, each plugin's `id`) are all static facts read off the plugin classes (BEH-EA-006, BEH-EA-007), the CLI is designed to compute and display the resolved chain the same way it derives the migration order (BEH-EA-038), without needing a running application to observe it in.

_Previous: [BEH-EA-088](11-http-error-mapping.md#beh-ea-088-every-contract-errors-http-status-is-derived-from-its-httpapistatus-annotation-uniformly)_
_Next: [BEH-EA-097](13-events.md#beh-ea-097-authevents-is-a-bounded-pubsub)_
