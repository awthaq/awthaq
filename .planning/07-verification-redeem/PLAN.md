# Plan 07: `Verification.redeem` owns the consume-in-transaction protocol

| Property | Value |
|---|---|
| Strength | Worth exploring (README index). This plan finds it stronger than that: it fixes a live bug in two plugins and removes a memory/SQL drift that two tests already work around |
| Dependency category | ports & adapters (the `Verification` interface, its `layerMemory`/`layerSql` adapters, and the SQL transaction seam) |
| Wave / order | Wave B, after **01** (sign-in completion moves to core) and **06** (rate-limit budget). Before **02** (store seam), which takes over the store record this plan introduces |
| Fixes live bugs | Magic links and email OTP codes are burned by a failed completion (an outage, a defect). In memory compositions a failed password reset burns its token, while over SQL it does not (`TwoFactor.test.ts:592` works around this). The PV-220 deferred-miss protocol is copied by hand at each transactional call site |
| Execution tickets | `.scratch/verification-redeem/issues/NN-*.md`, one per phase below (`docs/agents/issue-tracker.md`) |

Every `file:line` below was checked against the tree at `38bcd1b` (2026-10-13). Re-check the line numbers before editing, because plans 01, 03, 06 and 10 land first and move code.

---

## 1. Summary, goals, non-goals

### Summary

`Verification` is a **shallow** module today. Its interface has `consume`, an option `deferMiss`, and `recordMiss`. That gives callers the pieces of a protocol but not the protocol. The protocol is "consume the token and apply the state change it authorises in one transaction; on a miss, record the replay outside that transaction". Each caller has to put it back together:

- `packages/core/src/Verification.ts:146-153` says consumption and the caller's state change "are meant to commit in one transaction". `:129-136` (`ConsumeOptions.deferMiss`) and `:159-166` (`recordMiss`) are the PV-220 pieces (commit `34e1987`, "Record token replay outside the endpoint transaction").
- Only `@awthaq/password` puts the protocol together. It does so with a private error (`TokenMissed`, `Password.ts:365-371`), a wrapper (`consumeInTransaction`, `:769-776`), a settle step (`settleMiss`, `:777-780`), and three hand-written `sqlTransaction.withTransaction(...).pipe(catchTag("SqlError", die), catchTag("Password/TokenMissed", settleMiss))` blocks (`:1370-1457`, `:1485-1519`, `:1568-1610`).
- `@awthaq/magic-link` consumes **outside any transaction** and then runs the whole sign-in (`MagicLink.ts:338-355`, `EmailOtp.ts:331-353`). Any failure after `consume` burns the link or code. That includes a database outage while issuing the session, so the person must request a new mail.
- The memory adapter has no rollback at all. Over `layerMemory` + `SqlTransaction.layerNoop`, a refused password reset burns the token, while over `layerSql` the same refusal restores it. BEH-EA-259 bakes the drift into the spec ("rolls the consume back **(on SQL)**", `spec/behaviors/15-password.md:201-203`). A test comment works around it: "The wrong code spent the (in-memory, non-transactional) reset token, so request another." (`packages/two-factor/test/TwoFactor.test.ts:592`).

This plan makes `Verification` **deep**. A new interface member, `redeem({ identifier, value, use, onFailure? })`, runs the claim and `use` in one transaction, records a miss itself, and gives the token back when `use` fails. That holds in **both** adapters: SQL by rollback, memory by compensation. `onFailure` is the one capability dial. It classifies a typed failure of `use` as `"rollback"` (the token is live again; the default) or `"commit"` (the token is spent and what `use` wrote stands, for instance a second-factor divert). `deferMiss`, `ConsumeOptions` and `recordMiss` leave the interface. `consume` stays as the **burn-first** operation for callers whose token is spent on purpose before any follow-up: OAuth flow state, the native exchange code, SAML request and logout state.

### Goals

1. One implementation of the protocol, in `Verification.ts`. No caller ever sees a deferred miss.
2. "A failed completion gives the token back" holds the same way over `layerMemory` and `layerSql`, and the shared contract suite proves it for both adapters.
3. Every token-presenting caller is classified as either **redeem** or **burn-first**, with the spec text that justifies the choice (§2), and each one is migrated or annotated.
4. Magic link and email OTP stop burning a token on an outage or a defect (the live bug). A divert to the second factor still spends it, because the divert is the outcome the token paid for.
5. The PV-220 guarantee is kept and simplified: a replayed token leaves exactly one `auth.token.replay` event and one durable audit row, even through a transactional endpoint.
6. The interface shrinks by two members, and a type gate keeps them from coming back.

### Non-goals

- Changing what any **burn-first** caller does (OAuth `callback`/`exchange`, SAML ACS/SLO). They get only a call-site comment.
- Single-use stores that are not `Verification`: device-authorization grants (`DeviceAuthorization.ts:1163`), passkey `ChallengeStore` (`Passkey.ts:1341/1536/1798`, which burns by spec, BEH-EA-132), organization invitations (`Organization.ts:2928`) and the better-auth `LegacySessionBridge` (`Sessions.ts:875/1403`). §7 lists them as follow-up candidates.
- Moving `After*` hooks and event publication out of the transaction. That belongs to plan 01 (completion shape) and plan 10 (events from a rolled-back transaction). §8 records what this plan needs from them.
- A generic `VerificationStore` seam with third-party adapters. That is plan 02. This plan only puts the store half behind a module-private record that 02 then promotes.
- Retrying `redeem` on a transient `SqlError`. A retry re-runs `use`, and `use` runs hooks (see open question Q7).

---

## 2. Verified inventory of every `Verification` caller

### 2.1 Every call of `consume` (and the PV-220 pieces) in library source

`grep -rn '\.consume(\|deferMiss\|recordMiss' packages/*/src` finds the eleven sites below. `RateLimiter.consume`, the passkey `challengeStore.consume`, device-authorization `grants.consume` and the `LegacySessionBridge.consume` calls are different services and are excluded.

