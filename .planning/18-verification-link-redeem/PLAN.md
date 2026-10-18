# Plan 18: `VerificationLink` owns redeeming a presented link

| Property | Value |
|---|---|
| Strength | Worth exploring (batch index). This plan finds it a little stronger: it closes a cross-purpose consume in `OAuth.callback` and a missing per-source budget on `confirmReset`, and it turns three per-caller conventions (purpose check, per-token budget, "the row names a user") into one interface the compiler checks |
| Dependency category | in-process (a pure codec plus a thin orchestration over the `Verification` interface; no adapter changes) |
| Wave / order | After plans 06 (rate-limit budget) and 07 (`Verification.redeem`, ADR-EA-039), both merged. Independent of plans 11–17 and 19–24, with one merge-order note for plan 14 (`OAuth.callback`, §8) |
| Fixes live bugs | (1) `OAuth.callback` consumes any `Verification` identifier the `state` names: a crafted `state` of `email-otp:<victim address>.<guess>` spends the victim's email-OTP attempts past `EmailOtp`'s per-address budget (BEH-EA-057). (2) `confirmReset` has no per-source budget and runs the breach-check network call for every well-formed token, so one source drives unbounded HIBP calls by rotating random public ids (APS-003's rule, kept by its two siblings) |
| Execution tickets | `.scratch/verification-link-redeem/issues/NN-*.md`, one per phase below (`docs/agents/issue-tracker.md`) |

Every `file:line` below was checked against the tree at `fc990c88` (2026-10-17). Re-check the line numbers before editing: sibling plans in this batch also edit `Password.ts`, `MagicLink.ts` and `OAuth.ts` (§8).

---

## 1. Summary, goals, non-goals

### Summary

`VerificationLink` (`packages/core/src/VerificationLink.ts`, 129 lines) is a **shallow** module. Its interface is a codec (`encode`, `decode`, `identifierOf`, `newPublicId`), one mint (`issue`) and a mail-data shaper (`mailData`). Redeeming a presented link is left to each caller, and five callers put it together by hand:

1. spend the endpoint's per-source budget (three of the five; `confirmReset` forgot it),
2. `decode(raw, PURPOSE)` and refuse on `None`,
3. spend the per-token budget keyed on the public id (four of the five),
4. `verification.redeem({ identifier, value, use })` (plan 07),
5. inside `use`, refuse a row that names no user or whose payload does not decode (each caller settles this differently),
6. `catchTag("Verification/TokenConsumed")` to the plugin's own refusal.

Plan 07 made `Verification.redeem` own the transaction protocol (claim, run `use`, record a miss, give the token back). That is the store half. This plan deepens the **link half** on top of it: a typed **purpose** (name, payload schema, whether the row names a user, how the public id is chosen) and a **redeemer** bound once per purpose in a plugin's `make`, which owns steps 1–3, 5 and 6 and calls `Verification.redeem` for step 4. A caller passes the presented token, the request's source address and `use`; `use` receives a typed link (`userId: UserId`, `payload: EmailChange.Payload`, …) and nothing else.

The seam stays where plan 07 put it: `Verification.redeem` is unchanged, and the redeemer is an orchestration over the `VerificationShape` interface, so it is tested over the memory `Verification` alone.

### Goals

1. One implementation of "redeem a presented link", in `VerificationLink.ts`, used by all five link callers (`Password.confirmReset`, `verifyEmail`, `confirmEmailChange`, `MagicLink.verify`, `SecondFactor.redeemChallenge`).
2. A purpose is a value, not a string: issuing and redeeming the same flow share it, so the payload a link is minted with and the payload `use` decodes are the same type, and a link of one purpose cannot be handed to another purpose's code at compile time (§3.5).
3. Both budgets are **declared where the link is bound**: a per-source budget spent before the token is decoded, and a per-token budget spent before the store is touched. The type requires a declaration for each (`"caller"`/`"none"` are explicit, reviewed opt-outs), so the `confirmReset` gap cannot recur silently.
4. One refusal channel: `VerificationLink/Refused` with `reason: "malformed" | "missed" | "foreign"`, mapped once per caller to its wire error.
5. One settlement for a foreign row (a row under the purpose's identifier that names no user or whose payload does not decode): it is spent (`"commit"`), the same in every caller (Q1).
6. Fix the two live bugs (§2.4) with failing tests first.
7. The four burn-first callers (OAuth flow state and exchange code, SAML request and logout state) use the shared codec instead of three hand-rolled `<identifier>.<secret>` parsers, so every `Verification` token that travels through a client is purpose-checked by one function.
8. Replace, don't layer: the per-flow malformed, cross-purpose, replay, foreign-row and per-user-key tests collapse into one suite at the redeemer (§5.3 names the ten deleted tests).

### Non-goals

- Changing `Verification` (`redeem`, `consume`, the settlement, the adapters). Plan 07's interface is the substrate.
- `EmailOtp.verify` (`packages/magic-link/src/EmailOtp.ts:286-330`). An email code is not a link: no public id, the identifier is the address, the value is a typed numeric code with its own attempt budget. It keeps calling `Verification.redeem` directly (Q5).
- Moving the burn-first callers onto `redeem`. They stay `consume` (ADR-EA-039 decision 6); only their codec changes.
- Single-use stores that are not `Verification` (passkey `ChallengeStore`, device grants, invitations): plan 12 and later plans.
- A runtime registry that refuses duplicate purpose names across plugins (Q6).

---

## 2. Verified current state

### 2.1 The five link callers

`grep -rn 'VerificationLink.decode\|verification\.redeem\|\.redeem(' packages/*/src` finds four `decode` callers in `Password.ts`/`MagicLink.ts`, one in `SecondFactor.ts`, and the five `redeem` calls below plus `EmailOtp.ts:304` (not a link, §1 non-goals).

| # | Caller | Per-source budget (before decode) | Decode + refuse | Per-token budget | Between budget and claim | `redeem` | "Row names a user" / payload check inside `use` | Settlement of that check | Refusal mapping |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `Password.confirmReset`, `password/src/Password.ts:1365-1493` | **none** (§2.4 bug 2) | `:1369-1373`, `RESET_PURPOSE` (`:541`) | `:1377` `"confirmReset"` (`:212-218`, `Key.identifier`) | `checkPolicy` (`:1383-1386`, breach-check network call, ARF-002) | `:1397-1488` | no `userId` → `TokenConsumed` (`:1405-1407`) | default `rollback`: the token stays live | `:1371`, `:1485-1487` → `PasswordApi.TokenConsumed` |
| 2 | `Password.verifyEmail`, `Password.ts:1495-1556` | `:1499` `"verifyEmailByIp"` (`:266`) | `:1501-1505`, `VERIFY_PURPOSE` (`:542`) | `:1507` `"verifyEmail"` (`:257-263`) | — | `:1516-1553` | no `userId` (`:1523-1525`) | `rollback` | `:1503`, `:1550-1552` |
| 3 | `Password.confirmEmailChange`, `Password.ts:1598-1669` | `:1602` `"confirmEmailChangeByIp"` (`:300`) | `:1603-1607`, `EmailChange.PURPOSE` (`core/src/EmailChange.ts:27`) | `:1608` `"confirmEmailChange"` (`:293-299`) | — | `:1612-1657` | no `userId`, or `EmailChange.newEmailOf(payload)` is `None` (`:1618-1621`) | `rollback` | `:1605`, `:1654-1656` |
| 4 | `MagicLink.verify`, `magic-link/src/MagicLink.ts:289-332` | `:290` `"verifyByIp"` (`:113-119`) | `:292`, `:302`, `PURPOSE` (`:132`) | `:303` `"verifyByToken"` (`:121-127`) | — | `:310-331` | none: `userId` is optional by design (a link to a new address signs up, BEH-EA-269); the payload decode is an `Option` handed to `Channel.complete` (`:318`), never a refusal | `commitUnlessUnavailable` (`:324`) | `:327` `refused` (publishes `auth.user.signInFailed`, `:293-301`) and `ChannelInvalid` (`:328-330`) |
| 5 | `SecondFactor.redeemChallenge`, `two-factor/src/SecondFactor.ts:461-489` | spent by the caller, `TwoFactor.attempt` (`two-factor/src/TwoFactor.ts:582`, `"verifyByIp"`) | `:464-465`, `CHALLENGE_PURPOSE` (`two-factor/src/Challenge.ts:34`) | none: guesses are the per-account failure budget (BCR-006, `SecondFactor.ts:175-235`) | — | `:467-488` | `ChallengePayload` decode or no `userId` (`:473-477`) | `commitUnlessUnavailable` (`:486`): the row is spent | `:465`, `:488` → `InvalidTwoFactorCode` |

What the candidate description got wrong, corrected here:

- Not all five spend a per-token budget: the second-factor challenge has none, by design (its guesses are the account's failure budget).
- Not all five refuse a row with no `userId`: a magic link legitimately has none (sign-up).
- The no-user refusal is not part of `verification.redeem`; it is each caller's own check inside `use`, and the callers settle it two different ways (rows 1–3 roll back, row 5 commits).
- `confirmReset` puts the policy check (with its network call) between the per-token budget and the claim, so "callers pass only `use`" needs one more dial (`beforeClaim`, §3.3).
- `EmailOtp` is not a `VerificationLink` caller (non-goals).

### 2.2 The mint side

| Caller | file:line | Purpose | `userId` | Payload | Public id |
|---|---|---|---|---|---|
| `Password` verification mail | `Password.ts:1078-1081` | `verify-email` | yes | none | random |
| `Password.requestReset` | `Password.ts:1329-1332` | `reset-password` | yes | none | random |
| `MagicLink.requestLink` | `MagicLink.ts:266-274` | `magic-link` | when the address has an account | `{ email }` (`LinkPayload`, `:135`) | random |
| `EmailChange.request` | `core/src/EmailChange.ts:66-71`, called by `Password.ts:1589` and `admin/src/AdminAccounts.ts:242` | `change-email` | yes | `{ newEmail }` (`EmailChange.Payload`, `:36`, written with `satisfies Payload`) | random |
| `SecondFactor.issueChallenge` | `SecondFactor.ts:434-457` | `two-factor-challenge` | yes | `ChallengePayload` (`Challenge.ts:41-49`) | **the user id** (`:437`, `:451`): one live challenge per account, because a fresh `issue` replaces the identifier's live row (ADR-EA-016) |

`SecondFactor.issueChallenge` does not use `VerificationLink.issue`: it calls `verification.issue` and `VerificationLink.encode` by hand, because `issue` always draws a random public id.

The payload is written and read through two unconnected spellings in every payload-bearing flow: `EmailChange` writes `{ newEmail } satisfies Payload` and reads `newEmailOf(payload)`; `MagicLink` writes `{ email }` and reads `Schema.decodeUnknownOption(LinkPayload)`; two-factor writes an object literal and reads `ChallengePayload`. Nothing ties the written shape to the decoded one.

### 2.3 The burn-first callers and their own codecs

| Caller | Encode | Decode | Purpose check before `consume` |
|---|---|---|---|
| `OAuth.authorize` / `callback`, `oauth/src/OAuth.ts` | `encodeState` `:159-160` (used `:921`) | `decodeState` `:162-171` (used `:943`) | **none** (`:943-955`): §2.4 bug 1 |
| `OAuth` native exchange | `encodeState` (`:1301`) | `decodeState` (`:1335`) | `EXCHANGE_PREFIX` (`:1339-1341`) |
| `Saml.acs` request state, `saml/src/Saml.ts` | inline `:945` | inline `:955-961` (first `.`) | `REQUEST_PREFIX` (`:959`) |
| SAML SLO logout state, `saml/src/SamlSlo.ts` | inline `:210` | inline `:429-434` (first `.`) | `LOGOUT_PREFIX` (`:432`) |

The comment above `encodeState` (`OAuth.ts:150-158`) records the decision not to share the codec ("duplicating six lines was judged simpler"). The callback is where that decision failed: the copy lost the prefix check its sibling at `:1339` keeps. Every identifier involved is `<prefix><uuid or base64url>` and every secret is hex, so splitting on the last `.` (the shared codec) and on the first `.` (SAML's copies) give the same answer for every value these flows mint.

### 2.4 Live bugs

**Bug 1: `OAuth.callback` consumes another purpose's token** (BEH-EA-057: "consuming a token created for one purpose MUST NOT satisfy a check for another purpose").

`callbackFlow` (`OAuth.ts:932-960`) decodes `state` with `decodeState`, which splits on the last `.` and checks no prefix, compares the `oauth_state` cookie with `state` (both attacker-controlled when the attacker drives their own browser), and calls `verification.consume(identifier, value)`. A miss on a **budgeted** live row spends one of its attempts (SOS-004, `Verification.ts`, the miss path of `claim`). Email-OTP rows are budgeted (`maxAttempts: 3`, `EmailOtp.ts:78`, identifier `email-otp:<normalised address>`). So:

```ts
// Repro (phase 0, packages/oauth/test/OAuth.test.ts): the victim requested a code; the attacker knows only the address.
const state = "email-otp:victim@example.com.000000";
for (let i = 0; i < 3; i++) {
  yield* oauth.callback("acme", { code: "x", state, iss: undefined, cookieState: state }).pipe(Effect.flip);
}
// Today: the victim's right code no longer verifies (three misses burned it), and three
// auth.token.replay events name the victim's identifier. EmailOtp's verifyByEmail budget
// (10 per 15 minutes, EmailOtp.ts:120-126) never saw these attempts; the callback is limited per IP only (:715-720).
// After phase 5: each callback fails "state-malformed" before consume; the victim's code still verifies.
```

Impact: a targeted, repeatable denial of email-OTP sign-in for any known address, past the per-address limiter whose job is exactly that, plus forged replay alarms. No token of another purpose can be *redeemed* this way (the flow payload check at `:961-964` refuses), so it is not an authentication bypass.

**Bug 2: `confirmReset` has no per-source budget, and spends a network call per request.**

`confirmReset`'s only rule is `"confirmReset"` on `Key.identifier` (`Password.ts:212-218`). The handler does not resolve the client address (`:746-752`, unlike `verifyEmail` `:754-766` and `confirmEmailChange` `:768-780`), and `PasswordShape.confirmReset`'s input has no `ip` (`:429-434`). A well-formed token with a fresh random public id gets a fresh bucket, passes the per-token limit, and reaches `checkPolicy` (`:1383`), which calls the breach API (`isBreached`, `:613-620`) because `breachCheck` defaults to `true` (`:311`). One source can therefore drive unbounded outbound HIBP calls (each up to `breachCheckTimeout`, 3 s) and unbounded claims. `verifyEmail` documents the rule this violates (APS-003, `:1496-1498`: "per-IP first — guards against a flood of garbage tokens before even attempting to decode one").

```ts
// Repro (phase 0, packages/password/test/Password.test.ts, mirroring "APS-003: verifyEmail is throttled per source IP", :1394)
for (let i = 0; i < 31; i++) {
  const forged = Redacted.make(`reset-password:${randomPublicId()}.wrong`);
  results.push(yield* password.confirmReset({ token: forged, password: strong, ip: "203.0.113.9" }).pipe(Effect.flip));
}
// Today: the input has no `ip` (compile error until phase 2 adds it) and all 31 are TokenConsumed;
// a counting HttpClient sees 31 breach-check requests.
// After phase 2: the 31st is RateLimited and the counting HttpClient sees at most 30.
```

**Inconsistency (not a bug): a foreign row settles two ways.** Rows 1–3 of §2.1 roll a foreign row back (it stays live until its TTL and its next presentation is not a replay); row 5 commits it. Plan 07 Q3 kept Password's rollback; plan 18 makes one rule (Q1).

### 2.5 The repeated `users.verifyEmail` mapping in Password

`users.verifyEmail(userId).pipe(Effect.catchTags({ UserNotFound: () => Defects.invariantViolation(...), IdentityMismatch: Effect.die }))` appears three times: `Password.ts:1458-1468` (`ResetTokenUserMissing`), `:1536-1545` (`VerifyEmailTokenUserMissing`), `:1635-1644` (`ChangeEmailUserMissing`). It is the "the link proved the mailbox" step of all three Password links. It stays Password's (it is a `Users` call, not a link concern) but becomes one module-private helper, `proveMailbox(userId, invariant)`.

### 2.6 Facts the design rests on (verified)

- `Verification.redeem`'s `use` runs inside the claim's transaction; a failure of `use` is settled by `onFailure` (default `rollback`); `commitUnlessUnavailable` spends on any typed refusal but `StoreUnavailable` (`core/src/Verification.ts:115-167`). A miss fails `Verification/TokenConsumed` and never runs `use`.
- `VerificationTokenView.userId: Option<UserId>` and `payload: unknown` (`Verification.ts:60-80`): the redeemer is the place that narrows them.
- `RateLimits.Budget.spend` checks the rule name and its input shape at compile time (`core/src/RateLimitModel.ts:199-207`); `Key.ip` accepts `{ ip?: string }` and keys `undefined` as `ip:unknown` (`core/src/RateLimitKey.ts:73-78`). A budget closure `(publicId) => limits.spend("confirmReset", { identifier: publicId })` is therefore fully checked where it is written.
- `Schema.decodeUnknownOption` and `Schema.Codec<T, E>` exist in rc.116 (`node_modules/effect/dist/Schema.d.ts:816`, `:1281`). Every payload these flows store is a plain struct whose `Type` equals its `Encoded`, so the redeemer stores the typed value verbatim and decodes it back with the same schema.
- `scripts/circular.mjs` fails type-only import cycles (`core/src/RateLimitModel.ts:7-9`). `VerificationLink.ts` imports `Verification.ts` and `Users.ts` only, as today; nothing here adds an edge back.
- The DomainWorld probe observes `Verification.redeem` (plan 07 decision 11). The redeemer still calls it, so REQ-EA-163's "one transaction" assertion is unaffected.

---

## 3. Target design

### 3.1 Purposes (`packages/core/src/VerificationLink.ts`)

```ts
/** What `use` receives: the purpose's own name (a literal, so links of two purposes never mix), the user, the payload. */
export interface Link<Name extends string, UserRef, Payload> {
  readonly purpose: Name;
  readonly userId: UserRef;
  readonly payload: Payload;
}

/**
 * BEH-EA-057: a purpose of a token that travels through a client. A value, shared by the code that
 * mints the token and the code that redeems it, so the payload written and the payload read are one
 * schema. Built only by `forUser`/`forAddress` (the `read`/`row` pair is derived there).
 */
export interface Purpose<Name extends string, L, IssueArgs> {
  readonly _tag: "VerificationLink/Purpose";
  readonly name: Name;
  /** How `issue` chooses the public id. `"user"`: one live link per user (issuing again supersedes). */
  readonly keyedBy: "random" | "user";
  /** A claimed row as `use` receives it; `None` is a foreign row (no user where one is required, a payload that does not decode, a user-keyed row whose user is not its public id). */
  readonly read: (token: VerificationTokenView, publicId: string) => Option.Option<L>;
  /** What `issue` writes for `args`. */
  readonly row: (args: IssueArgs) => { readonly userId: Option.Option<UserId>; readonly payload: unknown };
}

export type LinkOf<P> = P extends Purpose<string, infer L, unknown> ? L : never;
export type IssueArgsOf<P> = P extends Purpose<string, unknown, infer I> ? I : never;

/** A purpose whose every row names a user (`use` gets a `UserId`). */
export function forUser<const Name extends string>(spec: {
  readonly name: Name;
  readonly keyedBy?: "random" | "user";
}): Purpose<Name, Link<Name, UserId, undefined>, { readonly userId: UserId }>;
export function forUser<const Name extends string, A>(spec: {
  readonly name: Name;
  readonly keyedBy?: "random" | "user";
  readonly payload: Schema.Codec<A>;
}): Purpose<Name, Link<Name, UserId, A>, { readonly userId: UserId; readonly payload: A }>;

/** A purpose whose row may name no user yet (a link to an address that has no account). */
export const forAddress = <const Name extends string, A>(spec: {
  readonly name: Name;
  readonly payload: Schema.Codec<A>;
}) => /* Purpose<Name, Link<Name, Option<UserId>, A>, { readonly userId?: UserId | undefined; readonly payload: A }> */;
```

Notes for the executor:

- **No assertions.** Each constructor builds its `read`/`row` closures over its own concrete types and returns them through an annotated local (`const made: Purpose<…> = { … }; return made;`, the precedent in `RateLimitModel.ts`'s `build`), never `as`. `forUser`'s two overloads share one implementation whose `payload` parameter is `Schema.Codec<A> | undefined`; if the overload/implementation compatibility check rejects the `row` parameter (contravariant under `strictFunctionTypes`), declare `row` with method syntax in `Purpose` (bivariant), or give `forUser` two separate implementations behind the two names `forUser`/`forUserWith`. Either is legal; pick whichever type-checks with less code.
- `forUser`'s `read`: `Option.isNone(token.userId)` → `None`; `keyedBy === "user"` and `token.userId.value !== publicId` → `None`; payload: `Schema.decodeUnknownOption(spec.payload)(token.payload)` (or `undefined` with no schema) → `None` on a failed decode.
- `forAddress`'s `read`: `userId` passes through as the `Option`; the payload must decode.
- `row`: `{ userId: Option.some(args.userId), payload: args.payload }` (`forUser`), `{ userId: Option.fromNullishOr(args.userId), payload: args.payload }` (`forAddress`).

The purposes this plan declares:

```ts
// packages/password/src/Password.ts (module scope, replacing RESET_PURPOSE/VERIFY_PURPOSE at :541-542)
const ResetLink = VerificationLink.forUser({ name: "reset-password" });
const VerifyLink = VerificationLink.forUser({ name: "verify-email" });

// packages/core/src/EmailChange.ts (replacing `PURPOSE`'s role and `newEmailOf`)
export const PURPOSE = "change-email";
export const Link = VerificationLink.forUser({ name: PURPOSE, payload: Payload });

// packages/magic-link/src/MagicLink.ts (replacing PURPOSE/LinkPayload at :132-135)
const MagicLinkPurpose = VerificationLink.forAddress({
  name: "magic-link",
  payload: Schema.Struct({ email: Schema.String }),
});

// packages/two-factor/src/Challenge.ts (next to CHALLENGE_PURPOSE, which stays the name)
export const ChallengeLink = VerificationLink.forUser({
  name: CHALLENGE_PURPOSE,
  keyedBy: "user",
  payload: ChallengePayload,
});
```

The burn-first callers declare their purposes for the codec only (§3.6): `oauth.flow`, `oauth.exchange`, `saml-request`, `saml-logout`. The prefix strings stay byte-identical, so live tokens in flight keep working across the deploy.

### 3.2 Issuing (`VerificationLink.issue`, signature change)

```ts
/** Mints a row under `purpose` and returns the mailable token. Its public id is random, or the user's id for a user-keyed purpose. */
export const issue = <P extends Purpose<string, unknown, unknown>>(
  deps: { readonly verification: VerificationShape; readonly crypto: Crypto.Crypto },
  purpose: P,
  input: { readonly ttl: Duration.Duration } & IssueArgsOf<P>,
) =>
  Effect.gen(function* () {
    const { userId, payload } = purpose.row(input);
    const publicId =
      purpose.keyedBy === "user" && Option.isSome(userId)
        ? userId.value
        : yield* newPublicId(deps.crypto).pipe(
            Effect.catchTag("PlatformError", storeUnavailable("VerificationLink.issue")),
          );
    const { token, value } = yield* deps.verification.issue({
      identifier: identifierOf(purpose.name, publicId),
      ttl: input.ttl,
      ...(Option.isSome(userId) ? { userId: userId.value } : {}),
      ...(payload === undefined ? {} : { payload }),
    });
    const issued: IssuedLink<P["name"]> = {
      token: encodeFor(purpose, publicId, value),
      publicId,
      expiresAt: token.expiresAt,
      view: token,
    };
    return issued;
  });
```

- The return goes through an annotated local only to name `IssuedLink`'s purpose brand (§3.5), not to annotate the Effect.
- `purpose.row(input)` takes `IssueArgsOf<P>`; `input` is `{ ttl } & IssueArgsOf<P>`, which is assignable. If TS cannot see that through the deferred conditional, pass `purpose.row` the args as a separate parameter (`issue(deps, purpose, args, { ttl })`); it is still assertion-free.
- `SecondFactor.issueChallenge` becomes `VerificationLink.issue({ verification, crypto }, ChallengeLink, { ttl: config.challengeTtl, userId, payload })` and brands `issued.token` as `TwoFactorChallengeId`. That removes its hand-rolled `encode` (`SecondFactor.ts:447-455`).

### 3.3 Redeeming (`VerificationLink.redeemer`, new)

```ts
/** BEH-EA-057/ADR-EA-039: why a presented link was refused. Callers map it to one wire error; `reason` is for logs only. */
export class LinkRefused extends Data.TaggedError("VerificationLink/Refused")<{
  readonly purpose: string;
  /** `malformed`: not a token of this purpose (never decoded, never budgeted per token, the store untouched). `missed`: unknown, expired, spent or wrong secret. `foreign`: claimed, but the row is not one this purpose writes (spent). */
  readonly reason: "malformed" | "missed" | "foreign";
}> {}

/**
 * BEH-EA-105/APS-003: both budgets are declared where a link is bound. A link endpoint is public and
 * its token is attacker-supplied, so a missing budget must be a visible decision, not an omission.
 */
export interface LinkBudget<E, R> {
  /** Spent first, before the token is decoded (a flood of garbage), keyed on the request's source. `"caller"`: the endpoint already spent it; say where in a comment. */
  readonly source: ((ip: string | undefined) => Effect.Effect<void, E, R>) | "caller";
  /** Spent once the token is well-formed, keyed on its public id (never the secret), before the store is touched. `"none"`: this purpose's guesses are budgeted elsewhere; say where. */
  readonly token: ((publicId: string) => Effect.Effect<void, E, R>) | "none";
}

export const redeemer = <P extends Purpose<string, unknown, unknown>, EB = never, RB = never>(
  purpose: P,
  deps: { readonly verification: VerificationShape; readonly budget: LinkBudget<EB, RB> },
) => {
  const refused = (reason: LinkRefused["reason"]) => new LinkRefused({ purpose: purpose.name, reason });
  const source = deps.budget.source;
  const perToken = deps.budget.token;

  return <A, E, R, EP = never, RP = never>(
    presented: {
      readonly token: Redacted.Redacted<string> & PresentedFor<P["name"]>;
      readonly ip?: string | undefined;
    },
    use: (link: LinkOf<P>) => Effect.Effect<A, E, R>,
    options?: {
      /** How a typed failure of `use` settles (ADR-EA-039). A foreign row always commits, before this is asked. */
      readonly onFailure?: ((error: E) => Verification.Settlement) | undefined;
      /** Runs after both budgets and before the claim, outside the transaction: a check that must never burn the token or run network I/O inside it (`confirmReset`'s policy, ARF-002). */
      readonly beforeClaim?: Effect.Effect<void, EP, RP> | undefined;
    },
  ) =>
    Effect.gen(function* () {
      if (source !== "caller") yield* source(presented.ip);
      const decoded = decode(Redacted.value(presented.token), purpose);
      if (Option.isNone(decoded)) return yield* refused("malformed");
      if (perToken !== "none") yield* perToken(decoded.value.publicId);
      if (options?.beforeClaim !== undefined) yield* options.beforeClaim;
      return yield* deps.verification
        .redeem({
          identifier: decoded.value.identifier,
          value: decoded.value.value,
          use: (token) =>
            Option.match(purpose.read(token, decoded.value.publicId), {
              onNone: () => Effect.fail(refused("foreign")),
              onSome: use,
            }),
          onFailure: (error) =>
            error instanceof LinkRefused ? "commit" : (options?.onFailure?.(error) ?? "rollback"),
        })
        .pipe(Effect.catchTag("Verification/TokenConsumed", () => Effect.fail(refused("missed"))));
    });
};
```

The error channel is `LinkRefused | EB | EP | E | StoreUnavailable`, inferred. Notes:

- **No return-type annotation** on `redeemer` or on the function it returns; the generics carry the types. `Verification.Settlement` is plan 07's type.
- `error instanceof LinkRefused` narrows the `E | LinkRefused` the wrapped `use` can fail with, so `options.onFailure` only ever sees the caller's own `E` (no assertion). If TS does not narrow the generic `E` in the false branch, use `Predicate.isTagged(error, "VerificationLink/Refused")` with a module-private guard `(e: E | LinkRefused): e is LinkRefused`.
- `LinkOf<P>` is the `L` of `purpose.read`, so `onSome: use` type-checks without a cast.
- The order is fixed for every caller: source budget → decode → per-token budget → `beforeClaim` → claim. It matches today's order for callers 2–4, adds the source budget to caller 1, and puts caller 1's policy check where it is now.

### 3.4 The five callers after

```ts
// Password.make (each bound once; `limits` is the plugin's budget, plan 06)
const resetLinks = VerificationLink.redeemer(ResetLink, {
  verification,
  budget: {
    source: (ip) => limits.spend("confirmResetByIp", { ip }),        // new rule (§4 phase 2)
    token: (publicId) => limits.spend("confirmReset", { identifier: publicId }),
  },
});
const verifyLinks = VerificationLink.redeemer(VerifyLink, {
  verification,
  budget: {
    source: (ip) => limits.spend("verifyEmailByIp", { ip }),
    token: (publicId) => limits.spend("verifyEmail", { identifier: publicId }),
  },
});
const emailChangeLinks = VerificationLink.redeemer(EmailChange.Link, {
  verification,
  budget: {
    source: (ip) => limits.spend("confirmEmailChangeByIp", { ip }),
    token: (publicId) => limits.spend("confirmEmailChange", { identifier: publicId }),
  },
});

/** ARF-008/FAMS-002: the link proved the mailbox; a missing user is an invariant, an identity mismatch a defect. */
const proveMailbox = (userId: Users.UserId, invariant: string) =>
  users.verifyEmail(userId).pipe(
    Effect.catchTags({
      UserNotFound: () => Defects.invariantViolation(invariant, `awthaq: ${invariant}`),
      IdentityMismatch: Effect.die,
    }),
  );

const refusedToken = () => Effect.fail(new PasswordApi.TokenConsumed());

const confirmReset: PasswordShape["confirmReset"] = Effect.fnUntraced(function* (input) {
  const config = yield* configNow;
  const userId = yield* resetLinks(
    { token: input.token, ip: input.ip },
    ({ userId }) =>
      Effect.gen(function* () {
        yield* beforeCredentialReset.run(/* unchanged, :1415-1434 */);
        const account = /* unchanged, :1436-1449 (a credential-less account is a dead token: TokenConsumed, rollback) */;
        const hash = yield* hasher.hash(input.password);
        yield* accounts.updateCredentialHash(account.id, Redacted.make(hash)).pipe(Effect.orDie);
        yield* proveMailbox(userId, "ResetTokenUserMissing");
        yield* sessions.revokeAll(userId, "passwordReset");
        return userId;
      }),
    {
      // ARF-002: decided before the token is touched; no network I/O inside the transaction.
      beforeClaim: checkPolicy(httpClient, crypto, input.password, config).pipe(
        Effect.flatMap((hints) =>
          hints.length > 0 ? Effect.fail(new PasswordApi.WeakPassword({ hints })) : Effect.void,
        ),
      ),
    },
  ).pipe(Effect.catchTag("VerificationLink/Refused", refusedToken));
  yield* events.publish({ _tag: "auth.password.resetCompleted", userId });
});

const verifyEmail: PasswordShape["verifyEmail"] = Effect.fnUntraced(function* (input) {
  const userId = yield* verifyLinks(input, ({ userId }) =>
    proveMailbox(userId, "VerifyEmailTokenUserMissing").pipe(Effect.as(userId)),
  ).pipe(Effect.catchTag("VerificationLink/Refused", refusedToken));
  yield* events.publish({ _tag: "auth.user.emailVerified", userId });
});

const confirmEmailChange: PasswordShape["confirmEmailChange"] = Effect.fnUntraced(function* (input) {
  const changed = yield* emailChangeLinks(input, ({ userId, payload }) =>
    Effect.gen(function* () {
      const before = /* unchanged, :1624-1626 */;
      yield* users.changeEmail(userId, payload.newEmail).pipe(/* unchanged, :1627-1633 */);
      yield* proveMailbox(userId, "ChangeEmailUserMissing");
      yield* sessions.revokeAll(userId, "emailChanged");
      return { userId, previous: Users.emailOf(before) };
    }),
  ).pipe(Effect.catchTag("VerificationLink/Refused", refusedToken));
  /* the event and the previous-address mail, unchanged (:1658-1667) */
});
```

```ts
// MagicLink.make
const links = VerificationLink.redeemer(MagicLinkPurpose, {
  verification,
  budget: {
    source: (ip) => limits.spend("verifyByIp", { ip }),
    token: (publicId) => limits.spend("verifyByToken", { identifier: publicId }),
  },
});

const verify: MagicLinkShape["verify"] = Effect.fnUntraced(function* (input, context) {
  const refused = /* unchanged, :293-301 */;
  return yield* links(
    input,
    ({ userId, payload }) =>
      channel.complete({
        strategy: "magicLink",
        amr: ["email"],
        email: Option.some(payload.email),
        userId,
        allowSignUp: settings.allowSignUp,
        ip: input.ip,
        userAgent: context?.userAgent,
      }),
    { onFailure: Verification.commitUnlessUnavailable },
  ).pipe(
    Effect.catchTag("VerificationLink/Refused", () => refused),
    Effect.catchTag("MagicLink/ChannelInvalid", (invalid) =>
      Channel.logInvalid("magicLink", invalid).pipe(Effect.andThen(refused)),
    ),
  );
});
```

`Channel.complete`'s `email` stays an `Option` (EmailOtp passes one too); MagicLink now always passes `Some`, because a magic-link row whose payload does not decode is refused as `foreign` instead of signing in by `userId` alone. No such row is ever written (`requestLink` always writes `{ email }`).

```ts
// SecondFactor.layer
const challenges = VerificationLink.redeemer(ChallengeLink, {
  verification,
  budget: {
    source: "caller", // TwoFactor.attempt spends "verifyByIp" before redeemChallenge (TwoFactor.ts:582)
    token: "none", // a wrong code is charged to the per-account failure budget (BCR-006, recordFailure)
  },
});

const redeemChallenge: SecondFactorShape["redeemChallenge"] = (challengeId, use) =>
  challenges({ token: challengeId }, ({ userId, payload }) =>
    use({
      userId,
      strategy: payload.strategy,
      amr: payload.amr.filter(Sessions.isAuthMethod),
      attempt: payload.attempt,
      handoff: payload.handoff,
    }),
    { onFailure: Verification.commitUnlessUnavailable },
  ).pipe(Effect.catchTag("VerificationLink/Refused", () => Effect.fail(new InvalidTwoFactorCode({}))));
```

`SecondFactorShape.redeemChallenge`'s signature is unchanged (`SecondFactor.ts:157-160`), so `TwoFactor.attempt`, the tests and the BDD steps that call it do not change.

### 3.5 What the compiler now refuses

1. **A payload written in one shape and read in another.** `issue(deps, EmailChange.Link, { ttl, userId, payload: { email: x } })` is a type error (the purpose's payload is `{ newEmail }`), and `use` receives `payload.newEmail: string`, not `unknown`.
2. **A required user that is not there.** `issue(deps, ResetLink, { ttl })` is a type error (`userId` is required), and `use` receives `userId: UserId`, so the three hand-written `Option.isNone(consumed.userId)` checks are gone.
3. **A link of one purpose applied as another's.** `LinkOf<typeof ResetLink>` is `Link<"reset-password", UserId, undefined>`; a helper typed for `Link<"verify-email", …>` does not accept it.
4. **A token minted for purpose A, handed in-process to purpose B's redeemer.** `IssuedLink<Name>`'s `token` carries the phantom `{ readonly "~linkPurpose"?: Name }` (the repo's `"~input"` precedent, `RateLimitModel.ts`); the redeemer's `token` parameter is `Redacted<string> & PresentedFor<P["name"]>` with `PresentedFor<N> = { readonly "~linkPurpose"?: N }`. A token from the wire has no such key and is accepted (and checked at run time by `decode`); a token minted for `"reset-password"` passed to the `"verify-email"` redeemer has `"~linkPurpose": "reset-password"`, which is not assignable to `"verify-email"`. This covers tests, BDD steps and any in-process handoff (Q4).
5. **A link endpoint with no budget decision.** `LinkBudget` has two required members; `"caller"` and `"none"` are the only ways to opt out, and both read as a decision in review.

What stays a run-time check, necessarily: a token presented over HTTP is an unbranded string, so the purpose prefix is checked by `decode`, before any budget or store call (`malformed`).

### 3.6 The shared codec for burn-first tokens

`decode` takes the purpose value (structurally, `{ readonly name: string }`), so the burn-first callers use it without a redeemer:

```ts
// packages/oauth/src/OAuth.ts (replacing encodeState/decodeState and their comment, :150-171).
// Codec-only purposes: a name record, because these tokens are minted and consumed by hand (burn-first).
const FLOW = { name: "oauth.flow" } as const;
const EXCHANGE = { name: "oauth.exchange" } as const;

// callbackFlow, :943: the prefix is checked before consume, exactly like `exchange` (:1339).
const decoded = VerificationLink.decode(input.state, FLOW);
// ... cookie comparison unchanged ...
if (Option.isNone(decoded)) return yield* CallbackFailure.callbackFailed("state-malformed");
```

- `FLOW_PREFIX`/`EXCHANGE_PREFIX` (`:143`, `:197`) become these names (`identifierOf` appends the `:`). `authorize` (`:888`) and the native exchange mint (`:1288-1302`) build their identifiers with `VerificationLink.identifierOf(FLOW.name, uuid)` and their state with `VerificationLink.encode`. Their payloads keep their own schemas (`FlowPayloadSchema` `:183`, `ExchangePayloadSchema` `:207`) and decoders: the flow state carries encrypted fields and an `orDie` at the mint (`:918-920`) that this plan does not touch, so a full `forAddress`/`forUser` purpose for them is left to Q3.
- SAML: `Saml.ts:955-961` and `SamlSlo.ts:429-434` become `VerificationLink.decode(cookie, REQUEST)` / `decode(cookie, LOGOUT)` (`{ name: "saml-request" }`, `{ name: "saml-logout" }`) with the same failure reasons (`requestStateMalformed`, `logoutStateMalformed`); `:945` and `:210` use `VerificationLink.encode`. `REQUEST_PREFIX`/`LOGOUT_PREFIX` (`Saml.ts:110`, `SamlSlo.ts:50`) become these names without the trailing `:`.
- `consume` and every reason code stay as they are (ADR-EA-039 decision 6).

### 3.7 What stays outside the module

- The `Verification` transaction, the miss record and the give-back (plan 07).
- Each caller's state change (`use`), its own dead-token refusals inside `use` (a credential-less account, an account deleted since the change-email request), and their settlement (default `rollback`, plan 07 Q3).
- Mapping `LinkRefused` to the wire error, and MagicLink's `auth.user.signInFailed` publish.
- `mailData` and the mail itself.
- The rule tables: the redeemer receives closures over the plugin's own budget; it never names a rule.

---

## 4. Phased migration

Every phase gate is `pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`; phases 2–5 also run `pnpm test:bdd`. Plan gate: `pnpm check`. No SQL adapter changes, so `pnpm test:pg` is not required (run it if the executor has a Postgres; the Verification paths are already covered by plan 07). One ticket per phase under `.scratch/verification-link-redeem/issues/`.

**Preconditions:** re-run the §2.1 and §2.3 greps; a new `VerificationLink.decode`, `verification.redeem` or hand-rolled `<identifier>.<secret>` parser is classified the same way before phase 6 closes.

### Phase 0: failing tests that pin the two bugs

1. `packages/oauth/test/OAuth.test.ts`: `"BEH-EA-057: a callback state naming another purpose's token is refused before consume, and spends nothing of it"`. Build an email-OTP row with `maxAttempts: 3` directly through `Verification.issue` (identifier `email-otp:victim@example.com`, `format: { _tag: "Numeric", digits: 6 }`), call `callback` three times with `state = cookieState = "email-otp:victim@example.com.000000"`, then assert the right value still redeems (`verification.consume`) and no `auth.token.replay` names the identifier. Fails today.
2. `packages/password/test/Password.test.ts`: `"APS-003: confirmReset is throttled per source IP across distinct, unrelated tokens"`, next to `:1394`, with a counting `HttpClient` (wrap the `httpClientReturning` helper the file imports at `:32` and uses at `:926`) and `breachCheck: true`. Thirty forged well-formed tokens from one `ip` answer `TokenConsumed`, the 31st `RateLimited`, and the client counted at most 30 breach requests. It cannot be written red today, because `confirmReset` takes no `ip` (a type error, not a failing test). Write it first in phase 2, before the rule and the input field (the TDD order inside that phase); phase 0 instead adds the in-process half: `"APS-003: one source's forged reset tokens each reach the breach check"`, which asserts today's behaviour (31 breach requests for 31 forged tokens with no `ip`) and is **deleted** in phase 2 when the per-source test replaces it.

Gate: test 1 fails for the stated reason; test 2's in-process half passes (it pins today's bug); nothing else changes.

### Phase 1: purposes, typed `issue`, `redeemer` (core)

Files:

1. `packages/core/src/VerificationLink.ts`: `Link`, `Purpose`, `LinkOf`, `IssueArgsOf`, `forUser`, `forAddress` (§3.1); `issue` takes a purpose (§3.2); `LinkRefused`, `LinkBudget`, `redeemer` (§3.3); `IssuedLink<Name>` and `PresentedFor<N>` (§3.5 item 4); `decode(raw, purpose: { readonly name: string })` (same body, `purpose.name`). Rewrite the header comment (`:1-17`) to name the redeemer and ADR-EA-039 decision 9.
2. `packages/core/src/EmailChange.ts`: `Link` (§3.1), `request` issues through it; delete `newEmailOf` and `decodePayload` (`:38-43`). Update the header comment (`:11-12`: "that half lives with the confirming endpoint" → "the confirming endpoint redeems `EmailChange.Link`").
3. Mint call sites move to the typed `issue` (mechanical): `Password.ts:1078-1081` (`VerifyLink`), `:1329-1332` (`ResetLink`), `MagicLink.ts:266-274` (`MagicLinkPurpose`). Declare `ResetLink`, `VerifyLink` and `MagicLinkPurpose`; `RESET_PURPOSE`/`VERIFY_PURPOSE`/`PURPOSE` stay until their decode call sites move in phases 2–3 (then they are deleted).
4. `packages/admin/test/AdminAccounts.test.ts:281-289`: `EmailChange.newEmailOf(consumed.payload)` → `Schema.decodeUnknownOption(EmailChange.Payload)(consumed.payload)`.
5. `packages/core/test/VerificationLink.test.ts`: the redeemer suite (§5.1) and the typed `issue` cases; `packages/core/test/VerificationLink.types.test.ts` (new, §5.2).
6. `.changeset/verification-link-redeemer.md` (`@awthaq/core` minor, `@awthaq/password`, `@awthaq/magic-link`, `@awthaq/admin` patch). Text in §6.4.

Gate: the phase gate. Password, MagicLink and SecondFactor still redeem by hand; all their tests pass unchanged.

### Phase 2: Password

1. `packages/password/src/Password.ts`
   - Rules: add `confirmResetByIp` next to `confirmReset` (`:212-218`): `{ group: "password", endpoint: "confirmReset", key: RateLimits.Key.ip, limit: 30, window: minutes15 }`, the numbers of `verifyEmailByIp` (`:266`) (Q2).
   - `PasswordShape.confirmReset` input (`:429-434`) gains `readonly ip?: string | undefined`; the `confirmReset` handler (`:746-752`) takes `request` and resolves the client address exactly as `verifyEmail` does (`:754-766`).
   - The three redeemers and `proveMailbox` in `make` (§3.4). `confirmReset` (`:1365-1493`), `verifyEmail` (`:1495-1556`) and `confirmEmailChange` (`:1598-1669`) become the §3.4 bodies. Delete `RESET_PURPOSE`, `VERIFY_PURPOSE`, the `:539-542` comment's codec sentence (now "the purposes are `ResetLink`/`VerifyLink`, redeemed through `VerificationLink.redeemer`"), the three `Option.isNone(consumed.userId)` checks and the `EmailChange.newEmailOf` check.
   - `limits.spend("verifyEmailByIp", input)` (`:1499`) and `limits.spend("confirmEmailChangeByIp", input)` (`:1602`) move into the redeemers; the comments at `:1496-1498` and `:1600-1601` move to the binding.
2. `packages/password/test/Password.test.ts`: the phase 0 test 2 (now compiling); delete the tests listed in §5.3.
3. `packages/password/test/PasswordRecovery.test.ts`, `PasswordChangeEmail.test.ts`: delete the tests listed in §5.3.
4. `packages/password/test/PasswordRateLimitBehaviour.test.ts:27`: passes unchanged (it reads every key a flow consumes against the registry, so `confirmResetByIp` is covered once it is registered).
5. Spec: `15-password.md` (BEH-EA-117 per-source rule, BEH-EA-118 foreign rows), `14-rate-limiting.md:161` ("17 rules" → "18 rules"). §6.1.
6. `.changeset/password-link-redeemer.md` (`@awthaq/password` minor). §6.4.

Gate: the phase gate and `pnpm test:bdd` (REQ-EA-163/164/165/688/693 and the `15-password.feature` cross-purpose scenarios pass unchanged).

### Phase 3: MagicLink

1. `packages/magic-link/src/MagicLink.ts`: the redeemer and `verify` (§3.4); delete `PURPOSE`, `LinkPayload`, `decodePayload` (`:132-135`, `:247`) and the inline budget spends (`:290`, `:303`). Update the header comment (`:15-19`): "Decode, purpose-check, budget and redeem through `VerificationLink.redeemer` around `Channel.complete`".
2. `packages/magic-link/test/MagicLink.test.ts`: delete the tests listed in §5.3. The happy path (`:125-149`) keeps its replay assertion as the caller's mapping test.
3. Spec `32-magic-link.md` BEH-EA-270 (§6.1).

### Phase 4: two-factor

1. `packages/two-factor/src/Challenge.ts`: `ChallengeLink` (§3.1). `CHALLENGE_PURPOSE` stays (its name; the tests and `TwoFactorSteps.ts:472/561/613` forge identifiers with it).
2. `packages/two-factor/src/SecondFactor.ts`: `issueChallenge` over `VerificationLink.issue(…, ChallengeLink, …)` (§3.2); `redeemChallenge` over the redeemer (§3.4); delete `decodePayload` (`:459`).
3. `packages/two-factor/test/TwoFactor.test.ts`: delete the tests listed in §5.3; `:276` stays as the mapping test.
4. Spec `31-two-factor.md` BEH-EA-262 (§6.1), ADR-EA-020 rev 1.4 (§6.2).

### Phase 5: the burn-first codec

1. `packages/oauth/src/OAuth.ts`: `FLOW`, `EXCHANGE`; delete `encodeState`/`decodeState` and their comment (`:150-171`); `callbackFlow` decodes with the purpose (§3.6), which makes the phase 0 test 1 pass; `exchange` (`:1335-1341`) loses its now-redundant `startsWith` check (the decode is the check). Keep both reason codes.
2. `packages/saml/src/Saml.ts`, `SamlSlo.ts`: §3.6.
3. Spec `16-oauth.md` BEH-EA-122 (§6.1).
4. `.changeset/oauth-callback-purpose.md` (`@awthaq/oauth` patch, `@awthaq/saml` patch). §6.4.

Gate: the phase gate; `packages/oauth/test/*` and `packages/saml/test/*` pass unchanged plus the phase 0 test.

### Phase 6: docs, gates, sweep

1. `docs/plugin-authoring.md:167`: prepend "A token you mail or hand to a client: declare a purpose (`VerificationLink.forUser`/`forAddress`), mint it with `VerificationLink.issue`, and redeem it through a `VerificationLink.redeemer` bound in `make` with both budgets declared; reach for `Verification.redeem` directly only for a value that is not a link (an emailed code)."
2. `features/step-definitions/CompileTimeGates.ts`: the `// type-gate: verification-link-purpose` block (§5.4) and its scenario.
3. ADR-EA-039 rev 1.1, glossary, `spec/traceability.md`, `features/traceability.md` (§6).
4. Sweep: `grep -rn 'VerificationLink.decode' packages/*/src` lists only the four burn-first sites; `grep -rn 'verification\.redeem\|\.redeem({' packages/*/src` lists only `VerificationLink.ts` and `EmailOtp.ts`; `grep -rnE 'lastIndexOf\("\."\)|indexOf\("\."\)' packages/{oauth,saml}/src` finds no token parser.
5. `pnpm check`, `pnpm spec:verify:strict`, `pnpm check:error-tags` (the new `VerificationLink/Refused` tag), `pnpm check:readmes`.

---

## 5. Test plan

The rule is **replace, don't layer**: the link protocol (purpose check, both budgets, the `beforeClaim` order, foreign rows, the single refusal) is tested once at the redeemer over the memory `Verification`; each caller keeps one test that its refusal maps to its wire error, and the tests of its own state change.

### 5.1 `packages/core/test/VerificationLink.test.ts` (new `describe("VerificationLink.redeemer")`)

Over `TestLayer` (`:18-24`, the memory `Verification` with events and audit). A recording budget (`Ref<ReadonlyArray<string>>` of `"source:<ip>"`/`"token:<publicId>"`) and a recording `beforeClaim` witness the order.

1. `BEH-EA-057: a well-formed token of the purpose runs use with the typed link and spends it; presenting it again is refused missed`.
2. `BEH-EA-057: a malformed token is refused malformed after the source budget and before the token budget, and the store is untouched`: a table of `""`, `"nonsense"`, `"."`, `"reset-password:"`, `"reset-password:.s"`, `"reset-password:abc."`; assert the recording budget saw `source` only and no `auth.token.replay` was published.
3. `BEH-EA-057/ARF-007: a token of another purpose is refused malformed before anything is spent, and still redeems for its own purpose`.
4. `APS-003: the budgets run source, then token keyed on the public id (never the secret), then beforeClaim, then the claim`.
5. `APS-003: a budget refusal surfaces as the budget's own error and leaves the token live`.
6. `ARF-002: a beforeClaim failure surfaces as itself and leaves the token live`.
7. `a required-subject row with no user is refused foreign and spent: the next presentation is refused missed` (mint the row with `Verification.issue` directly, without `userId`).
8. `a row whose payload does not decode is refused foreign and spent`.
9. `a user-keyed purpose keeps one live link per user: the earlier link is refused missed after a second issue`.
10. `a user-keyed link presented under another user's public id is refused missed, and the owner's link still redeems` (the forged-identifier case of `TwoFactor.test.ts:299`).
11. `ADR-EA-039: a refusal from use settles as the caller says (rollback by default: the token redeems again; commit: spent), and onFailure never sees LinkRefused`.
12. `an expired link is refused missed` (`TestClock.adjust` past the TTL).
13. `a forAddress link with no user hands use None, and its payload typed`.
14. `issue: a random-keyed purpose mints distinct public ids; a user-keyed one uses the user id; the payload round-trips through redeem` (replaces the existing `VerificationLink.issue` describe's two tests at `:67-96`, which test the string-purpose signature).

The `encode`/`decode` describe (`:26-65`, three tests) stays, with `decode`'s second argument a purpose. `mailData` (`:98-118`) stays.

### 5.2 `packages/core/test/VerificationLink.types.test.ts` (new, `expectTypeOf` + `@ts-expect-error`, the `TwoFactor.types.test.ts` pattern)

- `issue(deps, ResetLink, { ttl })` is an error (no `userId`).
- `issue(deps, EmailChange.Link, { ttl, userId, payload: { email: "x" } })` is an error.
- `redeemer(ResetLink, …)`'s `use` parameter is `Link<"reset-password", UserId, undefined>`; `forAddress`'s is `Link<…, Option<UserId>, …>`.
- A function typed `(link: LinkOf<typeof VerifyLink>) => …` does not accept a `LinkOf<typeof ResetLink>`.
- An `IssuedLink<"reset-password">["token"]` passed to the `VerifyLink` redeemer is an error; a plain `Redacted<string>` is accepted.
- `redeemer(ResetLink, { verification, budget: { source: "caller" } })` is an error (no `token` declaration).

### 5.3 Caller tests deleted (ten), by name

They re-test the link protocol through one flow each; §5.1 covers them once.

- `packages/password/test/Password.test.ts`
  - `:882` "BEH-EA-059/118: replaying an already-consumed reset token fails with TokenConsumed" (§5.1 item 1; the wire mapping stays in `AuthHttp.test.ts:347`)
  - `:906` "confirmReset rejects a malformed token (no embedded identifier) with TokenConsumed" (item 2; wire: `AuthHttp.test.ts:413`)
- `packages/password/test/PasswordRecovery.test.ts`
  - `:30` "a verify-email token presented to confirmReset fails TokenConsumed and stays usable for verifyEmail" (item 3)
  - `:54` "a reset token presented to verifyEmail fails TokenConsumed and stays usable for confirmReset" (item 3)
- `packages/password/test/PasswordChangeEmail.test.ts`
  - `:174` "the token is single-use" (item 1)
  - `:203` "a token of another purpose is refused, and a change-email token cannot verify an address" (items 2, 3)
- `packages/magic-link/test/MagicLink.test.ts`
  - `:169` "an expired link fails MagicLinkConsumed" (item 12)
  - `:179` "a token of another purpose, or garbage, is refused before anything is consumed" (items 2, 3)
- `packages/two-factor/test/TwoFactor.test.ts`
  - `:299` "a challenge issued for user A cannot be spent as user B's" (item 10)
  - `:323` "a second divert supersedes the first challenge (one live challenge per account)" (item 9)

Kept as each caller's single mapping or wiring test: `AuthHttp.test.ts:347` and `:413` (Password, on the wire), `Password.test.ts:1354` (the per-token rule is `verifyEmail`'s), `:1394` (its per-source rule), the new `confirmReset` per-source test (phase 0 test 2), `MagicLink.test.ts:125` (happy path and replay), `TwoFactor.test.ts:276` (replay maps to `InvalidTwoFactorCode` and publishes `auth.token.replay`), `:346` (the challenge TTL is `challengeTtl`). `PasswordRecovery.test.ts:160` ("credential-less user fails TokenConsumed") stays: it is a dead token *inside* `use`, Password's own rule.

Net: 10 deleted, 14 added in core (§5.1) plus the types file, 2 added in callers (phase 0).

### 5.4 BDD (`features/`)

- Unchanged and passing: `08-verification-tokens.feature` rule BEH-EA-057 (`:11-24`), `32-magic-link.feature:132-139` (another purpose), the `15-password.feature` cross-purpose scenarios, REQ-EA-163 (the DomainWorld probe still sees `Verification.redeem`), `31-two-factor.feature`'s forged-challenge scenario (`TwoFactorSteps.ts:561`).
- New, under `08-verification-tokens.feature` rule BEH-EA-057:
  - "A link of one purpose cannot be minted with another's payload or redeemed as another's" — the `assertTypeGate` step over `// type-gate: verification-link-purpose` in `CompileTimeGates.ts` (the §5.2 errors, minus the ones only a types test can phrase).
- New, under `16-oauth.feature` rule BEH-EA-122: "A callback state naming another purpose's token is refused before anything is consumed" (`OAuthSteps`, the phase 0 test 1 as a scenario).
- New, under `15-password.feature` rule BEH-EA-117: "Confirming resets is throttled per source" (the phase 0 test 2 as a scenario, through `PasswordWorld`).
- REQ ids: the next free ones at execution time (above `REQ-EA-1306` today; siblings also allocate, so re-check `features/traceability.md`).

---

## 6. Spec, ADR, traceability and changesets

### 6.1 Behaviour specs (Document Control revision and change-history line each)

- `spec/behaviors/08-verification-tokens.md` → rev 1.8. BEH-EA-057 (`:36`): replace "built and parsed only by `VerificationLink` … before any rate limit or consume" with: "A purpose is a value (`VerificationLink.forUser`/`forAddress`: its name, its payload schema, whether its row names a user, and whether its public id is random or the user's), shared by the code that mints a token (`VerificationLink.issue`) and the code that redeems it (`VerificationLink.redeemer`). The redeemer spends the endpoint's per-source budget, decodes the token for exactly its purpose, spends the per-token budget keyed on the public id, and claims it through `Verification.redeem`; a malformed or other-purpose token is refused before the token budget and the store, a row that is not one the purpose writes is refused and spent, and every refusal is one `VerificationLink/Refused` (`malformed`, `missed`, `foreign`). Tokens that are spent on purpose (OAuth and SAML request state, the native exchange code) are decoded by the same codec before `consume`, so no endpoint consumes another purpose's token."
- `spec/behaviors/15-password.md` → rev 1.6. BEH-EA-117 requirement (`:113-123`): add "`confirmReset` MUST be rate limited per source before the token is decoded, and per token before the policy is evaluated." BEH-EA-118: "a token whose row names no user is spent and answered `TokenConsumed`."
- `spec/behaviors/14-rate-limiting.md` → rev 1.4. `:161`: "17 rules" → "18 rules", adding "reset confirmation per source".
- `spec/behaviors/32-magic-link.md` → rev 1.3. BEH-EA-270 (`:101`): "The link's purpose is `magic-link` (`VerificationLink.forAddress`, payload `{ email }`), redeemed through `VerificationLink.redeemer`; a row whose payload does not decode is refused and spent."
- `spec/behaviors/31-two-factor.md` → rev 1.8. BEH-EA-262: "The challenge is a user-keyed link purpose (`two-factor-challenge`, `VerificationLink.forUser({ keyedBy: "user" })`): its public id is the user id, so issuing supersedes the account's live challenge, and a row whose user is not its public id is refused."
- `spec/behaviors/16-oauth.md` → rev 1.4. BEH-EA-122: "`callback` and `exchange` decode their state with the shared purpose codec (`oauth.flow`, `oauth.exchange`) before `consume`; a state naming another purpose's identifier is `state-malformed` and spends nothing."
- `spec/glossary.md` → rev 1.6: new entry **Link purpose**: "A `VerificationLink` value naming one purpose of a client-held `Verification` token: its name, payload schema, subject (a user is required, or optional) and how its public id is chosen. Minting and redeeming one flow share it. See BEH-EA-057, ADR-EA-039." VerificationToken: "consumed exactly once, through `Verification.redeem` (a link through `VerificationLink.redeemer`), …".

### 6.2 Decisions

- **ADR-EA-039 rev 1.1** (`spec/decisions/039-verification-redeem.md`), no new ADR (the redeemer is the link half of the same protocol). Change history: "1.1 (date): decision 9, mailed links redeem through `VerificationLink.redeemer` (plan 18)". Add:
  - **Decision 9. A presented link redeems through `VerificationLink.redeemer`.** A purpose is a value; the redeemer is bound once per purpose with a declared per-source and per-token budget, and owns the order source budget → decode → token budget → `beforeClaim` → claim, the foreign-row refusal (spent), and the one `VerificationLink/Refused`. A link's `use` receives `Link<Name, User, Payload>`, never a raw `VerificationTokenView`. `Verification.redeem` is called directly only for a value that is not a link (an emailed code).
  - Decision 7 (callers): name the redeemer for the five link callers.
  - Alternatives: (f) a `redeemLink` *member* of `VerificationShape` — rejected: the link is a codec and a budget over the interface, it needs no store primitive, and a member would give every `Verification` test double a link concern; (g) purpose names as a declaration-merged registry interface (compile-time collision check) — rejected for now: the repo has no module-augmentation precedent and no collision has a caller (Q6); (h) budgets passed per call — rejected: the binding is where a missing budget is visible in review, and the per-call `ip` is the only request fact it needs.
  - Consequences: one more `catchTag` per caller instead of three checks; the foreign-row settlement is uniform (Q1).
- **ADR-EA-020 rev 1.4**: decision 2 adds "the challenge is a user-keyed `VerificationLink` purpose; `redeemChallenge` redeems through its redeemer".
- **ADR-EA-016**: no change.

### 6.3 Traceability

- `spec/traceability.md` → rev 1.33: add a row for `packages/core/test/VerificationLink.test.ts` (today there is none): "BEH-EA-057: the purpose codec; typed `issue` (random and user-keyed public ids, payload round trip); the redeemer's budget order, malformed/other-purpose refusal before the store, foreign rows spent, `onFailure` never seeing `LinkRefused`, expiry; ADR-EA-039 decision 9" and `VerificationLink.types.test.ts`. Update the ADR-EA-039 row (`:181`) to list both. Update the `TwoFactor.test.ts` row (`:304`) and the Password/MagicLink rows to drop the moved cases. Add the `OAuth.test.ts` cross-purpose case to the BEH-EA-122 row and the new `Password.test.ts` per-source case to BEH-EA-117.
- `features/traceability.md`: the three new REQ rows (§5.4).

### 6.4 Changesets (ADR-EA-034: each with a `Migration:` line naming ADR and BEH ids)

- Phase 1, `.changeset/verification-link-redeemer.md`, `"@awthaq/core": minor`, `"@awthaq/password": patch`, `"@awthaq/magic-link": patch`, `"@awthaq/admin": patch`:

  > A client-held `Verification` token has a typed purpose (`VerificationLink.forUser`/`forAddress`), minted with `VerificationLink.issue(deps, purpose, input)` and redeemed through `VerificationLink.redeemer(purpose, { verification, budget })`, which owns the per-source and per-token budgets, the purpose check, the foreign-row refusal and one `VerificationLink/Refused` (ADR-EA-039 decision 9, BEH-EA-057).
  >
  > Migration: `VerificationLink.issue(deps, { purpose: "x", ttl, userId, payload })` → declare `const X = VerificationLink.forUser({ name: "x", payload })` and call `VerificationLink.issue(deps, X, { ttl, userId, payload })`. `VerificationLink.decode(raw, "x")` → `decode(raw, X)`. `EmailChange.newEmailOf` is gone: decode with `EmailChange.Payload`, or redeem `EmailChange.Link`.
- Phase 2, `.changeset/password-link-redeemer.md`, `"@awthaq/password": minor`:

  > `POST /reset-password/confirm` is rate limited per source (`confirmResetByIp`, 30 per 15 minutes) before the token is decoded, so a flood of forged tokens no longer reaches the breach check (BEH-EA-117, APS-003). A reset, verify-email or change-email token whose row names no user is now spent rather than left live (BEH-EA-118).
  >
  > Migration: `Password.confirmReset` takes an optional `ip`; a host calling it in-process passes the client address to keep the per-source budget meaningful. Tune with `RateLimits.tune(Password, { confirmResetByIp: { … } })`.
- Phase 3/4: no separate changeset beyond phase 1's patch entries (no interface change); add `"@awthaq/two-factor": patch` to phase 1's file when phase 4 lands, or a one-line `.changeset/two-factor-challenge-link.md` ("the challenge is a user-keyed link purpose; no change for callers").
- Phase 5, `.changeset/oauth-callback-purpose.md`, `"@awthaq/oauth": patch`, `"@awthaq/saml": patch`:

  > `OAuth.callback` refuses a `state` that names another purpose's verification token before consuming it, so a crafted state can no longer spend another flow's attempts (BEH-EA-057, BEH-EA-122). OAuth and SAML state use the shared `VerificationLink` codec.
  >
  > Migration: none.

---

## 7. Risks, mitigations, rollback

| Risk | Mitigation |
|---|---|
| **Generic inference of the redeemer** (`LinkOf<P>`, the `E | LinkRefused` narrowing, `IssueArgsOf<P>` through the deferred conditional) fails, tempting an `as` | The notes in §3.1–§3.3 give assertion-free fallbacks (method-syntax `row`, a module-private type guard, args as a separate parameter). Phase 1 lands the types test first, so a fallback is chosen before any caller migrates |
| **Behaviour change: a foreign row is now spent** in Password (it was given back) | Unreachable in practice: Password always writes `userId` and EmailChange always writes `{ newEmail }`. Pinned by §5.1 items 7–8. Q1 can flip it to `rollback` in one line (`"commit"` → the caller's `onFailure`) |
| **Behaviour change: a magic-link row with an undecodable payload** was signed in by `userId`; it is now refused | No such row is written (`requestLink` always writes `{ email }`); a row written before the schema existed has the same shape |
| **The new `confirmResetByIp` rule** throttles a legitimate shared egress IP | Same numbers as `verifyEmailByIp` (30 per 15 minutes), which has shipped without complaint; tunable (`RateLimits.tune`) and overridable per tenant (Q2) |
| **`confirmReset` in-process callers** (BDD `PasswordWorld`, tests) pass no `ip` and share the `ip:unknown` bucket | 30 per 15 minutes is far above any test's count; the per-source test passes an explicit `ip` |
| **OAuth/SAML codec swap** changes which values are "malformed" | Every minted value has one `.`; the decode differs from SAML's first-`.` split only for a value with two dots, which no flow mints. The existing OAuth/SAML suites run unchanged; the new purpose names are byte-identical prefixes, so in-flight state survives the deploy |
| **Sibling plans edit the same functions** (plan 14 rewrites `OAuth.callback`'s account resolution; plan 11 may extract the client-address resolution the `confirmReset` handler now needs) | §8 gives the merge order; phase 5's diff is confined to `:150-171` and `:943-949` |
| **Phantom purpose brand** (§3.5 item 4) widens `IssuedLink`'s type in a way some test pattern-matches | It is an optional phantom key; a test that compares `token` values is unaffected. Q4 can drop it without touching the rest |

**Rollback.** Phase 1 is additive except the `issue` signature, whose four call sites move in the same phase; reverting phase 1 reverts them together. Phases 2–5 each revert to the hand-written redeem at their call sites, independently. The phase 2 rate rule can be reverted alone (it is a table entry, a handler parameter and an input field).

---

## 8. Interactions with other plans

**Done plans this builds on (01–10):**

- **07 (`Verification.redeem`, ADR-EA-039)**: the redeemer is the link half over plan 07's interface; nothing in `Verification.ts` changes. Plan 07's settlements per caller (§3.7 of plan 07) are kept: Password default `rollback`, MagicLink and two-factor `commitUnlessUnavailable`. Its Q3 decision (dead tokens inside Password's `use` roll back) is kept for the dead-token cases that stay inside `use`; only the *foreign-row* case (now outside `use`, in the redeemer) changes, and Q1 asks the user to confirm.
- **06 (rate-limit budget)**: the redeemer takes closures over `limits.spend`, so every rule name and input is still checked by plan 06's types; the new `confirmResetByIp` is one more table entry, registered by `RateLimits.budget(Password)` like the rest. Plan 06 decision 1 (`ratelimit:<bucket>:<part>` keys) applies unchanged.
- **01 (sign-in core)**: MagicLink's `use` is still `Channel.complete` → `SignIn`. Unchanged.
- **02 (store seam)**: `VerificationStore` untouched.
- **03, 04, 05, 08, 09, 10**: no interaction. Plan 08's `TestAuth.layer` keeps the memory `Verification`; the redeemer needs nothing else.

**Sibling plans (11–24):**

- **11 (credential-resolution)**: it exports `ClientAddress.address(clientAddress, request)` (the `{ ip }` spread form) and `ClientAddress.facts` for the 24 `clientAddress.resolve(request)` sites. The `confirmReset` handler change (phase 2) adds one more such site: if plan 11 lands first, write it as `yield* password.confirmReset({ ...payload, ...(yield* ClientAddress.address(clientAddress, request)) })`; if after, plan 11's sweep picks it up with the `verifyEmail`/`confirmEmailChange` handlers beside it. No other overlap (plan 11 does not touch the link endpoints' bodies).
- **12 (passkey ceremony)**: passkey challenges are a `ChallengeStore`, not `Verification`; no overlap. If plan 12 ever moves them onto `Verification`, they become a user-keyed purpose here.
- **13 (admin gate)**: `AdminAccounts.setUserEmail` calls `EmailChange.request`, whose signature does not change. Only `AdminAccounts.test.ts:281-289` changes (phase 1).
- **14 (federated identity)**: rewrites `OAuth.callback`'s account resolution (after the consume). Phase 5 touches only the decode (`:943-949`) and the codec (`:150-171`). Land either first; the second rebases a few lines. If plan 14 lands first and moves `callbackFlow`, re-locate the decode by the `decodeState(input.state)` call.
- **15 (host composition)**: none.
- **16 (sql-store-adapters)**: none (no SQL change here).
- **17 (core sealed columns)**: none (`verification_tokens` is not in its list).
- **19 (session verdict)**: independent; both are pure-module extractions in core with no shared file.
- **20 (in-process user agent)**: BDD worlds read mailed tokens and present them; the token format is unchanged.
- **21 (session-minting annotation)**: `MagicLink.verify` mints a session; its endpoint annotation is unaffected by how the link is redeemed.
- **22, 23, 24**: none.

---

## 9. Acceptance checklist

- [ ] `VerificationLink` exports `forUser`, `forAddress`, `Link`, `LinkOf`, `Purpose`, `LinkRefused`, `LinkBudget`, `redeemer`, and a purpose-typed `issue`; no `as` (other than `as const`), no return-type annotation on a new Effect const.
- [ ] The five link callers redeem through a redeemer bound in `make`; `grep -rn 'verification\.redeem\|\.redeem({' packages/*/src` lists only `VerificationLink.ts` and `EmailOtp.ts`.
- [ ] No caller checks `Option.isNone(…userId)` or decodes a link payload by hand; `EmailChange.newEmailOf` is gone.
- [ ] `Password` has one `proveMailbox` helper and no copy of the `verifyEmail` `catchTags` mapping.
- [ ] `confirmReset` spends `confirmResetByIp` before decoding; the phase 0 per-source test passes and the breach client counts at most 30 calls.
- [ ] `OAuth.callback` refuses another purpose's identifier before `consume`; the phase 0 OAuth test passes; `encodeState`/`decodeState` and SAML's inline parsers are gone.
- [ ] §5.1 (14 cases) and §5.2 pass; the ten tests in §5.3 are deleted; the kept mapping tests pass.
- [ ] The three new BDD scenarios pass; REQ-EA-163/164/165/688/693 and the cross-purpose scenarios pass unchanged.
- [ ] BEH-EA-057/117/118/122/262/270, the rate-limiting count, the glossary, ADR-EA-039 rev 1.1 and ADR-EA-020 rev 1.4 are updated with revision bumps; `spec/traceability.md` and `features/traceability.md` updated; `pnpm spec:verify:strict` passes.
- [ ] Changesets with `Migration:` lines exist for phases 1, 2 and 5.
- [ ] `pnpm check` is green on the final commit.

---

## 10. Open questions only the user can answer

1. **A foreign row: spend it or give it back?** A row under a purpose's identifier that names no user (where one is required) or whose payload does not decode. Recommended: **spend it** (`commit`): it can never become valid, and spending it makes its next presentation a visible replay. Today Password gives it back (plan 07 Q3) and two-factor spends it. Answering "give it back" makes the redeemer's foreign settlement `rollback`.
2. **`confirmResetByIp` numbers.** Recommended: 30 per 15 minutes, the same as `verifyEmailByIp` and `confirmEmailChangeByIp`. A tighter default (10) would match how rarely a person confirms a reset, at the risk of a shared egress IP.
3. **Burn-first callers.** Recommended: they adopt the shared codec only (phase 5), and the redeemer gets no burn-first sibling (`consumer(purpose, …)`), because their failure reasons differ per step and two of the four have no budget to declare. Alternative: add `VerificationLink.consumer` so all eight client-held tokens go through one binding.
4. **The phantom purpose brand on minted tokens** (§3.5 item 4). Recommended: keep it (it costs one optional phantom key and catches an in-process mix-up in tests and steps). Alternative: drop it and rely on the run-time `decode`.
5. **Email OTP codes.** Recommended: stay outside `VerificationLink` (no public id; the identifier is the address). Alternative: a third purpose kind (`forCode`) so the OTP's budget declaration is also required by type.
6. **Purpose-name collisions across plugins.** Recommended: no runtime registry; document in `docs/plugin-authoring.md` that a purpose name is a global namespace (prefix third-party purposes with the plugin id). Alternative: a build-time registry that dies on a duplicate name, as `RateLimits` does for buckets.
7. **Two-factor's `source: "caller"`.** Recommended: keep `TwoFactor.attempt`'s `verifyByIp` where it is and declare `"caller"` in `SecondFactor`. Alternative: move the per-source spend into `SecondFactor` by giving it `RateLimits.budgetOf(TwoFactor)`, which makes the declaration a real closure at the cost of a dependency from `SecondFactor` on the plugin's budget handle.