| # | Caller (file:line) | Purpose / identifier | Inside a transaction today? | State change after the consume | Behaviour today when something after the consume fails | Intended behaviour per spec | This plan |
|---|---|---|---|---|---|---|---|
| 1 | `Password.confirmReset`, `password/src/Password.ts:1338-1462` (consume at `:1373` through `consumeInTransaction`) | `reset-password:<publicId>` | **Yes**: `sqlTransaction.withTransaction` at `:1370-1457`, with `deferMiss` and `settleMiss` | `BeforeCredentialReset` veto (`:1386-1405`), `accounts.updateCredentialHash` (`:1422`), `users.verifyEmail` (`:1429`), `sessions.revokeAll` (`:1450`). `auth.password.resetCompleted` is published after the commit (`:1461`) | SQL: rollback restores the token. Memory: the token is burned. A `SqlError` dies (`:1455`), against ADR-EA-028 | BEH-EA-058/117: one transaction. BEH-EA-259: "a refusal rolls the consume back … and changes nothing". REQ-EA-165 and REQ-EA-693: the token is "still redeemable" after a failure | **redeem**, default `rollback` for every failure. The second-factor UX depends on it: retry the same token with `secondFactorCode` |
| 2 | `Password.verifyEmail`, `Password.ts:1464-1522` (consume at `:1488`) | `verify-email:<publicId>` | **Yes** (`:1485-1519`) | `users.verifyEmail` (`:1503`). `auth.user.emailVerified` after the commit (`:1521`) | Same as #1 | BEH-EA-058 (RRC-002 comment `:1478-1484`) | **redeem**, default `rollback` |
| 3 | `Password.confirmEmailChange`, `Password.ts:1554-1622` (consume at `:1571`) | `change-email:<publicId>` (`EmailChange.PURPOSE`) | **Yes** (`:1568-1610`) | `users.changeEmail` (`:1581`), `users.verifyEmail` (`:1589`), `sessions.revokeAll(…, "emailChanged")` (`:1603`). Event and previous-address mail after the commit (`:1611-1620`) | Same as #1. `EmailAlreadyExists` rolls back (SQL) | BEH-EA-058/053, BEH-EA-057 `change-email` paragraph ("its consumption commits together with `Users.changeEmail` + `Users.verifyEmail`") | **redeem**, default `rollback` |
| 4 | `MagicLink.verify`, `magic-link/src/MagicLink.ts:323-356` (consume at `:338-340`) | `magic-link:<publicId>` | **No**. The plugin does not even declare `SqlTransaction` (`:233`) | `Channel.complete` (`Channel.ts:152-195`): find or create the user (`users.create` `:123`, `auth.user.created` `:142`, `AfterSignUp` `:143`), `users.verifyEmail` `:156`, `assertCanSignIn` `:163`, `BeforeSignIn` `:165`, `BeforeSessionIssue` divert `:174-179`, which **issues a two-factor challenge** inside the tap (`two-factor/src/TwoFactor.ts:188`), then `sessions.issue` `:180`, `auth.user.signedIn` `:188`, `AfterSignIn` `:193` | **Burned on every failure**, including `StoreUnavailable` from `sessions.issue` and defects. Every refusal publishes `auth.user.signInFailed` (`refused`, `:327-335`) | BEH-EA-269: "consume it through `Verification.consume` (single use …)". The spec is silent on a failed completion | **redeem**. Refusals that follow a valid presentation (divert, veto, suspension, `ChannelInvalid`) **commit**, so the link is spent as today. An outage or a defect **rolls back**, so the link stays usable (the bug fix). See Q1 |
| 5 | `EmailOtp.verify`, `magic-link/src/EmailOtp.ts:315-354` (consume at `:331-333`) | `email-otp:<normalised address>` (budgeted, numeric) | **No** (`ports` at `:238` has no `SqlTransaction`) | Same `Channel.complete` as #4 | Same as #4. A miss spends one attempt (SOS-004) | BEH-EA-273: "consume through `Verification.consume` under the per-code attempt budget" | **redeem**, same classification as #4. A rollback also keeps the code's spent-attempt count unchanged (the claim only spends an attempt on a miss) |
| 6 | `OAuth.callback` (`callbackFlow`), `oauth/src/OAuth.ts:1023-1029` | `oauth-flow` state (`decodeState`) | No | **Outbound network**: token exchange `:1096`, JWKS/ID token `:1113`, userinfo `:1134`. Then account link/update (`:1174-1233`), JIT user create+link in its **own** `sqlTransaction` (`:1259`), hooks, `sessions.issue` (`:1380`), native exchange `verification.issue` (`:1419`) | Burned | BEH-EA-122 / INV-EA-015: state is single-use. RFC 9700 §10.12. The provider's `code` is single-use at the provider anyway. No network I/O may run inside a write transaction (ARF-002 reasoning, `Password.ts:1352-1355`) | **burn-first, keep `consume`**. Add a call-site comment only |
| 7 | `OAuth.exchange`, `OAuth.ts:1478-1492` | `oauth-exchange:` native code | No | **None**: decrypt and decode the stored session DTO (`:1493-1529`). By design "the code is already spent, so a wrong or missing verifier is one guess gone" (`:1495-1496`) | Burned (intended) | BEH-EA-128 "Native clients" (MNA-003): single-use exchange record | **burn-first, keep `consume`** |
| 8 | `SecondFactor.consumeChallenge`, `two-factor/src/SecondFactor.ts:422-441` (consume at `:428-430`), driven by `TwoFactor.attempt`, `two-factor/src/TwoFactor.ts:557-592` | `two-factor-challenge:<userId>` | No | TOTP step compare-and-set or recovery-code `markUsed`, failure budget (`recordFailure`, `SecondFactor.ts:171-187`), **re-issue** of a fresh challenge on a wrong code (`TwoFactor.ts:570-585`), `finalizeSignIn` → `sessions.issue` (`:522-549`) | Burned on everything. A wrong code re-issues `attempt + 1` (by design). An **outage** in `finalizeSignIn` also burns it, and the person restarts the whole sign-in from the first factor | ADR-EA-020 decision 2 and BEH-EA-262: "consume the challenge BEFORE checking the code", single-use, every failed or replayed consume publishes `auth.token.replay` | **redeem** in Phase 5 (recommended, Q2). Domain refusals (`InvalidTwoFactorCode` with its re-issued challenge, `SecondFactorLocked`, `UserSuspended`) **commit**, as today. An outage **rolls back** |
| 9 | `Saml.acs` → `consumeRequest`, `saml/src/Saml.ts:792-814` (consume at `:803-809`) | `saml-request:` state from the cookie | No | XML signature verification (`:841`), the one-time assertion id `reserve` (`:900`), account link/create in its own transaction (`:985`), role mapping, `sessions.issue` (`:1039`), the SAML session record | Burned | BEH-EA-244: "The ACS MUST consume that state exactly once". The assertion id is reserved separately, so restoring the request would not let the same response be reused | **burn-first, keep `consume`** |
| 10 | SAML SLO, `saml/src/SamlSlo.ts:431-449` (consume at `:443-449`) | `saml-logout:` state from the cookie | No | **None**: the local session ended before the logout request was sent (`:182-188`). Only the response is validated | Burned (intended) | BEH-EA-315: "`LogoutResponse` MUST answer THAT request id (reserved single-use …)" | **burn-first, keep `consume`** |
| 11 | PV-220 pieces, `Verification.ts:129-136`, `:159-166`, memory `:384-402`, SQL `:528-563` | n/a | n/a | n/a | n/a | n/a | **removed** in Phase 2 |

### 2.2 Other `Verification` users (issue/reserve only, out of scope)

- Issue only: `VerificationLink.issue` (`core/src/VerificationLink.ts:82-115`), `EmailChange.request` (`core/src/EmailChange.ts:52`, called by `Password.requestEmailChange` `:1545` and `AdminAccounts` `admin/src/AdminAccounts.ts:240`), `OAuth.authorize` (`OAuth.ts:977`, `:1381`, `:1420`), `Saml.authnRequest` (`Saml.ts:750`), `SamlSlo` (`SamlSlo.ts:197`), `SecondFactor.issueChallenge` (`SecondFactor.ts:400-418`), `EmailOtp.requestCode` (`EmailOtp.ts:298`), `MagicLink.requestLink` (`MagicLink.ts:300`).
- `reserve`: magic-link/email-OTP resend windows (`MagicLink.ts:295`, `EmailOtp.ts:292`), the SAML assertion replay cache (`Saml.ts:900`).
- Sweeps: `Erasure` (`core/src/Erasure.ts:130`, `deleteAllByUser`), `Retention` (`core/src/Retention.ts:112`, `purgeExpired`).

The task description asked about these four flows:

- Organization invitations: their own records (`Organization.ts:2928`), not `Verification`.
- Passkey challenges: `ChallengeStore`, which deletes on every attempt by spec (BEH-EA-132).
- Device authorization: `grants.consume` at `DeviceAuthorization.ts:1163`, then `sessions.issue` at `:1165` outside a transaction. This is the same bug class in a different store, so it is a follow-up and not this plan.
- Email change (BEH-EA-053) is caller #3.

### 2.3 Facts the design rests on (verified)

- **Nested transactions are savepoints.** Effect `4.0.0-rc.116` `unstable/sql/SqlClient.ts:259` (`makeWithTransaction`), `:294` (`id === 0 ? begin : savepoint`), `:319` (`rollbackSavepoint` on a nested failure). A `redeem` inside an outer transaction is therefore a savepoint. The outer one is either the RLS tenant transaction (`sql/src/TenantScope.ts:119-135`, run per request by `organization/src/TenantMiddleware.ts:113` and `:156`) or a caller's own.
- **A typed endpoint error does not roll the RLS tenant transaction back.** `HttpApiBuilder.ts:885-887` (rc.116) encodes a typed handler error into a response inside the route, so the `app` the tenant middleware wraps *succeeds* with a 410, and the outer transaction commits along with the replay row recorded inside it. A defect still rolls everything back.
- **The audit row joins the ambient transaction.** `AuthEvents.publish` writes the durable `AuditLog` row inline (`core/src/AuthEvents.ts:12`, `:215-245`). That is why PV-220 existed: a miss recorded inside a transaction that then fails is lost. The PubSub copy is not transactional.
- **`SqlTransaction.layerNoop` has no rollback** (`ports/src/SqlTransaction.ts:47-50`), and `Verification.layerMemory.consume` removes the row in its `Ref.modify` (`Verification.ts:327-383`). That is why memory burns what SQL restores.
- **Core SQL adapters own their transactions through `SqlClient` directly** (`Accounts.ts:562`/`:650`, `Sessions.ts:1252`/`:1354`). Plugins use the `SqlTransaction` port.
- **A Postgres constraint violation poisons the transaction.** `Users.create` maps a unique violation to `EmailAlreadyExists` (`core/src/Users.ts:940-950`). `Users.createOrGet` exists precisely to avoid that inside a transaction (SCP-003, `Users.ts:1053-1056`). `Channel.resolveUser` catches `EmailAlreadyExists` and re-reads (`Channel.ts:123-137`). Inside a Postgres `redeem` that re-read fails and becomes `StoreUnavailable`, so the redeem rolls back.
- **The SQL rate-limit store uses the ambient `SqlClient`** (`sql/src/RateLimiterStoreSql.ts:46`, `:87`), so a limiter charge made inside `use` rolls back with `use`.
- **The DomainWorld BDD probe observes transactions through the `SqlTransaction` port** (`features/step-definitions/DomainWorld.ts:68-77`, `:157-179`) and spies on `Verification.consume` (`:199-213`). REQ-EA-163 asserts that `"Verification.consume"`, `"Accounts.updateCredentialHash"` and `"Sessions.revokeAll"` share one transaction id (`VerificationSteps.ts:274-301`).

---

## 3. Target design

### 3.1 The interface (`packages/core/src/Verification.ts`)

```ts
/**
 * ADR-EA-039 (BEH-EA-058): how a typed failure of `redeem`'s `use` settles the transaction the token
 * was claimed in. `"rollback"` (the default): nothing `use` wrote stands, and the token is live again.
 * `"commit"`: the token is spent, what `use` wrote stands, and the failure still reaches the caller.
 * This is for a refusal that is itself the outcome the token paid for: a second-factor divert, or a
 * veto after a valid presentation. A defect or an interruption always rolls back.
 */
export type Settlement = "rollback" | "commit";

export interface RedeemInput<A, E, R> {
  readonly identifier: string;
  readonly value: Redacted.Redacted<string>;
  /** The state change the token authorises. Runs inside the transaction that claimed the token. */
  readonly use: (token: VerificationTokenView) => Effect.Effect<A, E, R>;
  readonly onFailure?: ((error: E) => Settlement) | undefined;
}

/** The settlement three callers share: an outage gives the token back, and any refusal spends it. */
export const commitUnlessUnavailable = <E extends { readonly _tag: string }>(error: E) =>
  error._tag === "StoreUnavailable" ? "rollback" : "commit";

export interface VerificationShape {
  readonly issue: /* unchanged */;
  /**
   * Burn-first: spends the token now, and nothing after it is atomic with the spend. Use it only
   * where spending is the point (an OAuth/SAML request state, a native exchange code). Never call it
   * inside a transaction your own failure rolls back: the miss it records would roll back too. Use
   * `redeem` instead. A miss publishes `auth.token.replay` (BEH-EA-059).
   */
  readonly consume: (
    identifier: string,
    value: Redacted.Redacted<string>,
  ) => Effect.Effect<VerificationTokenView, TokenConsumed | StoreUnavailable>;
  /**
   * BEH-EA-058/059/062, ADR-EA-039: claims the token and runs `use` with it in one transaction.
   * - `use` succeeds: both commit, and the token is spent.
   * - Miss (unknown, expired, already spent, wrong value): `use` never runs. The miss is recorded
   *   (the attempt a budgeted token is owed, `auth.token.replay`, its audit row) in a transaction
   *   that commits, and `redeem` fails with `TokenConsumed`.
   * - `use` fails: `onFailure` settles it (default `"rollback"`: the token is live again, in both
   *   adapters). A defect or an interruption always rolls back.
   * `SqlError` from the transaction itself is `StoreUnavailable("Verification.redeem")`.
   */
  readonly redeem: <A, E, R>(
    input: RedeemInput<A, E, R>,
  ) => Effect.Effect<A, TokenConsumed | E | StoreUnavailable, R>;
  readonly reserve: /* unchanged */;
  readonly deleteAllByUser: /* unchanged */;
  readonly purgeExpired: /* unchanged */;
}
```

Removed from the public interface in Phase 2: `ConsumeOptions` (`:129-136`), the `options` parameter of `consume`, and `recordMiss` (`:159-166`). `TokenConsumed` stays, because it is still the miss error of both `consume` and `redeem`.

Why `consume` stays public: four callers (#6, #7, #9, #10) are burn-first by spec, and #6 does network I/O after the spend, which must never run inside a write transaction. Expressing them as `redeem({ use: Effect.succeed })` would hide the burn-first intent behind a pointless transaction.

Why there is no `"burn"` settlement (spend the token but roll back `use`'s writes): no caller needs it. For magic link/OTP the refusals that should spend the link follow writes that should stand as they do today (a user created before a `BeforeSignIn` veto), so `"commit"` is the match. A `"burn"` settlement would need a savepoint around `use`. It is recorded as a considered alternative in ADR-EA-039 and should be added only when a caller appears (Q1 can create one).

### 3.2 One implementation over a module-private store record

`consume` and `redeem` are written **once** over the store half each adapter supplies. That is locality: the protocol lives in one place. It is also the shape plan 02 promotes to its `VerificationStore` seam (§8).

```ts
// ---- module-private ----

/** A `use` failure the transaction must roll back for. Wrapped so it can never be mistaken for an error of the transaction itself. */
interface Rollback<E> {
  readonly _tag: "Verification/Rollback";
  readonly error: E;
}

/** What each adapter supplies. `consume`/`redeem` are written once over it (plan 02 promotes this to `VerificationStore`). */
interface ClaimStore {
  /**
   * One atomic step. Takes the live row for `identifier` whose hash is `valueHash` (SQL: sets `consumedAt`;
   * memory: moves it out of `live`, and into `held` when `hold`), or on a miss spends the attempt a
   * budgeted live row is owed (SOS-004). `None` is a miss.
   */
  readonly claim: (input: {
    readonly identifier: string;
    readonly valueHash: string;
    readonly now: DateTime.Utc;
    readonly hold: boolean;
  }) => Effect.Effect<Option.Option<VerificationTokenView>, StoreUnavailable>;
  /** The unit `redeem` runs in. `layerSql`: one `sql.withTransaction`. `layerMemory`: the effect itself. */
  readonly transaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | StoreUnavailable, R>;
  /**
   * After a held claim's `use` ended. `"kept"` drops the hold. `"returned"` gives the row back, unless a
   * newer `issue` replaced it or `deleteAllByUser` swept it meanwhile. Over SQL this is a no-op, because the
   * rollback already did it.
   */
  readonly release: (id: VerificationTokenId, how: "kept" | "returned") => Effect.Effect<void>;
}

const makeTokenFlows = (
  store: ClaimStore,
  crypto: Crypto.Crypto,
  events: AuthEvents.AuthEventsShape,
) => {
  const hashOf = (value: Redacted.Redacted<string>, operation: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(Redacted.value(value)))
      .pipe(Effect.map(toHex), Effect.catchTag("PlatformError", storeUnavailable(operation)));

  const missed = (identifier: string) =>
    new TokenConsumed({ message: "awthaq: token replay or unknown token", identifier });

  /** BEH-EA-059: a miss is published once, here, whichever operation saw it. */
  const claimOrMiss = Effect.fnUntraced(function* (
    identifier: string,
    value: Redacted.Redacted<string>,
    hold: boolean,
    operation: string,
  ) {
    const valueHash = yield* hashOf(value, operation);
    const now = yield* DateTime.now;
    const token = yield* store.claim({ identifier, valueHash, now, hold });
    if (Option.isNone(token)) yield* events.publish({ _tag: "auth.token.replay", identifier });
    return token;
  });

  const consume = (identifier: string, value: Redacted.Redacted<string>) =>
    claimOrMiss(identifier, value, false, "Verification.consume").pipe(
      Effect.flatMap(
        Option.match({ onNone: () => Effect.fail(missed(identifier)), onSome: Effect.succeed }),
      ),
    );

  const redeem = <A, E, R>(input: RedeemInput<A, E, R>) =>
    store
      .transaction(
        Effect.gen(function* () {
          const token = yield* claimOrMiss(input.identifier, input.value, true, "Verification.redeem");
          // A miss is an outcome, not a failure: this transaction commits, and with it the spent
          // attempt and the replay's audit row (PV-220, without a deferred step).
          if (Option.isNone(token)) return { _tag: "Missed" } as const;
          return yield* input.use(token.value).pipe(
            Effect.map((value) => ({ _tag: "Done", value }) as const),
            Effect.catch((error) =>
              input.onFailure?.(error) === "commit"
                ? Effect.succeed({ _tag: "Refused", error } as const)
                : Effect.fail<Rollback<E>>({ _tag: "Verification/Rollback", error }),
            ),
            // Success here means the transaction commits (a result, or a refusal settled as commit).
            // Any failure (a rollback-settled error, a defect, an interruption) means it rolls back.
            Effect.onExit((exit) =>
              store.release(token.value.id, Exit.isSuccess(exit) ? "kept" : "returned"),
            ),
          );
        }),
      )
      .pipe(
        Effect.catchTag("Verification/Rollback", (rollback) => Effect.fail(rollback.error)),
        Effect.flatMap((outcome) =>
          outcome._tag === "Done"
            ? Effect.succeed(outcome.value)
            : outcome._tag === "Refused"
              ? Effect.fail(outcome.error)
              : Effect.fail(missed(input.identifier)),
        ),
      );

  return { consume, redeem };
};
```

Notes for the executor:

- **No `as` anywhere.** `as const` on literals is allowed (`.oxlintrc.json` override). `Effect.fail<Rollback<E>>(…)` gives the generic explicitly instead of asserting. There are no return-type annotations: `redeem` is generic through its own type parameters, so it is checked structurally when placed in the shape object. Assign the members in `Verification.of({ issue, consume, redeem, reserve, deleteAllByUser, purgeExpired })`, or in a plain object as today. Do **not** add `const redeem: VerificationShape["redeem"]`.
- If TS cannot infer the union return of the generator (`Missed | Done<A> | Refused<E>`), declare a module-private `type Outcome<A, E> = …` and use `Effect.succeed<Outcome<A, E>>(…)` at the three returns. That is a generic argument, not an assertion.
- The order of the post-transaction `pipe` matters. `Verification/Rollback` is unwrapped **after** `store.transaction` has mapped its own `SqlError`. So a `SqlError` that `use` leaks inside `E` reaches the caller as itself, not as `StoreUnavailable`. (A leak is a caller bug under ADR-EA-028.)
- Imports to add: `effect/Exit`, and `isSqlError` from `effect/unstable/sql/SqlError` (see 3.4).

### 3.3 Memory adapter: compensation gives the token back

`layerMemory` (`Verification.ts:263-453`) replaces `state: Ref<HashMap<string, TokenRow>>` with one `Ref` over both maps. A claim and its release are each one atomic `Ref.modify`/`Ref.update`, so a release never races `deleteAllByUser` or `issue` between two separate `Ref`s.

```ts
interface MemoryTokens {
  readonly live: HashMap.HashMap<string, TokenRow>;
  /** ADR-EA-039: rows a `redeem` has claimed and may still give back, keyed by token id. */
  readonly held: HashMap.HashMap<VerificationTokenId, TokenRow>;
}

const tokens = yield* Ref.make<MemoryTokens>({ live: HashMap.empty(), held: HashMap.empty() });

const store = {
  claim: ({ identifier, valueHash, now, hold }) =>
    Ref.modify(tokens, (s) => {
      const row = HashMap.get(s.live, identifier);
      if (Option.isNone(row) || isExpired(row.value, now)) return [Option.none(), s] as const;
      if (!Hmac.constantTimeEqualString(row.value.valueHash, valueHash)) {
        // SOS-004, exactly the branch at today's `:349-370`, applied to `s.live`.
        return [Option.none(), { ...s, live: spendAttempt(s.live, identifier, row.value) }] as const;
      }
      return [
        Option.some(viewOf(row.value)),
        {
          live: HashMap.remove(s.live, identifier),
          held: hold ? HashMap.set(s.held, row.value.id, row.value) : s.held,
        },
      ] as const;
    }),
  transaction: (effect) => effect,
  release: (id, how) =>
    Ref.update(tokens, (s) => {
      const row = HashMap.get(s.held, id);
      if (Option.isNone(row)) return s; // swept by deleteAllByUser while `use` ran
      const held = HashMap.remove(s.held, id);
      // A fresh `issue` for the identifier superseded this row while `use` ran: the newer row wins.
      return how === "kept" || HashMap.has(s.live, row.value.identifier)
        ? { ...s, held }
        : { live: HashMap.set(s.live, row.value.identifier, row.value), held };
    }),
} satisfies ClaimStore;
```

- `satisfies ClaimStore` (not an annotation) gives `transaction`, `claim` and `release` their contextual parameter types. `transaction: (effect) => effect` is assignable to the generic signature (the same precedent as `SqlTransaction.layerNoop`, `ports/src/SqlTransaction.ts:49`).
- `issue` (`:296-303`) writes `live`, pruning `live` only. `deleteAllByUser` (`:426-429`) filters **both** `live` and `held` by `userId` (plan 03 depends on this: an erasure during an in-flight redeem must not be resurrected by the rollback). `purgeExpired` (`:431-449`) prunes `live` only, never an in-flight hold.
- The returned row keeps its `attempts`, so a rolled-back OTP redeem leaves the budget where it was.
- **Documented drift (accepted, test-grade memory, TRBS-005).** While `use` runs the row is held, so a *concurrent* redeem of the same identifier misses at once (and publishes `auth.token.replay`). Over SQL the second claim's `UPDATE` waits on the row lock (Postgres) or the write lock (SQLite), and then wins if the first rolled back. BEH-EA-062 ("at most one succeeds") holds in both. Only the loser's timing differs, and the spec text records it (§6).

### 3.4 SQL adapter: the store half

`layerSql` (`Verification.ts:464-603`) gains `const sql = yield* SqlClient.SqlClient`, so its inferred `R` adds `SqlClient`. That client is the one its repositories were built on. Every existing composition `provideMerge`s the SQL client under the repositories, so the requirement is already met. Fix any composition `pnpm typecheck` flags.

```ts
const store = {
  claim: ({ identifier, valueHash, now }) =>
    Effect.gen(function* () {
      const claimed = yield* repo.tryConsume({ identifier, valueHash, now });
      if (Option.isSome(claimed)) return Option.some(toTokenView(claimed.value));
      yield* repo.recordFailedAttempt({ identifier, now }); // SOS-004
      return Option.none();
    }).pipe(
      Effect.catchTags({ SqlError: storeUnavailable("Verification.claim"), SchemaError: Effect.die }),
    ),
  transaction: (effect) =>
    sql.withTransaction(effect).pipe(Effect.catchIf(isSqlError, storeUnavailable("Verification.redeem"))),
  release: () => Effect.void,
} satisfies ClaimStore;
```

- `Effect.catchIf(isSqlError, …)` is used, not `catchTag("SqlError")`, because the transaction's error type contains the generic body error. The refinement only takes real `SqlError`s.
- Why `SqlClient` and not the `SqlTransaction` port: a core `layerSql` owns its transactions (precedent: `Accounts.unlink`, `Sessions.issue`). It also cannot be mis-wired: a composition that pairs `Verification.layerSql` with `SqlTransaction.layerNoop` would otherwise silently lose atomicity. The cost is the DomainWorld probe rewrite in Phase 2.
- No SQL repository change is needed: `tryConsume`, `recordFailedAttempt` and `upsertLive` already exist (`sql/src/Repositories.ts:1764-1801`) and run on the ambient transaction.

### 3.5 Error union

`redeem`: `TokenConsumed | E | StoreUnavailable`.

- `TokenConsumed` (`Verification/TokenConsumed`) is a miss of the claim itself. Callers map it to their wire error (`PasswordApi.TokenConsumed`, `MagicLinkApi.MagicLinkConsumed`, `EmailOtpApi.InvalidEmailOtp`, `InvalidTwoFactorCode`), after redeem, outside the transaction.
- `E` is exactly `use`'s own errors, whether settled `rollback` or `commit`. The caller sees the same error either way. Only the token's fate differs.
- `StoreUnavailable` is an outage of the claim, the hash, or the transaction's `BEGIN`/`COMMIT` (ADR-EA-028). Password's current `catchTag("SqlError", Effect.die)` (`:1455`, `:1517`, `:1608`) disappears, so a commit failure becomes 503 instead of a 500 defect.

### 3.6 The replay event

- Published exactly once per miss, by `claimOrMiss`, for both `consume` and `redeem`.
- Over SQL inside `redeem`, the miss happens in a transaction that **commits** (a miss is the `Missed` outcome, not a failure). So the durable audit row survives without a deferred step. Inside an outer RLS tenant transaction it is a savepoint that commits into the outer one, and the outer one commits on a typed error response (§2.3).
- Never published for a `use` failure. A rolled-back token is live, not replayed. A token spent by a `commit` settlement shows up as a miss (and a replay) on its *next* presentation.

### 3.7 Settlement per caller (decided; Q1 and Q2 may flip a row)

| Caller | `onFailure` | Justification |
|---|---|---|
| `Password.confirmReset` | default (`rollback`) | BEH-EA-259: a veto "rolls the consume back … and changes nothing". `SecondFactorRequired` asks the client to retry **the same token** with `secondFactorCode`. REQ-EA-165 and REQ-EA-693: "the reset token is still redeemable" |
| `Password.verifyEmail` | default | BEH-EA-058 (RRC-002) |
| `Password.confirmEmailChange` | default | BEH-EA-058. A taken address (`EmailAlreadyExists`) leaves the token live, as SQL already does |
| `MagicLink.verify` | `Verification.commitUnlessUnavailable` | The divert (`TwoFactorRequired`) **must** commit, because the challenge the tap issued inside `use` (`TwoFactor.ts:188`) would otherwise roll back and the client would hold a dead `challengeId`. A veto, suspension or `ChannelInvalid` follows a valid presentation and spends the link as today (BEH-EA-269 "single use"). An outage rolls back, which is the bug fix |
| `EmailOtp.verify` | `Verification.commitUnlessUnavailable` | Same as magic link (BEH-EA-273) |
| `TwoFactor.attempt` via `SecondFactor.redeemChallenge` (Phase 5) | `Verification.commitUnlessUnavailable` | ADR-EA-020 decision 2: a wrong code spends the challenge and re-issues `attempt + 1`, and the re-issue and failure-budget charge are writes that must stand. An outage in `finalizeSignIn` rolls back, so the person retries the code instead of restarting from the first factor |

Defects and interruptions always roll back. The REQ-EA-165/693 crash injections (`Effect.die`) therefore keep the token live in both adapters.

---

## 4. Phased migration

Every phase gate is `pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`. Phases 1 and 2 also run `pnpm test:pg`, because the SQL adapter changes. Plan gate: `pnpm check && pnpm test:pg`. One ticket per phase is created under `.scratch/verification-redeem/issues/` when work starts.

**Preconditions:** plan 01 is merged (the magic-link/OTP completion lives where 01 put it) and plan 06 is merged (the rate-limit calls that precede redeem take their final form). Re-run the §2.1 grep. Any new `consume` caller is classified the same way before Phase 6 closes.

### Phase 1: `redeem` in core (additive)

Files:

1. `packages/core/src/Verification.ts`
   - Add `Settlement`, `RedeemInput`, `commitUnlessUnavailable`, and `redeem` on `VerificationShape` (3.1).
   - Add the module-private `Rollback`, `ClaimStore` and `makeTokenFlows` (3.2).
   - `layerMemory`: replace `state` with `tokens: Ref<MemoryTokens>`. Move the `Ref.modify` decision (`:327-383`) into `store.claim` and add `store.release` (3.3). `consume` and `redeem` come from `makeTokenFlows`. Keep the existing `consume(…, options)`/`recordMiss` working **for this phase only** by implementing them over `store` (a `deferMiss` claim skips the publish, and `recordMiss` publishes). Phase 2 deletes them.
   - `layerSql`: add `const sql = yield* SqlClient.SqlClient`, `store` (3.4) and `makeTokenFlows`. Keep the temporary `deferMiss` path as above (the SQL claim with `deferMiss` skips `recordFailedAttempt` and the publish).
   - Rewrite the header comment (`:21-31`, the "needs no change to `VerificationShape`" sentence) to name ADR-EA-039 and `redeem`.
2. `packages/core/src/index.ts`: nothing (the module is already re-exported as `Verification`).
3. `packages/core/test/Verification.test.ts`
   - Switch `SqlLive` (`:35`) to `TestSql.layer("core_Verification")` (`packages/sql/test/support/TestSql.ts:103`), mirroring `core/test/Users.test.ts:19-28`, so the suite also runs on Postgres.
   - Add the redeem cases to `suite(name, layer)` (`:57-485`). They run on both adapters. Names are in §5.1.
   - Add `describe("Verification.redeem over a real transaction")` (SQL-only cases) and `describe("Verification (layerMemory) redeem compensation")` (memory-only cases), as in §5.1.
4. `scripts/test-pg.sh`: add `packages/core/test/Verification.test.ts` to `suites`.
5. `.changeset/verification-redeem.md` (core, minor). Text in §6.4.

Gate: the phase gate plus `pnpm test:pg`.

### Phase 2: Password onto `redeem`; remove the deferred-miss protocol

Files:

1. `packages/password/src/Password.ts`
   - Delete `TokenMissed` (`:365-371`), `consumeInTransaction` and `settleMiss` with their comment (`:765-780`).
   - `confirmReset` (`:1370-1457`) becomes:

     ```ts
     const userId = yield* verification
       .redeem({
         identifier,
         value,
         use: (consumed) =>
           Effect.gen(function* () {
             // the body of today's transaction from `:1376` to `:1451`, unchanged,
             // starting at `if (Option.isNone(consumed.userId))`
           }),
       })
       .pipe(Effect.catchTag("Verification/TokenConsumed", () => Effect.fail(new PasswordApi.TokenConsumed())));
     ```

   - Same for `verifyEmail` (`:1485-1519`, body `:1489-1513`) and `confirmEmailChange` (`:1568-1610`, body `:1572-1604`).
   - Remove the three `Effect.catchTag("SqlError", Effect.die)` and `Effect.catchTag("Password/TokenMissed", settleMiss)` pipes. Rewrite the comments at `:1361-1369` (ARF-001) and `:1566-1567` to say the token and the change commit through `Verification.redeem`.
   - Keep `SqlTransaction` in `ports` (`:757`) and `sqlTransaction` (`:794`): still used at `:1031` and `:1085`.
2. `packages/core/src/Verification.ts`: delete `ConsumeOptions` (`:129-136`), the `options` parameter, `recordMiss` from the interface and both adapters, and the temporary `deferMiss` branches from Phase 1.
3. `packages/core/test/Verification.test.ts`: delete the `describe("Verification deferred miss (PV-220)")` block (`:587-662`; its three tests are named in §5.4).
4. `features/step-definitions/DomainWorld.ts`
   - Delete `CurrentTransaction` (`:68-71`) and `TransactionProbe` (`:167-179`), and remove it from `probesLayer`'s return (`:227`) and the merge (`:255`, `:280`).
   - Rewrite `sighting` (`:158-163`) to read the **real** SQL transaction: capture `const sql = yield* SqlClient.SqlClient` in `probesLayer`, then `Effect.serviceOption(sql.transactionService)` → `Option<readonly [conn, depth]>`. Map `conn` to a stable number through a `WeakMap<object, number>`, with `0` when `None`. Savepoints share the connection, so a nested transaction counts as the same transaction, which is what REQ-EA-163 means.
   - `VerificationProbe` (`:199-213`) wraps `redeem` instead of `consume`, and records the sighting **inside** `use`, so the id is the claim's transaction:

     ```ts
     redeem: (input) =>
       real.redeem({
         ...input,
         use: (token) => sighting(probes, "Verification.redeem").pipe(Effect.andThen(input.use(token))),
       }),
     ```
5. `features/step-definitions/VerificationSteps.ts:289`: `"Verification.consume"` → `"Verification.redeem"`. Also update the comments at `:276-278` and `:513-517` (PV-220 wording).
6. `features/features/02-domain/08-verification-tokens.feature:95-96`: replace the PV-220 comment with "`Verification.redeem` records a miss in its own transaction, which commits (ADR-EA-039)".
7. `packages/two-factor/test/TwoFactor.test.ts:580-604` ("a wrong second-factor code is the typed HookAborted; a valid TOTP carries the reset"): delete the comment at `:592` and the `second` token request. Retry **the same `token`** with the valid code. This proves memory/SQL parity for BEH-EA-259.
8. `features/step-definitions/PasswordWorld.ts:96-99`: correct the comment (memory now restores the token through `redeem`; `SqlTransaction.layerNoop` remains for `signUp`).
9. `features/step-definitions/CompileTimeGates.ts`: add a `// type-gate: verification-miss-protocol-is-internal` block (pattern at `:65-76`):

   ```ts
   // ---- 08-verification-tokens.feature: BEH-EA-058 (REQ-EA-<new>) ----

   // type-gate: verification-miss-protocol-is-internal
   export const deferredMiss = (verification: Verification.VerificationShape) =>
     // @ts-expect-error - `consume` takes no options: a caller that needs a transaction uses `redeem`
     verification.consume("verify-email:gate", Redacted.make("v"), { deferMiss: true });
   export const recordedMiss = (verification: Verification.VerificationShape) =>
     // @ts-expect-error - there is no `recordMiss`: `redeem` records a miss itself
     verification.recordMiss("verify-email:gate");
   export const unknownSettlement = (verification: Verification.VerificationShape) =>
     verification.redeem({
       identifier: "verify-email:gate",
       value: Redacted.make("v"),
       use: () => Effect.void,
       // @ts-expect-error - a settlement is "rollback" or "commit"
       onFailure: () => "burn",
     });
   ```

   Add the matching `@REQ-EA-<new>` scenario in `08-verification-tokens.feature` under the BEH-EA-058 rule ("The deferred-miss protocol is not part of the interface"), with the `assertTypeGate` step in `CompileTimeSteps.ts`.
10. Spec, ADR and traceability edits listed in §6.1 to §6.3 for BEH-EA-058, BEH-EA-059, BEH-EA-117, BEH-EA-259, INV-EA-009, the glossary, ADR-EA-016 and the new ADR-EA-039.
11. `.changeset/verification-redeem-password.md` (core + password, minor). Text in §6.4.

Gate: the phase gate, `pnpm test:bdd` (REQ-EA-163/164/165/688/693 must pass unchanged in meaning) and `pnpm test:pg`.

### Phase 3: Magic link onto `redeem`

Written against today's code. If plan 01 has replaced `Channel.complete` with a core sign-in completion, substitute it for `channel.complete` below. §8 lists what Phase 3 needs from it.

1. `packages/magic-link/src/MagicLink.ts:337-355`:

   ```ts
   yield* rateLimit(rules.verifyByToken, { identifier: decoded.value.publicId });
   return yield* verification
     .redeem({
       identifier: decoded.value.identifier,
       value: decoded.value.value,
       use: (consumed) =>
         channel.complete({
           strategy: "magicLink",
           amr: ["email"],
           email: Option.map(decodePayload(consumed.payload), (payload) => payload.email),
           userId: consumed.userId,
           allowSignUp: settings.allowSignUp,
           ip: input.ip,
           userAgent: context?.userAgent,
         }),
       onFailure: Verification.commitUnlessUnavailable,
     })
     .pipe(
       Effect.catchTag("Verification/TokenConsumed", () => refused),
       Effect.catchTag("MagicLink/ChannelInvalid", (invalid) =>
         Channel.logInvalid("magicLink", invalid).pipe(Effect.andThen(refused)),
       ),
     );
   ```

   `refused` (`:327-335`) publishes `auth.user.signInFailed`. It stays **outside** the transaction (after `redeem`), so a rolled-back attempt still leaves its audit row. Rate limits stay before `redeem` (§8, plan 06).
2. `packages/magic-link/src/Channel.ts:123-140`: replace the `users.create` + `catchTag("Users/EmailAlreadyExists", findByEmail)` race recovery with `users.createOrGet` (`core/src/Users.ts:1056`, `{ user, created }`). On Postgres, a caught unique violation inside the redeem transaction poisons it (§2.3). Skip this step if plan 01 already moved creation to a `SignUp` built on `createOrGet`. Also update the header comment (`:9-14`) and BEH-EA-269 text: the user is created in the same transaction as the link's spend.
3. Update the header comment (`MagicLink.ts:15-18`): `Verification.redeem` (single use; an outage leaves the link usable).
4. Tests in `packages/magic-link/test/MagicLink.test.ts` (§5.2). Add a harness option to `packages/magic-link/test/support/harness.ts` (`buildLayer` options, `:95-106`): `failSessionIssue?: Ref.Ref<boolean>`. It decorates `Sessions.issue` (the `AccountsProbe` pattern, `DomainWorld.ts:181-198`) to fail with `StoreUnavailable({ operation: "Sessions.issue" })` while the flag is set.
5. BDD: `features/features/14-mfa-passwordless/32-magic-link.feature`, two new scenarios under BEH-EA-269 (§5.3). `MagicLinkWorld.ts` gets the same session-issue fault.
6. Spec `32-magic-link.md` BEH-EA-269 (§6.1). Changeset `.changeset/magic-link-redeem.md` (§6.4).

### Phase 4: Email OTP onto `redeem`

1. `packages/magic-link/src/EmailOtp.ts:331-353`: the same transformation as Phase 3 (`use` = `channel.complete({ strategy: "emailOtp", amr: ["otp", "email"], email: …, userId: consumed.userId, … })`, `onFailure: Verification.commitUnlessUnavailable`). Then `catchTag("Verification/TokenConsumed", () => refused)` and the `ChannelInvalid` mapping after.
2. Tests in `packages/magic-link/test/EmailOtp.test.ts` (§5.2), using the Phase 3 harness fault.
3. BDD: `33-email-otp.feature` under BEH-EA-273, one scenario (§5.3). Steps in `EmailOtpSteps.ts`.
4. Spec `33-email-otp.md` BEH-EA-273 (§6.1). Changeset `.changeset/email-otp-redeem.md` (§6.4).

### Phase 5: Two-factor challenge onto `redeem` (recommended; Q2)

1. `packages/two-factor/src/SecondFactor.ts`
   - Interface `:121-123`: replace `consumeChallenge` with

     ```ts
     /** BEH-EA-262/ADR-EA-020: spends the challenge and runs `use` with it in one transaction: a refusal commits, an outage gives the challenge back. */
     readonly redeemChallenge: <A, E, R>(
       challengeId: Redacted.Redacted<string>,
       use: (challenge: ConsumedChallenge) => Effect.Effect<A, E, R>,
     ) => Effect.Effect<A, InvalidTwoFactorCode | E | Errors.StoreUnavailable, R>;
     ```

   - Implementation replaces `:422-441`. Decode with `VerificationLink.decode` first, and fail `InvalidTwoFactorCode` on `None` without touching the store. Then `verification.redeem({ identifier, value, use: (token) => decode payload + userId (fail invalid inside use → committed: a foreign row is spent as today) then use(consumedChallenge), onFailure: Verification.commitUnlessUnavailable })`, with `catchTag("Verification/TokenConsumed", () => Effect.fail(invalid))`.
2. `packages/two-factor/src/TwoFactor.ts:557-592` (`attempt`): the rate limit stays first. The body from `:568` (`check`) to `:591` (`finalizeSignIn`) becomes the `use` of `factor.redeemChallenge(input.challengeId, (consumed) => …)`. Update the doc comment (`:551-556`).
3. Test and BDD callers of `consumeChallenge` move to `redeemChallenge(id, Effect.succeed)`: `two-factor/test/TwoFactor.test.ts:291`, `:294`, `:311`, `:314`, `features/step-definitions/MagicLinkSupport.ts:193-196`, `TwoFactorSteps.ts:426`, `MagicLinkSteps.ts:360`, `EmailOtpSteps.ts` (import at `:25`).
4. Tests in §5.2, BDD in §5.3, spec BEH-EA-262 and ADR-EA-020 rev 1.1 (§6.1, §6.2). Changeset `.changeset/two-factor-redeem.md`.

### Phase 6: Burn-first call sites, docs, final sweep

1. Call-site comments (no behaviour change), one line each, naming ADR-EA-039 and why the token is burn-first:
   - `OAuth.ts:1022` (network I/O follows; state is single-use, and so is the provider's code)
   - `OAuth.ts:1485` (a wrong verifier is one guess gone)
   - `Saml.ts:802` (BEH-EA-244 consume exactly once; the assertion id is reserved separately)
   - `SamlSlo.ts:442` (no state change follows)
2. `docs/plugin-authoring.md`, in the transaction paragraph at `:87`: "A token a person presents: `Verification.redeem` when it authorises a state change (it owns the transaction, the miss and the give-back); `Verification.consume` only when spending it is the point. Never call `consume` inside a transaction your own failure rolls back."
3. `spec/overview.md:146` (the `Verification` row) gets no change. Check `spec/glossary.md:49-51` (§6.1).
4. Re-run `grep -rn '\.consume(' packages/*/src` and confirm the result is exactly the four burn-first sites plus the non-`Verification` services listed in §2.1.
5. Run `pnpm check && pnpm test:pg`. Check `pnpm spec:verify:strict` and `features/traceability.md` for the new REQ ids.

---

## 5. Test plan

The convention is **replace, don't layer**: the protocol is tested once at `Verification`'s interface, against both adapters, and caller tests keep only their mapping and their own settlement choice.

### 5.1 `packages/core/test/Verification.test.ts` (new)

In `suite(name, layer)`, which runs against `layerMemory` and `layerSql` (SQLite, and Postgres under `test:pg`):

1. `ADR-EA-039: redeem runs use with the claimed token and spends it; a second redeem misses with TokenConsumed`. Assert the view's `payload` and `userId`.
2. `ADR-EA-039: a use that fails (rollback) gives the token back: the same value redeems on the next call`
3. `ADR-EA-039: a use that dies gives the token back`
4. `ADR-EA-039: an interrupted use gives the token back`. Fork the redeem, hold `use` on a `Deferred`, and `Fiber.interrupt`.
5. `ADR-EA-039: a refusal settled as commit spends the token and still fails with use's own error`
6. `ADR-EA-039/BEH-EA-059: a miss never runs use, fails TokenConsumed and publishes exactly one auth.token.replay`. Count through the `AuthEvents` stream, as the existing BEH-EA-059 test (`:139`) does.
7. `ADR-EA-039/BEH-EA-059: a rolled-back use publishes no auth.token.replay`
8. `SOS-004: a wrong value through redeem spends one attempt, and maxAttempts misses burn the token`. This mirrors `:422-460` through `redeem`.
9. `SOS-004: a rolled-back use leaves a budgeted token's spent attempts unchanged`. Spend 1 miss, roll back a hit, and assert that `maxAttempts - 1` further misses still burn it.
10. `BEH-EA-062: two concurrent redeems of one token run use to success at most once`. Adapt `:233-259`.
11. `ADR-EA-039: consume and redeem share one claim: a token spent by consume misses through redeem and vice versa`

`describe("Verification.redeem over a real transaction")` (SQL; also on Postgres):

12. `layerSql: use's own writes and the claim commit or roll back together`. The in-transaction witness is `verification.reserve({ identifier: "witness:…" })` inside `use`. After a rollback the witness reservation is claimable again (`true`) and the token redeems; after a commit both are spent.
13. `layerSql + AuditLog.layerSql: a miss through redeem leaves exactly one durable auth.token.replay row`. This replaces the first PV-220 test. Use the `SqlAuditLayer` composition at `:588-596`.
14. `layerSql: misses through redeem burn a budgeted token (the spent attempt commits)`. This replaces the second PV-220 test.
15. `layerSql: a use that fails on a real SQL statement rolls back and the token redeems afterwards`. Use `TestSql.injectFailure({ table: "verification_reservations", event: "INSERT" })` on the witness write. This proves the Postgres "aborted transaction" path ends in a clean rollback.
16. `layerSql: a redeem nested in an outer transaction is a savepoint: a rollback inside keeps the outer transaction usable, and a miss recorded inside commits with the outer one`. This covers the RLS `TenantScope.withTenant` shape. Wrap the call in `SqlClient.withTransaction`.
17. `layerSql: a SqlError from the claim surfaces as StoreUnavailable`. Reuse `DownLayer` (`:526-534`) and assert `operation === "Verification.claim"`.

`describe("Verification (layerMemory) redeem compensation")`:

18. `a fresh issue while use runs supersedes; a rollback does not resurrect the older token`
19. `deleteAllByUser while use runs; a rollback does not resurrect the swept token`
20. `a concurrent redeem of a held token misses at once (documented drift from SQL, which waits)`
21. `purgeExpired never removes a held claim`

### 5.2 Caller tests

- **Password** (`packages/password/test`): no deletions. The existing mapping tests stay: `Password.test.ts:976` "BEH-EA-059/118: replaying an already-consumed reset token fails with TokenConsumed", `:1001`, `PasswordRecovery.test.ts:30/54/76/99/160`, `PasswordChangeEmail.test.ts:162`. Add one:
  - `PasswordRecovery.test.ts`: "a crash while applying the reset leaves the same token usable in memory too". Use a `Sessions.revokeAll` that dies once (the fault pattern of `PasswordWorld.faultInjectingSessions`). This is the memory-side twin of REQ-EA-693.
- **Two-factor** (`packages/two-factor/test/TwoFactor.test.ts`): modify `:580-604` (Phase 2, §4). In Phase 5 add "an outage while issuing the session leaves the challenge usable: the same challenge and code sign in on retry" (harness `Sessions.issue` fault) and "a wrong code still spends the challenge and re-issues attempt + 1" (unchanged semantics; the existing `:225` test covers it, so assert it still passes).
- **Magic link** (`packages/magic-link/test/MagicLink.test.ts`): add
  - "an outage while issuing the session leaves the link usable: the same link signs in once the store is back"
  - "a link diverted to the second factor is spent: presenting it again fails MagicLinkConsumed, and the challengeId it returned is live"
  - "a BeforeSignIn veto spends the link (refusals commit)". Flip this one if Q1 is answered "rollback".
- **Email OTP** (`packages/magic-link/test/EmailOtp.test.ts`): add "an outage while issuing the session leaves the code usable and its attempt budget unspent". Present the right code after the outage, then confirm `maxAttempts` wrong guesses are still needed to burn a fresh code.
- **OAuth/SAML**: none (burn-first is unchanged).

### 5.3 BDD (`features/`)

New REQ ids are the next free ones at execution time. They are above `REQ-EA-1267` today, but plans 01, 03, 06 and 10 also allocate, so re-check `features/traceability.md`.

- `02-domain/08-verification-tokens.feature`, rule BEH-EA-058:
  - The type-gate scenario (Phase 2, item 9).
  - "A failed reset in an in-memory composition leaves the token redeemable". This is the memory twin of REQ-EA-165: the `memoryCore` world (`PasswordWorld.ts:90-99`) with the credential-write fault.
  - Update the comment above REQ-EA-688 (`:95-96`).
- `14-mfa-passwordless/32-magic-link.feature`, rule BEH-EA-269: "An outage while completing the sign-in leaves the link usable" and "A sign-in diverted to the second factor spends the link".
- `14-mfa-passwordless/33-email-otp.feature`, rule BEH-EA-273: "An outage while completing the sign-in leaves the code usable".
- `14-mfa-passwordless/31-two-factor.feature`, rule BEH-EA-262 (Phase 5): "An outage while finishing a second-factor sign-in leaves the challenge usable".
- Step changes: `DomainWorld.ts` probes (Phase 2), `VerificationSteps.ts:289`, a session-issue fault in `MagicLinkWorld.ts`/`TwoFactorWorld.ts`, and `consumeChallenge` → `redeemChallenge` in the step helpers (Phase 5).
- Existing scenarios that must keep passing **unchanged in meaning**: REQ-EA-163 (one transaction; now observed through the real SQL connection), REQ-EA-164, REQ-EA-165, REQ-EA-166..170, REQ-EA-688, REQ-EA-693, and the magic-link/OTP "diverted", "veto" and "suspended" scenarios (`33-email-otp.feature:190/199/207` and their 32 twins).

### 5.4 Tests deleted, by name

- `packages/core/test/Verification.test.ts`, describe "Verification deferred miss (PV-220)":
  - "layerSql: a miss inside a failing transaction records nothing until recordMiss runs after it"
  - "layerSql: attempts spent by misses recorded after the rollback still burn a budgeted token"
  - "layerMemory: deferMiss publishes nothing and recordMiss publishes one replay row"

  They are replaced by §5.1 items 6, 13 and 14.
- Test code deleted (not a test, but probe machinery): `DomainWorld.ts` `CurrentTransaction` and `TransactionProbe`.

---

## 6. Spec, ADR, traceability and changesets

### 6.1 Behaviour specs (each gets a Document Control revision and a change-history line)

- `spec/behaviors/08-verification-tokens.md` → rev 1.2.
  - BEH-EA-058: add "**As shipped (ADR-EA-039):** `Verification.redeem({ identifier, value, use, onFailure })` claims the token and runs `use` in one transaction. `layerSql` uses one `sql.withTransaction` (a savepoint inside an outer one). `layerMemory` holds the claimed row and gives it back on rollback, so a failed `use` leaves the token live **in both adapters**. A typed failure settles as `"rollback"` (default) or `"commit"` (`onFailure`); a defect or an interruption always rolls back. `consume` remains for burn-first tokens (OAuth/SAML request state, the native exchange code)."
  - BEH-EA-059: replace the PV-220 paragraph (`:76`) with "A miss inside `redeem` is recorded in a transaction that commits (the miss is an outcome, not a failure), so the event and its audit row survive a transactional endpoint without a deferred step (REQ-EA-688)."
  - BEH-EA-062: add the memory concurrency note from §3.3.
- `spec/behaviors/15-password.md` → revision bump. BEH-EA-259 (`:199-203`): delete "(on SQL)". BEH-EA-117: name `redeem`.
- `spec/behaviors/32-magic-link.md` BEH-EA-269 (`:68-80`): "MUST redeem it through `Verification.redeem` (single use; …). A refusal after a valid presentation (veto, suspension, divert, no usable user) spends the link; an infrastructure failure while completing leaves it usable." Plus the user-creation sentence from Phase 3 step 2.
- `spec/behaviors/33-email-otp.md` BEH-EA-273 (`:69-80`): same, plus "a rolled-back completion leaves the code's attempt budget unchanged".
- `spec/behaviors/31-two-factor.md` BEH-EA-262 (Phase 5): "consumed before the code is checked, in the same transaction as the check and the session; an outage gives the challenge back; a wrong code spends it (and re-issues)."
- `spec/invariants.md:109` (INV-EA-009 Enforcement): replace "Wrapping `consume` and the caller's own state change in one SQL transaction is the calling plugin's job" with "`Verification.redeem` owns the transaction (ADR-EA-039); the redeem cases in `Verification.test.ts` prove it for both adapters."
- `spec/glossary.md:49-51` (VerificationToken): "… consumed exactly once, through `Verification.redeem`, in the same transaction as the state change it authorises."

### 6.2 Decisions

- **New ADR-EA-039** (`spec/decisions/039-verification-redeem.md`; number reserved in `.planning/README.md`), "`Verification.redeem` Owns the Consume-in-Transaction Protocol", plus an `index.yaml` entry. It contains:
  - Context: the §1 summary, PV-220, the memory drift, the magic-link bug.
  - Decision: the interface (3.1), the settlement, memory compensation, `SqlClient` inside `layerSql`, burn-first `consume`, removal of `deferMiss` and `recordMiss`.
  - Alternatives considered:
    - (a) Keep the PV-220 pieces and document them. Rejected, because each caller re-implements them.
    - (b) A `redeem` module function over `Verification | SqlTransaction`. Rejected, because memory cannot give a token back without a store primitive.
    - (c) A `"burn"` settlement via a savepoint. Deferred: no caller.
    - (d) A runtime guard that dies when `consume` runs inside a transaction. Rejected: the RLS tenant middleware wraps every tenanted request in one (`TenantMiddleware.ts:113`).
    - (e) Retrying the redeem transaction on a transient `SqlError`. Rejected, because it re-runs hooks.
  - Consequences: §7 risks.
- **ADR-EA-016 rev 1.5**: mark the paragraph "BEH-EA-058's transaction requirement needs no change to `VerificationShape` at all" (`:38`) and the matching Consequences sentence (`:54`, "confirmed closed with zero interface change") as *Superseded by ADR-EA-039*, in the same inline style rev 1.2 used.
- **ADR-EA-020 rev 1.1** (Phase 5): decision 2 adds "the consume, the code check and the session share one `Verification.redeem` transaction; an outage gives the challenge back".
- **ADR-EA-028**: no change. `redeem` follows it (`StoreUnavailable("Verification.redeem")`). Optionally add Password's three removed `SqlError → die` sites to its Rollout line.

### 6.3 Traceability

- `spec/traceability.md:192` (the `Verification.test.ts` row): add "`redeem`: one transaction around claim and `use`, the give-back on a failed `use` in both adapters (held-row compensation in `layerMemory`), `commit` settlement, a miss recorded once in a committing transaction (ADR-EA-039)". Also update or add rows for the new Password, MagicLink, EmailOtp and TwoFactor tests in §5.2.
- `features/traceability.md`: add the new REQ rows (§5.3) and update REQ-EA-688's text if it names PV-220.

### 6.4 Changesets (ADR-EA-034: each has a `Migration:` section naming ADR and BEH ids)

- Phase 1, `.changeset/verification-redeem.md`, `"@awthaq/core": minor`:

  > `Verification.redeem({ identifier, value, use, onFailure })` claims a token and runs the state change it authorises in one transaction; a failed `use` gives the token back in both `layerMemory` and `layerSql` (ADR-EA-039, BEH-EA-058). `Verification.commitUnlessUnavailable` is the settlement for refusals that should spend the token.
  >
  > Migration: `Verification.layerSql` now requires `SqlClient` directly (the client its repositories run on); a composition that `provideMerge`s the SQL client under the repositories already satisfies it.

- Phase 2, `.changeset/verification-redeem-password.md`, `"@awthaq/core": minor`, `"@awthaq/password": minor`:

  > `Verification.consume` takes no options and `Verification.recordMiss` is gone: the PV-220 deferred-miss protocol is internal to `Verification.redeem` (ADR-EA-039, BEH-EA-059). Password's `confirmReset`, `verifyEmail` and `confirmEmailChange` redeem their tokens; in an in-memory composition a failed attempt (a veto, `SecondFactorRequired`, a crash) now leaves the token usable, exactly as over SQL (BEH-EA-259). A database failure while committing one of them is now `StoreUnavailable` (503) instead of a defect (ADR-EA-028).
  >
  > Migration: replace `consume(id, value, { deferMiss: true })` + `recordMiss(id)` inside your own transaction with `redeem({ identifier: id, value, use })`, and map `Verification/TokenConsumed` after it. A custom `VerificationShape` implementation (test double) must add `redeem` and drop `recordMiss`.

- Phase 3/4, `.changeset/magic-link-redeem.md`, `"@awthaq/magic-link": minor`:

  > A magic link or email code is no longer burned when completing the sign-in fails on an outage or a defect; it can be presented again. A refusal after a valid presentation (a veto, a suspended user, a second-factor divert) still spends it (BEH-EA-269, BEH-EA-273, ADR-EA-039).
  >
  > Migration: none for callers. A `BeforeSignIn`/`BeforeSignUp`/`BeforeSessionIssue` tap now runs inside the sign-in's transaction; a tap that writes through a *different* database client than the composition's may wait on the write lock.

- Phase 5, `.changeset/two-factor-redeem.md`, `"@awthaq/two-factor": minor`:

  > `SecondFactor.consumeChallenge` is replaced by `SecondFactor.redeemChallenge(challengeId, use)`: the challenge, the code check and the session commit together, and an outage gives the challenge back (BEH-EA-262, ADR-EA-020 rev 1.1).
  >
  > Migration: `consumeChallenge(id)` → `redeemChallenge(id, Effect.succeed)`.

---

## 7. Risks, mitigations, rollback

| Risk | Mitigation |
|---|---|
| **Longer write transactions.** The magic-link/OTP sign-in, including `Before*`/`After*` hooks, now runs inside the SQLite write lock (`busy_timeout` 5 s). `confirmReset` already hashes the password inside its transaction (`Password.ts:1421`) | Rate limits and every outbound call stay **before** `redeem`. Plan 01 is asked to move `After*` hooks and announcements after the commit (§8). Q6 proposes hoisting `hasher.hash` before `redeem`. Document in the changeset that taps run inside the transaction |
| **Postgres: a caught constraint violation poisons the transaction.** A `"commit"` settlement after a poisoned statement would make Postgres turn `COMMIT` into a silent `ROLLBACK`, giving the token back against the caller's intent | Phase 3 step 2 (`createOrGet`, SCP-003). Test 15 pins the rollback path on Postgres. ADR-EA-039 states the rule: inside `use`, never recover from a constraint violation by catching it; use `ON CONFLICT` forms |
| **Events published inside `use` escape a rollback** (the PubSub copy; the audit row does roll back). Examples: `auth.user.created`, `auth.user.signedIn` from `Channel.complete` | This is plan 10's "events from rolled-back tx" item, and Phase 3 does not widen it beyond the outage path. Plan 01's split of announcements (§8) removes it for sign-in |
| **A limiter charge inside `use` is refunded by a rollback** (`RateLimiterStoreSql` is on the ambient client) | Rule (ADR-EA-039, plan 06): enforce limits before `redeem`. The one intended exception is two-factor's failure budget, which only runs on the `commit` path |
| **Memory compensation bugs** (resurrecting a superseded or erased token) | One `Ref` over `live` + `held`. Tests 18 to 21. `deleteAllByUser` sweeps `held` (plan 03 relies on it) |
| **Memory concurrency drift** (a held token misses at once) | Documented in BEH-EA-062 and ADR-EA-039. Test 20 pins it. BEH-EA-062's guarantee holds in both adapters |
| **Mis-wired compositions** (repositories built on a different `SqlClient` instance than `Verification.layerSql`) leave statements outside the transaction | The same assumption as `Accounts`/`Sessions.layerSql` today. The canonical compositions (README, `examples/sql-server/app.ts:110-118`) share one client. Test 12 fails loudly if the witness write escapes |
| **Nested inside an outer transaction** (RLS tenant middleware): a miss commits only with the outer transaction | Verified that a typed error response commits the outer transaction (`HttpApiBuilder.ts:885-887`). Test 16 covers the nesting. A defect rolls back everything, which is acceptable |
| **The BDD probe rewrite masks a regression** in REQ-EA-163 | The new probe reads the real connection, which is stricter than the port wrapper. Run `test:bdd` before and after Phase 2 and compare REQ-EA-163/165/693 |
| **API break** (removed `ConsumeOptions`/`recordMiss`, `consumeChallenge`) | Pre-1.0. ADR-EA-034 allows it with a changeset migration note (§6.4). The type gate prevents a reintroduction |

**Rollback.** Each phase is one commit series on its own branch and reverts cleanly:

- Phase 1 is additive.
- Phase 2 reverts as a unit: interface removal, Password, probe, specs. The Phase 1 temporary `deferMiss` path makes Phase 2 revertable without reverting Phase 1.
- Phases 3, 4 and 5 are independent of each other, and each reverts to `consume` at its call site.
- If a production issue appears in the memory compensation, a one-line change in `layerMemory` makes `release` a no-op. That restores the old burn behaviour in memory only, and is acceptable as a hotfix while a test is written.

---

## 8. Interactions with other plans

- **01 (sign-in completion and sign-up in core)**: 01 runs first. Phases 3 and 4 wrap 01's channel completion in `redeem(…, use = <01's completion>)`. What this plan needs from 01:
  1. The completion is an Effect with no outbound network I/O (hooks only), safe inside a write transaction.
  2. A divert surfaces as the typed `Hooks.TwoFactorRequired` failure, so `commitUnlessUnavailable` can commit it. Suspension, vetoes and the invalid-proof error stay typed failures too.
  3. User creation uses `Users.createOrGet` (or 01's `SignUp` built on it), never catch-`EmailAlreadyExists`-then-re-read (§7, Postgres).
  4. Ideally the announcements (`auth.user.created`, `auth.user.signedIn`, `AfterSignUp`, `AfterSignIn`) come back as a separate effect the caller runs after `redeem` resolves (for example `{ issued, announce }`). If 01 lands without (4), Phase 3 keeps them inside `use`, and plan 10 owns the rolled-back-event follow-up.

  01's fix of the `orDie` on `sessions.issue` (ADR-EA-028) is what lets an outage reach `redeem` as `StoreUnavailable` (rollback) rather than a defect. Both still roll back.
- **02 (one domain implementation over a store seam)**: runs after this plan. `ClaimStore` (`claim`, `transaction`, `release`) is the `Verification` half of 02's store seam. 02 promotes it from module-private to its `VerificationStore`, together with `issue`/`reserve`/`deleteAllByUser`/`purgeExpired` primitives, and keeps `makeTokenFlows` as the single domain implementation. Constraints 02 must keep:
  - `claim` is one atomic step that also spends the miss attempt.
  - `transaction` is the unit `use` runs in.
  - `release` exists so a store without rollback can give a held claim back.
  - A store's `deleteAllByUser` sweeps held claims.
- **03 (erasure)**: `deleteAllByUser` must sweep memory `held` claims (§3.3, test 19). Over SQL, an erasure blocks on the row lock of an in-flight redeem and then deletes, which is correct.
- **06 (rate-limit budget in core)**: runs first. Every `RateLimits.enforce`/budget call stays **before** `redeem`, never inside `use` (§7). The magic-link `verifyByToken` and Password `confirmReset`/`verifyEmail` rules are keyed on the decoded public id, which is available before `redeem`.
- **10 (standalone fixes)**: its "events from a rolled-back transaction" item covers events published inside `use` on the rollback path. `redeem`'s own replay event is published in a committing transaction and needs nothing from 10.
- **08 (test composition)**: `TestAuth.layer` keeps `Verification.layerMemory` with unchanged requirements. `layerSql`'s new `SqlClient` requirement is satisfied wherever 08's SQL bundle `provideMerge`s the client.
- **09 (event definitions)**: `auth.token.replay` is unchanged in shape. If 09 moves its schema, this plan follows.

---

## 9. Acceptance checklist

- [ ] `VerificationShape` has `redeem` and a two-argument `consume`. It has no `recordMiss`, and `ConsumeOptions` is gone. The type gate in `CompileTimeGates.ts` passes.
- [ ] `consume` and `redeem` are implemented once (`makeTokenFlows`) over each adapter's `ClaimStore`.
- [ ] No `as` (other than `as const`), no return-type annotations, and no `Effect.die` on `SqlError` in the touched source.
- [ ] §5.1 tests 1 to 11 pass against `layerMemory` and `layerSql`, on SQLite and on Postgres (`pnpm test:pg` includes `core/test/Verification.test.ts`).
- [ ] The three PV-220 tests are deleted and replaced (§5.4).
- [ ] `grep -rn 'deferMiss\|recordMiss\|TokenMissed\|consumeInTransaction\|settleMiss' packages features` returns nothing.
- [ ] `grep -rn '\.consume(' packages/*/src` lists exactly the four burn-first `Verification` sites, each with an ADR-EA-039 comment, plus the unrelated services.
- [ ] Password's three flows redeem. `TwoFactor.test.ts` reuses the same reset token after `HookAborted` in memory.
- [ ] Magic link and email OTP redeem with `commitUnlessUnavailable`. The outage scenarios pass, and the divert/veto/suspension scenarios still pass.
- [ ] (Phase 5, if Q2 = yes) `redeemChallenge` replaces `consumeChallenge`, and the challenge survives an outage.
- [ ] REQ-EA-163/164/165/166..170/688/693 pass. REQ-EA-163 is observed through the real SQL connection.
- [ ] BEH-EA-058/059/062/117/259/269/273 (and 262) are updated with revision bumps. INV-EA-009 and the glossary are updated. ADR-EA-039 is added and indexed. ADR-EA-016 is at rev 1.5 (and ADR-EA-020 at rev 1.1).
- [ ] `spec/traceability.md` and `features/traceability.md` are updated. `pnpm spec:verify:strict` passes.
- [ ] A changeset with a `Migration:` section exists for each package-visible phase.
- [ ] `pnpm check && pnpm test:pg` is green on the final commit.

---

## 10. Open questions only the user can answer

1. **Magic link / email OTP refusals.** After a *valid* link or code, should a `BeforeSignIn`/`BeforeSignUp` veto, a suspended user, or "sign-up disabled / no usable user" **spend** it (recommended: today's behaviour, and the user created before a veto stays), or **give it back** so the same link works again within its TTL (for example after an admin lifts a suspension)?
   - If "give it back", the settlement becomes "commit only `TwoFactorRequired`", and the veto test in §5.2 flips.
   - If "give it back but roll back the user created before the veto", that needs the deferred `"burn"` settlement (a savepoint) after all.
2. **Two-factor challenge (Phase 5).** Migrate it, so an outage while issuing the session no longer forces a restart from the first factor? Or leave the challenge burn-first as ADR-EA-020 literally reads?
3. **Dead tokens inside Password's `use`.** A reset token whose user has no password credential, or a change-email token whose user is gone, fails *inside* `use` with `TokenConsumed` and is therefore **given back**: it stays live until its TTL, and no `auth.token.replay` is published. This matches SQL today. Is that intended, or should these settle as `commit` (spent, with the next presentation reported as a replay)?
4. **Memory concurrency drift.** Is it acceptable that `layerMemory` fails a concurrent redeem of a held token at once (publishing a replay), while SQL makes it wait? The alternative is a per-identifier lock in memory: more code, and test-grade only.
5. **ADR shape.** A new ADR-EA-039 (recommended, because it reverses ADR-EA-016's "zero interface change" decision), or only an ADR-EA-016 revision?
6. **Hoist the password hash.** Move `hasher.hash(input.password)` (`Password.ts:1421`) before `redeem`, so argon2 no longer runs inside the SQLite write lock? The cost is one hash for a bad token, bounded by the `confirmReset` rate limit. It is behaviour-neutral otherwise.
7. **Transient retries.** Should `redeem` ever retry its transaction on a retryable `SqlError` (`Errors.retryTransient`)? That re-runs `use` and its hooks. The recommendation is no: the caller gets `StoreUnavailable`, and the token is given back.
