# Plan 19: A pure verdict for a presented session credential

| Property | Value |
|---|---|
| Strength | Worth exploring (batch index). Confirmed as such: the payoff is test locality and one place for the rules, with one small live inconsistency fixed on the way; no security bug was found in `verify` |
| Dependency category | in-process (a pure module inside `@awthaq/core`, executed against the unchanged `SessionStore` port) |
| Wave / order | Any time after plan 02 (`SessionStore`, ADR-EA-041), which is merged. Independent of every sibling plan; order-free with plan 11 (credential-resolution), which consumes `Sessions.verify`'s unchanged interface (§8) |
| Fixes live bugs | A `verify` that loses the rotation compare-and-swap to a row that has meanwhile expired fails `SessionExpired` without publishing `auth.session.expired`, and without its `absolute`/`idle` kind, against ESA-006 (`spec/behaviors/13-events.md:112`). Narrow window, low impact |
| Execution tickets | `.scratch/session-verdict/issues/NN-*.md`, one per phase below (`docs/agents/issue-tracker.md`) |

Every `file:line` below was checked against the tree at `fc990c88` (2026-10-17). Re-check the line numbers before editing: plans 11 and 17 may touch `Sessions.ts` first (§8).

---

## 1. Summary, goals, non-goals

### Summary

`Sessions.verify` (`packages/core/src/Sessions.ts:775-916`, 142 lines) is one generator that interleaves I/O (hash the secret, read the row, read the clock, mint a secret, compare-and-swap, flag reuse, publish) with the decision it exists to make: given a presented `id.secret`, the stored row, the instant and the session policy, which of eleven outcomes is this (§2.2)? The decision itself is pure. Because it is not separated, every rule is tested through the whole layer: `packages/core/test/Sessions.test.ts` (1,923 lines, 86 cases) builds `Sessions.layer` over the memory store, collects events through a forked stream, and drives the clock with 46 `TestClock.adjust` calls to reach each branch.

This plan extracts the decision into a **pure module**, `packages/core/src/internal/sessionVerdict.ts`:

- `parse(raw)` / `format(id, secret)`: the `id.secret` codec, written once (today four places: `Sessions.ts:607-610`, `:778-786`, `:746`, `:911`).
- `classify({ row, presentedHash, now, policy })` → a `Verdict` whose tag names the store write and the event it implies (`Rotate` → `SessionStore.rotate` and `auth.session.rotated`; `Replayed` → `SessionStore.flagReuse` and the reuse events; `Expired` → `auth.session.expired`; the rest write nothing).
- `afterLostRotation(current, now)`: the rule for a call that lost the swap.

`verify` becomes a short interpreter: parse, hash, read, classify, execute the verdict against `SessionStore` with an exhaustive match. The store keeps every atomicity guarantee it has today (plan 02, ADR-EA-041): **a verdict is advisory; the store primitive's own precondition is authoritative** (§3.4). The interface of `Sessions` does not change, so no caller (`Authentication`, qadi Path B, `web`/`next`, plan 11's credential resolution) changes.

The clock-driven matrix moves to table and property tests over `classify` (no layer, no store, no `TestClock`), and `Sessions.test.ts` keeps a thin set of integration tests for what only the layer can show: the store writes, the events, the delivery of the rotated token, and the concurrency arbitration.

### Goals

1. One pure function decides a presented credential's outcome; one decides a lost rotation's. Both are package-private (`core/package.json` exports only `"."`).
2. One codec for the session token (`parse`/`format`), used by `issue`, the rotation, `verify` and the span annotation.
3. One expiry rule. `SessionStore.expiryOf(row, now)` in `@awthaq/ports` names *which* deadline passed; `SessionStore.isLive` is defined by it; the verdict, the rotation loser, `findOwned`, `listLive` and the store's own guards all share it.
4. `verify` is an exhaustive interpreter: adding a verdict without handling it is a compile error.
5. The verdict never weakens the store's atomicity: every write it implies goes through a primitive whose own precondition re-checks the verdict's premise (rotation: compare-and-swap on the hash read, never a tombstone; reuse: once-only flag), and a lost race is settled by a second pure rule over the store's authoritative answer, with no retry loop.
6. Fix the lost-race expiry event (phase 0 test first).
7. Replace, don't layer: 19 `Sessions.test.ts` cases move to the verdict suite and are deleted (§5.3); `Sessions.test.ts` goes from 86 cases to 68, and from 46 `TestClock.adjust` calls to 28.

### Non-goals

- Any change to the `SessionsShape` interface, to `SessionView`, to `rotated` delivery, or to the `SessionStore` primitives (ADR-EA-014's KV neutrality is preserved, not reopened).
- `issue`'s policy (supersede, cap, lifetimes), `reauthenticate`, `requireFresh`, revocation, listing. Only `issue`'s token formatting moves to the codec.
- The legacy bridge (`bridgeLegacySession`, `Sessions.ts:760-773`) and its single-use gap (plan 02 Q9). It stays I/O in `verify`, reached from two verdicts.
- Exposing the verdict outside core (Q3).
- Changing the rotation-grace or reuse semantics (RRS-003, RRS-005, RRC-006).

---

## 2. Verified current state

### 2.1 Where the rules are

| Lines | What | Pure? |
|---|---|---|
| `Sessions.ts:37-40` | `toHex`, `hashSecret = SecretHash.digest` | I/O (crypto) |
| `:58`, `:62` | `UNKNOWN_SESSION_HASH = SecretHash.NEVER_MATCHES`, `secretMatches = SecretHash.equals` (constant time) | pure |
| `:64-85` | `matchedSecret(now, presented, current, previous, previousExpiresAt)` → `"current" \| "previous" \| "none"` (RRS-005: both comparisons always run) | pure |
| `:103-126` | `SessionConfig` (`absolute`, `idle`, `touchEvery`, `rotationGrace?`, `maxConcurrent?`), `DEFAULT_ROTATION_GRACE`, `graceOf` | pure |
| `:356-412` | the `verify` contract (doc comment) | — |
| `:598-622` | `traceVerify`: span, latency, failure metric; **parses the token a second time** (`:607-610`, `indexOf(".")`, `separator > 0`) to annotate an id-shaped id | pure parse, I/O annotate |
| `:624-643` | `toView` (RSC-001: never the stored record by identity) | pure |
| `:659-663` | `notFound(id?)` | pure |
| `:746` | `issue` formats `${id}.${secret}` | pure |
| `:760-773` | `bridgeLegacySession` (BAM-003) | I/O |
| `:775-916` | `verify`: parse (`:778-786`, `indexOf(".")`, `separator < 0` → bridge), then the decision interleaved with I/O | mixed |
| `:911` | the rotation formats `${id}.${newSecret}` | pure |
| `ports/src/SessionStore.ts:85-88` | `RotateOutcome` (`Rotated` \| `Lost { current }`) | — |
| `ports/src/SessionStore.ts:119-148` | `rotate` (compare-and-swap: the row exists, its hash is `expectedSecretHash`, not tombstoned) and `flagReuse` (once-only: tombstoned and unflagged) | — |
| `ports/src/SessionStore.ts:202-212` | `isLive` (not tombstoned, `now` before both expiries) | pure |
| `sql/src/SessionStoreSql.ts:176-207` | SQL `rotate`: one conditional `UPDATE`; on a lost swap one authoritative `findById` | — |

What the candidate description got wrong, corrected here: `Sessions.test.ts` has **86** cases (`npx vitest run packages/core/test/Sessions.test.ts`: 86 passed), not 95; 46 `TestClock.adjust` calls is right; `verify` is `:775-916` (142 lines), not `:776-930`; the second parse is in `traceVerify` (`:604-622`), and `:624-643` is `toView`; the token is also *formatted* twice (`:746`, `:911`).

### 2.2 The outcomes `verify` decides today

Order matters: PIL-007 (`spec/behaviors/07-sessions.md:177`) requires the secret to be proven before any row-state branch, and RRS-003 checks the tombstone before expiry (`Sessions.ts:808-812`).

| # | Condition (in evaluation order) | Store write | Events | Result | Lines |
|---|---|---|---|---|---|
| 1 | No `.` in the token | legacy bridge (`issue` + `bridge.consume`) on a hit | `auth.session.issued` on a hit | bridged session, or `NotFound()` ("malformed") | `:779-784` |
| 2 | Credential, but `store.get(id)` is `None` | dummy constant-time compare (`:793`); legacy bridge | as #1 | bridged, or `NotFound(id)` | `:791-797` |
| 3 | The presented hash matches neither the current hash nor a previous hash inside its window | — | — | `NotFound(id)` | `:800-807` |
| 4 | Tombstoned, matched the **current** secret, `reusedAt` unset | `flagReuse(id, now)` (once-only, revokes the family) | on `Some`: `auth.session.reuse`, `auth.session.revoked` (`family`, `reuseDetected`) | `NotFound(id)` | `:813-836` |
| 5 | Tombstoned, any other match (a previous secret, or already flagged) | — | — | `NotFound(id)` | `:813-836` |
| 6 | `now >= absoluteExpiresAt` | — | `auth.session.expired` (`absolute`) | `SessionExpired` ("expired") | `:838-846` |
| 7 | `now >= idleExpiresAt` | — | `auth.session.expired` (`idle`) | `SessionExpired` ("idle-expired") | `:847-855` |
| 8 | `actingAs` (BEH-EA-210: never touches) | — | — | the row, `rotated: None` | `:858-860` |
| 9 | Matched current, `now < lastActiveAt + touchEvery` (BEH-EA-052) | — | — | the row, `rotated: None` | `:862-869` |
| 10 | Due, or matched a previous secret (RRS-005: always re-rotates) | `rotate` (compare-and-swap on the hash read; `previous` = that hash for `rotationGrace`; `idleExpiresAt = min(now + idle, absolute)`) | on `Rotated`: `auth.session.rotated` (`viaGrace` when #10 came from a previous secret) | the rotated row, `rotated: Some(id.newSecret)` | `:870-912` |
| 11 | #10 lost the swap: `Lost.current` is `None` or tombstoned / not live / live | — | **none**, even when expired (§2.3) | `NotFound(id)` / `SessionExpired` ("expired", no kind) / the row, `rotated: None` | `:892-900` |

### 2.3 Live inconsistency: a rotation loser's expiry is silent

ESA-006 (`spec/behaviors/13-events.md:112`): "`Sessions.verify` publishes `auth.session.expired` (`absolute` or `idle`) when a correctly-secreted credential is presented past its expiry". Outcome #11 (`Sessions.ts:896-898`) fails `SessionExpired` for a non-live `Lost.current` without publishing, and its message is always "session expired" even for an idle expiry. The window is a concurrent request (or an absolute deadline) landing between this call's `store.get` and its `rotate`; the existing "rotation loser (S-6)" tests (`Sessions.test.ts:1821-1889`) cover gone, tombstoned and live, not expired.

```ts
// Repro (phase 0, in the "Sessions rotation loser (S-6)" describe, reusing its `losing` store double):
// the winner's row, as the loser re-reads it, is past its idle expiry.
it.effect("a loser that finds the row expired publishes auth.session.expired (idle) and fails SessionExpired", () =>
  Effect.gen(function* () {
    const { sessions, issued } = yield* dueForTouch;
    const seen = yield* collecting(sessions.verify(issued.token).pipe(Effect.flip));
    // Today: SessionExpired with message "awthaq: session expired", and no auth.session.expired in `seen`.
    // After phase 2: one auth.session.expired { kind: "idle" } and the message "awthaq: session idle-expired".
  }).pipe(Effect.provide(layerOver(losing((record) =>
    Option.some({ ...record, idleExpiresAt: DateTime.makeUnsafe(0) }))))));
```

No other bug was found. Checked and correct: PIL-007 ordering (the dummy compare on an unknown id; no row-state branch before the secret is proven); reuse is attempted only for the current secret of an unflagged tombstone and arbitrated by the store's once-only `flagReuse`; a previous secret never flags reuse; `actingAs` never rotates; the rotation never pushes `idleExpiresAt` past `absoluteExpiresAt` (INV-EA-008); the compare-and-swap expects the hash this call read.

### 2.4 One small parse drift

`traceVerify` treats a token as id-bearing when `indexOf(".") > 0`; `verify` when `indexOf(".") >= 0`. For a token that starts with `.` (`".abc"`), `verify` looks up the empty id, misses, tries the bridge and answers `NotFound("")` ("no such session"), while the span sees no id. One `parse` makes both say "opaque" (`NotFound()`, "malformed"), which is the more accurate message (Q2). No caller depends on the message; the property test `SessionToken.property.test.ts:27-36` ("any presented string … fails with the typed NotFound") holds either way.

### 2.5 The tests today

`Sessions.test.ts` runs every suite once over the memory store (`:87-862` `suite`, `:879-1089` `reuseSuite`, `:1091-1398` `eventsSuite`, `:1400-1479` `capSuite`, `:1506-1686` `graceSuite`, then four plain `describe`s). The store's own atomicity on every adapter is `StoreContract.sessions` (`packages/test/src/StoreContract.ts:1448`), run over the `Ref`, SQLite, WAL-file and Postgres adapters; the SQL adapter's retry and failure mapping are `packages/sql/test/SessionStoreSql.test.ts`. `SessionToken.property.test.ts` (99 lines, 4 properties) drives the token parse through the whole layer.

Pure-module property tests already exist in the repo with `it.prop` and `effect/unstable/arbitrary/Arbitrary` (`packages/organization/test/PermissionEngine.property.test.ts:1-60`), and a package-private pure module exists in core (`packages/core/src/internal/signInSteps.ts`, plan 01). fast-check is not a direct dependency; `Arbitrary.schema` is the generator.

---

## 3. Target design

### 3.1 One expiry rule (`packages/ports/src/SessionStore.ts`)

```ts
/** RRS-003/BEH-EA-051: which deadline `row` has passed at `now`, absolute first; `None` while both are ahead. */
export const expiryOf = (
  row: { readonly absoluteExpiresAt: DateTime.Utc; readonly idleExpiresAt: DateTime.Utc },
  now: DateTime.Utc,
): Option.Option<"absolute" | "idle"> =>
  DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(row.absoluteExpiresAt)
    ? Option.some("absolute")
    : DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(row.idleExpiresAt)
      ? Option.some("idle")
      : Option.none();

/** TIR-003/SMS-002: the one liveness predicate (unchanged meaning), now defined by `expiryOf`. */
export const isLive = (row: /* unchanged */, now: DateTime.Utc): boolean =>
  Option.isNone(row.supersededAt) && Option.isNone(expiryOf(row, now));
```

It lives in ports because the adapters (`listLive`, `reauthenticate`, the cap, `SessionStoreSql.ts:276`) already share `isLive` there, and ports cannot import core. `isLive`'s meaning is unchanged, so `StoreContract.sessions` needs no change. (A plain function over two `DateTime`s; its return type is written because it is not an Effect.)

### 3.2 The pure module (`packages/core/src/internal/sessionVerdict.ts`, new)

```ts
// @awthaq/core — internal/sessionVerdict
//
// BEH-EA-049..056, RRS-003, RRS-005 (ADR-EA-014 rev 1.4): what a presented session credential means,
// as a pure function of the stored row, the presented secret's hash, the instant and the policy.
// `Sessions.verify` executes the verdict against `SessionStore`; the store's own atomic preconditions
// stay authoritative (a verdict is advisory). Package-private: `core/package.json` exports only ".".
// Imports `@awthaq/ports` and `../SecretHash.ts` only, never `../Sessions.ts` (scripts/circular.mjs
// fails type-only cycles).

import { type Ids, SessionStore } from "@awthaq/ports";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as SecretHash from "../SecretHash.ts";

// ---- the token codec (BEH-EA-049) -------------------------------------------------------------

export type Presented =
  /** No id before a `.`: never a session token of ours; the legacy bridge may know it (BAM-003). */
  | { readonly _tag: "Opaque"; readonly raw: string }
  | { readonly _tag: "Credential"; readonly id: Ids.SessionId; readonly secret: string };

/** Split at the first `.`; the id must be non-empty (an id never contains `.`; a secret may be empty, and then never matches). */
export const parse = (raw: string): Presented => {
  const separator = raw.indexOf(".");
  return separator > 0
    ? { _tag: "Credential", id: SessionId(raw.slice(0, separator)), secret: raw.slice(separator + 1) }
    : { _tag: "Opaque", raw };
};

export const format = (id: Ids.SessionId, secret: string): string => `${id}.${secret}`;

/** MW-001: the id half, when it is safe to put on a span (attacker-controlled: id-shaped and bounded only). */
export const spanId = (presented: Presented): Option.Option<string> =>
  presented._tag === "Credential" && /^[A-Za-z0-9-]{1,64}$/.test(presented.id)
    ? Option.some(presented.id)
    : Option.none();

// ---- the policy ------------------------------------------------------------------------------

/** The part of `SessionConfig` a verdict reads, with the grace default applied once. */
export interface Policy {
  readonly touchEvery: Duration.Duration;
  readonly idle: Duration.Duration;
  readonly grace: Duration.Duration;
}

// ---- the verdict -----------------------------------------------------------------------------

/** What a compare-and-swap rotation writes; `expectedSecretHash` is the hash this verdict read. */
export interface Rotation {
  readonly expectedSecretHash: string;
  readonly previous: Option.Option<{ readonly hash: string; readonly expiresAt: DateTime.Utc }>;
  readonly lastActiveAt: DateTime.Utc;
  readonly idleExpiresAt: DateTime.Utc;
}

/**
 * Each tag names what `verify` does with it:
 * - `Unknown`  no row: try the legacy bridge, else `NotFound(id)`. No write of ours.
 * - `Refused`  the secret is not this row's (PIL-007: decided before any row state): `NotFound(id)`.
 * - `Replayed` a tombstoned row presented with a secret it accepted (RRS-003): when `flagReuse`,
 *              `SessionStore.flagReuse` (once-only) and, on its `Some`, `auth.session.reuse` + the family
 *              `auth.session.revoked`; always `NotFound(id)`.
 * - `Expired`  `auth.session.expired { kind }`, then `SessionExpired`.
 * - `Accepted` no write: the row as read, `rotated: None` (an `actingAs` session, or not yet due).
 * - `Rotate`   `SessionStore.rotate` (compare-and-swap); `Rotated` → `auth.session.rotated` and the new
 *              token; `Lost` → `afterLostRotation`.
 */
export type Verdict =
  | { readonly _tag: "Unknown" }
  | { readonly _tag: "Refused" }
  | { readonly _tag: "Replayed"; readonly flagReuse: boolean }
  | { readonly _tag: "Expired"; readonly kind: "absolute" | "idle"; readonly row: SessionStore.SessionRecord }
  | { readonly _tag: "Accepted"; readonly row: SessionStore.SessionRecord }
  | {
      readonly _tag: "Rotate";
      readonly row: SessionStore.SessionRecord;
      /** RRS-005: the presented secret was the previous one, inside its window. */
      readonly viaGrace: boolean;
      readonly rotation: Rotation;
    };

/** RRS-005: which accepted secret the presented hash is. Both comparisons always run (constant work). */
const matched = (
  row: SessionStore.SessionRecord,
  presentedHash: string,
  now: DateTime.Utc,
): "current" | "previous" | "none" => {
  // body of today's `matchedSecret` (Sessions.ts:69-85), reading the row's Option fields
};

export const classify = (input: {
  readonly row: Option.Option<SessionStore.SessionRecord>;
  readonly presentedHash: string;
  readonly now: DateTime.Utc;
  readonly policy: Policy;
}): Verdict => {
  const { presentedHash, now, policy } = input;
  if (Option.isNone(input.row)) {
    // PIL-007: an unknown id does the same hash-and-compare work as a known one.
    SecretHash.equals(presentedHash, SecretHash.NEVER_MATCHES);
    return { _tag: "Unknown" };
  }
  const row = input.row.value;
  const secret = matched(row, presentedHash, now);
  if (secret === "none") return { _tag: "Refused" };
  // RRS-003: checked before expiry; only the current secret of an unflagged tombstone is reuse.
  if (Option.isSome(row.supersededAt)) {
    return { _tag: "Replayed", flagReuse: secret === "current" && Option.isNone(row.reusedAt) };
  }
  const expired = SessionStore.expiryOf(row, now);
  if (Option.isSome(expired)) return { _tag: "Expired", kind: expired.value, row };
  // BEH-EA-210: an impersonation session never touches.
  if (Option.isSome(row.actingAs)) return { _tag: "Accepted", row };
  // BEH-EA-052: at most one write per `touchEvery`; RRS-005: a previous secret always re-rotates.
  const due =
    DateTime.toEpochMillis(now) >=
    DateTime.toEpochMillis(DateTime.addDuration(row.lastActiveAt, policy.touchEvery));
  if (!due && secret === "current") return { _tag: "Accepted", row };
  return {
    _tag: "Rotate",
    row,
    viaGrace: secret === "previous",
    rotation: {
      expectedSecretHash: row.secretHash,
      previous:
        Duration.toMillis(policy.grace) > 0
          ? Option.some({ hash: row.secretHash, expiresAt: DateTime.addDuration(now, policy.grace) })
          : Option.none(),
      lastActiveAt: now,
      // INV-EA-008: idle refresh never passes the absolute deadline.
      idleExpiresAt: DateTime.min(DateTime.addDuration(now, policy.idle), row.absoluteExpiresAt),
    },
  };
};

// ---- a lost rotation ---------------------------------------------------------------------------

export type AfterLost =
  | { readonly _tag: "Gone" }
  | { readonly _tag: "Expired"; readonly kind: "absolute" | "idle"; readonly row: SessionStore.SessionRecord }
  | { readonly _tag: "Accepted"; readonly row: SessionStore.SessionRecord };

/**
 * BEH-EA-052/RRC-006: this call proved its secret against the row it read; another call rotated first.
 * `current` is the store's authoritative answer (`RotateOutcome.Lost`). The secret is NOT re-checked
 * and nothing is re-rotated: re-classifying would see this call's secret as the winner's previous one
 * and rotate again, so N concurrent requests would make N rotations and N `Set-Cookie`s. Liveness is.
 */
export const afterLostRotation = (
  current: Option.Option<SessionStore.SessionRecord>,
  now: DateTime.Utc,
): AfterLost => {
  if (Option.isNone(current) || Option.isSome(current.value.supersededAt)) return { _tag: "Gone" };
  const expired = SessionStore.expiryOf(current.value, now);
  return Option.isSome(expired)
    ? { _tag: "Expired", kind: expired.value, row: current.value }
    : { _tag: "Accepted", row: current.value };
};

export const policyOf = (config: {
  readonly touchEvery: Duration.Duration;
  readonly idle: Duration.Duration;
  readonly rotationGrace?: Duration.Duration | undefined;
}): Policy => ({
  touchEvery: config.touchEvery,
  idle: config.idle,
  grace: config.rotationGrace ?? DEFAULT_ROTATION_GRACE,
});
```

Notes for the executor:

- **`SessionId` and `DEFAULT_ROTATION_GRACE`.** The module cannot import `Sessions.ts`. Mint the id with a local `Brand.nominal<Ids.SessionId>()` (the same constructor `Sessions.ts:35` declares over the same brand) and move `DEFAULT_ROTATION_GRACE` here, re-exported from `Sessions.ts` (`export { DEFAULT_ROTATION_GRACE } from "./internal/sessionVerdict.ts"`), so its public name is unchanged.
- **No assertions.** `as const` is not needed: each `return` is an object literal checked against the declared `Verdict`/`AfterLost`/`Presented` return type of a plain (non-Effect) function. These return types are written because the functions are not Effect or Layer consts; the no-annotation rule is about those.
- `matched` is today's `matchedSecret` with its parameters read from the row; the "both comparisons always run" property is kept verbatim.

### 3.3 `verify` executes the verdict (`packages/core/src/Sessions.ts`)

```ts
/** ESA-006: an expired presentation is announced, with its kind, wherever it is found. */
const expire = (id: SessionId, row: SessionStore.SessionRecord, kind: "absolute" | "idle") =>
  events
    .publish({ _tag: "auth.session.expired", sessionId: id, userId: row.userId, kind })
    .pipe(
      Effect.andThen(
        Effect.fail(
          new SessionExpired({
            message: kind === "idle" ? "awthaq: session idle-expired" : "awthaq: session expired",
            id,
          }),
        ),
      ),
    );

const accepted = (row: SessionStore.SessionRecord) => ({
  session: toView(row),
  rotated: Option.none<Redacted.Redacted<string>>(),
});

const bridgedOr = (raw: string, otherwise: SessionNotFound) =>
  bridgeLegacySession(raw).pipe(
    Effect.flatMap(Option.match({ onNone: () => Effect.fail(otherwise), onSome: Effect.succeed })),
  );

const flagReuse = Effect.fnUntraced(function* (id: SessionId, now: DateTime.Utc) {
  const flagged = yield* store.flagReuse(id, now);
  if (Option.isNone(flagged)) return; // lost the once-only race, or already flagged
  yield* events.publish({ _tag: "auth.session.reuse", sessionId: id, ...flagged.value });
  yield* events.publish({
    _tag: "auth.session.revoked",
    userId: flagged.value.userId,
    sessionId: null,
    scope: "family",
    reason: "reuseDetected",
  });
});

const rotate = Effect.fnUntraced(function* (
  id: SessionId,
  verdict: Extract<SessionVerdict.Verdict, { readonly _tag: "Rotate" }>,
  now: DateTime.Utc,
) {
  const secret = toHex(yield* crypto.randomBytes(32));
  const outcome = yield* store.rotate({
    id,
    ...verdict.rotation,
    secretHash: yield* hashSecret(crypto, secret),
  });
  if (outcome._tag === "Lost") {
    return yield* Match.valueTags(SessionVerdict.afterLostRotation(outcome.current, now), {
      Gone: () => Effect.fail(notFound(id)),
      Expired: ({ kind, row }) => expire(id, row, kind),
      Accepted: ({ row }) => Effect.succeed(accepted(row)),
    });
  }
  // RRS-008: only the call that won the swap announces it.
  yield* events.publish({
    _tag: "auth.session.rotated",
    sessionId: id,
    familyId: outcome.session.familyId,
    userId: outcome.session.userId,
    ...(verdict.viaGrace ? { viaGrace: true } : {}),
  });
  return {
    session: toView(outcome.session),
    rotated: Option.some(Redacted.make(SessionVerdict.format(id, secret))),
  };
});

const verify: SessionsShape["verify"] = Effect.fnUntraced(
  function* (token) {
    const policy = SessionVerdict.policyOf(yield* configNow);
    const raw = Redacted.value(token);
    const presented = SessionVerdict.parse(raw);
    if (presented._tag === "Opaque") return yield* bridgedOr(raw, notFound());
    const { id, secret } = presented;
    // PIL-007: the secret is hashed before the row is read, and proven before any row state is consulted.
    const presentedHash = yield* hashSecret(crypto, secret);
    const row = yield* store.get(id);
    const now = yield* DateTime.now;
    return yield* Match.valueTags(SessionVerdict.classify({ row, presentedHash, now, policy }), {
      Unknown: () => bridgedOr(raw, notFound(id)),
      Refused: () => Effect.fail(notFound(id)),
      Replayed: ({ flagReuse: attempt }) =>
        (attempt ? flagReuse(id, now) : Effect.void).pipe(Effect.andThen(Effect.fail(notFound(id)))),
      Expired: ({ kind, row }) => expire(id, row, kind),
      Accepted: ({ row }) => Effect.succeed(accepted(row)),
      Rotate: (verdict) => rotate(id, verdict, now),
    });
  },
  Effect.catchTag("PlatformError", storeUnavailable("Sessions.verify")),
  relabel("Sessions.verify"),
);
```

- `Match.valueTags` (rc.116, `effect/Match`, `Match.d.ts:379`) is exhaustive by type: a seventh `Verdict` tag without a handler does not compile. If the union of handler Effects does not infer cleanly under `yield*`, use a `switch` over `verdict._tag` with `default: return absurd(verdict)` (`effect/Function`, `Function.d.ts:608`). Both are assertion-free.
- `issue` (`:746`) returns `Redacted.make(SessionVerdict.format(id, secret))`. `traceVerify` (`:604-622`) annotates `SessionVerdict.spanId(SessionVerdict.parse(raw))` instead of slicing.
- Deleted from `Sessions.ts`: `UNKNOWN_SESSION_HASH`, `secretMatches`, `matchedSecret` (`:42-85`, the orphaned PIL-007 doc block at `:42-47` moves with the dummy compare), `graceOf` (`:125-126`), and the 142-line generator. `verify` and its four helpers are about 90 lines, almost all of them event payloads.
- The `SessionsShape.verify` doc comment (`:356-412`) is shortened to the contract and points at `internal/sessionVerdict.ts` for the rules. The historical "upstream-hardening ticket 03" paragraph (`:375-397`) moves to the module header as one sentence.

### 3.4 How the verdict and the store's atomicity fit together

The verdict is computed from one authoritative read (`store.get` is never served by a replica, `SessionStore.ts:117`; ADR-EA-014 decision 1) and is therefore a snapshot. The rule that keeps it from weakening plan 02's guarantees: **every write a verdict implies is a store primitive whose own atomic precondition re-checks the verdict's premise; no verdict writes through a primitive without one.**

| Verdict | Premise read from the snapshot | Primitive and its atomic precondition | If the premise no longer holds |
|---|---|---|---|
| `Rotate` | live, untombstoned, secret matched, hash = `row.secretHash` | `rotate`: hash = `expectedSecretHash` ∧ not tombstoned (compare-and-swap) | `Lost { current }` → `afterLostRotation` (pure, one step, no retry) |
| `Replayed { flagReuse: true }` | tombstoned, unflagged | `flagReuse`: tombstoned ∧ `reusedAt` unset (once-only, with the family revocation in the same unit) | `None` → no events; still `NotFound` |
| `Expired`, `Accepted`, `Refused`, `Unknown`, `Replayed { flagReuse: false }` | — | no write | the answer is as of the read; a revocation committed before the read is already seen (ADR-EA-014 decision 1) |

Why a lost swap does not re-read and re-classify: `Lost.current` already is the authoritative re-read (the memory adapter answers it from the same `Ref.modify`, `SessionStore.ts:337`; the SQL adapter re-reads by id, `SessionStoreSql.ts:198-204`). Re-classifying it with this call's presented hash would find that hash as the winner's `previous` (when `rotationGrace > 0`) and rotate *again*, turning N concurrent requests into N rotations; with `rotationGrace: 0` it would refuse a caller whose proof was valid at its own read. `afterLostRotation` keeps today's semantics (RRC-006, `Sessions.test.ts:1648`): authenticate the winner's row without a rotation of its own, refuse a row gone or tombstoned meanwhile, and (fixed) announce an expiry. The loop is bounded by construction: at most one `rotate` per `verify`.

ADR-EA-014's backend neutrality is served, not touched: the verdict reads only fields every `SessionRecord` has (`secretHash`, `previousSecret*`, the three timestamps, `supersededAt`, `reusedAt`, `actingAs`), and it enforces decision 2 ("idle and absolute expiry behave identically across backends; the domain timestamps are what `verify` checks") in one pure function that a table test pins, so a KV adapter's native TTL can never be the enforcement. A KV `SessionStore` still implements the same nine primitives and passes `StoreContract.sessions`; nothing in this plan adds or changes a primitive.

### 3.5 What stays outside the pure module

Crypto (hashing the presented secret, minting the new one), the clock read, `configNow` (tenant config in force, EP-007), the store calls, every event publish, `toView`, the legacy bridge, the span/metric (`traceVerify`), and the error values. The verdict carries the row where the interpreter needs it (`Expired`, `Accepted`, `Rotate`), so the interpreter never re-reads.

---

## 4. Phased migration

Every phase gate is `pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`. Phase 1 changes a ports helper used by the SQL adapter (`isLive`'s body, not its meaning), so run `pnpm test:pg` once at the end of phase 1 if a Postgres is available (`StoreContract.sql.test.ts`, `SessionStoreSql.test.ts`). Plan gate: `pnpm check`. One ticket per phase under `.scratch/session-verdict/issues/`.

### Phase 0: pin the lost-race expiry

1. `packages/core/test/Sessions.test.ts`, describe "Sessions rotation loser (S-6)" (`:1821-1889`): add the §2.3 test, with a `collecting` helper like the events suite's (`:1091-1112`; the S-6 layer needs `Layer.provideMerge(AuthEvents.layer)` instead of `Layer.provide` so the test can subscribe). It fails today (no event; message "session expired").

### Phase 1: the expiry rule and the pure module (additive)

1. `packages/ports/src/SessionStore.ts`: `expiryOf`; `isLive` defined by it (§3.1). Update the header comment (`:10-12`) to name both.
2. `packages/core/src/internal/sessionVerdict.ts` (new, §3.2).
3. `packages/core/test/SessionVerdict.test.ts` (new): the tables and properties of §5.1.
4. `expiryOf` at both boundaries: in `SessionVerdict.test.ts`'s `expiryOf` table (`packages/ports/test` has no session-helper test file today; `isLive` is exercised only through `StoreContract.sessions` and the core suites).

Gate: the phase gate; nothing calls the module yet except its tests (knip: the module is reached from the test only until phase 2; if knip flags its exports, land phases 1 and 2 as one commit).

### Phase 2: `verify` executes the verdict; tests move

1. `packages/core/src/Sessions.ts`: §3.3. `issue` and `traceVerify` use `format`/`parse`/`spanId`. Delete the moved helpers. The phase 0 test passes.
2. `packages/core/test/Sessions.test.ts`: delete the 19 cases of §5.3; fold the two assertions named there into the kept tests.
3. `packages/core/test/SessionToken.property.test.ts`: unchanged (it is the end-to-end witness that the codec, now `parse`, never turns a string into a defect); its first property also covers the `".abc"` change (§2.4).

Gate: the phase gate; `pnpm test:bdd` (the 34 scenarios of `features/features/02-domain/07-sessions.feature` and the rotation-delivery scenarios of the server and qadi features pass unchanged).

### Phase 3: spec, ADR, traceability, changeset

§6, then `pnpm check` and `pnpm spec:verify:strict`.

---

## 5. Test plan

The rule is **replace, don't layer**: the decision is tested once, as a pure function; `Sessions.test.ts` keeps what only the layer shows (the writes, the events, delivery of the rotated token, concurrency arbitration, config in force, outages).

### 5.1 `packages/core/test/SessionVerdict.test.ts` (new)

A `record(overrides)` builder over fixed instants (`DateTime.makeUnsafe`), three hashes (`current`, `previous`, `other`, each 64 hex characters) and a default policy (`touchEvery` 1 h, `idle` 7 d, `grace` 30 s). Plain `it` (no Effect), one case per row.

**`classify` table** (each row names the BEH/RRS id it pins):

| # | Row | Presented | `now` | Expected |
|---|---|---|---|---|
| 1 | none | any | any | `Unknown` |
| 2 | live | `other` | any | `Refused` (BEH-EA-050/056) |
| 3 | idle-expired | `other` | after idle | `Refused`, not `Expired` (PIL-007) |
| 4 | tombstoned | `other` | any | `Refused`, no reuse (PIL-007/RRS-003) |
| 5 | live, previous window closed | `previous` | after the window | `Refused` (RRS-005) |
| 6 | tombstoned, unflagged | `current` | any | `Replayed { flagReuse: true }` (RRS-003) |
| 7 | tombstoned, flagged | `current` | any | `Replayed { flagReuse: false }` (once-only) |
| 8 | tombstoned, previous window open | `previous` | inside | `Replayed { flagReuse: false }` (RRS-005: never a reuse signal) |
| 9 | tombstoned and absolute-expired | `current` | after absolute | `Replayed { flagReuse: true }` (tombstone before expiry) |
| 10 | live | `current` | `= absoluteExpiresAt` | `Expired absolute` (`>=`) |
| 11 | idle-expired, absolute far | `current` | after idle | `Expired idle` (BEH-EA-051) |
| 12 | `actingAs`, past `touchEvery` | `current` | due | `Accepted` (BEH-EA-210) |
| 13 | live | `current` | `lastActiveAt + touchEvery - 1 ms` | `Accepted` (BEH-EA-052) |
| 14 | live | `current` | `lastActiveAt + touchEvery` | `Rotate`, `viaGrace: false` |
| 15 | live, previous window open | `previous` | not due | `Rotate`, `viaGrace: true` (RRS-005) |
| 16 | live, `grace: 0` | `current` | due | `Rotate`, `previous: None` |
| 17 | live, `grace: 5 min` | `current` | due | `previous: Some({ hash: current, expiresAt: now + 5 min })` |
| 18 | live, absolute in 10 min, idle 7 d | `current` | due | `idleExpiresAt = absoluteExpiresAt` (INV-EA-008) |
| 19 | session A's previous hash presented against session B's row | `previous` (A's) | inside | `Refused` (RRS-005: only its own session) |

**`afterLostRotation` table:** `None` → `Gone`; tombstoned → `Gone`; idle-expired → `Expired idle`; absolute-expired → `Expired absolute`; live → `Accepted` with that row (and never anything that rotates).

**`parse`/`format`/`spanId` table:** `"abc"` → `Opaque`; `"id.s"` → `Credential(id, "s")`; `".s"` → `Opaque`; `"id."` → `Credential(id, "")`; `"a.b.c"` → `Credential("a", "b.c")`; `spanId` of a 65-character or non-`[A-Za-z0-9-]` id → `None`.

**`expiryOf`:** `None` one millisecond before both deadlines; `idle` at the idle deadline; `absolute` at the absolute deadline even when idle passed first.

**Properties** (`it.prop` over `Arbitrary.map(Arbitrary.schema(Facts), toInput)`, the `PermissionEngine.property.test.ts` pattern; `Facts` is a `Schema.Struct` of bounded integer minute offsets for `createdAt`/`lastActiveAt`/`absoluteExpiresAt`/`idleExpiresAt`/`previousSecretExpiresAt`, booleans for tombstoned/flagged/`actingAs`/has-previous, `Schema.Literals(["current", "previous", "other"])` for the presented hash, and bounded `touchEvery`/`idle`/`grace`):

- P1 (PIL-007): a presented hash equal to neither the current hash nor a live previous one is `Refused`, whatever the row's tombstone, expiry or `actingAs`.
- P2 (INV-EA-008): every `Rotate` has `idleExpiresAt <= row.absoluteExpiresAt` and `lastActiveAt = now`.
- P3 (BEH-EA-210): an `actingAs` row is never `Rotate`.
- P4 (RRS-005): a previous-secret presentation is never `Replayed { flagReuse: true }`.
- P5: every `Rotate` expects the hash it read (`rotation.expectedSecretHash === row.secretHash`), and `previous` is `None` exactly when `grace` is zero.
- P6 (BEH-EA-052): the current secret before `lastActiveAt + touchEvery` is never `Rotate`.
- P7 (one expiry rule): for an untombstoned row and a matching secret, `classify` is `Expired` exactly when `!SessionStore.isLive(row, now)`, with the kind `expiryOf` names.
- P8: `parse(format(id, secret))` is `Credential(id, secret)` for every id without `.` and any secret; a string with no `.`, or starting with one, is `Opaque`.
- P9: `afterLostRotation` is `Accepted` exactly when `SessionStore.isLive(current, now)`, and never carries a rotation.

### 5.2 `Sessions.test.ts`: what stays (68 cases)

Every `issue`, `list`, `findOwned`, `isLive`, `revoke*`, `reauthenticate`, `requireFresh`, cap, outage and list-bound case stays as is. The `verify` cases that stay are the integration set, one per interpreter branch that writes or publishes:

- `Rotate` → `Rotated`: `:444` ("the same throttled touch rotates the secret; the old token survives only as the grace-window previous") and `:1531` (grace recovery), which absorbs `:1668`'s assertion that the recovery publishes one `auth.session.rotated` with `viaGrace: true`.
- `Rotate` → `Lost`: `:1856` (authenticates the winner's row) and the phase 0 test (expired, announced).
- Concurrency arbitration through the store: `:1225` (two concurrent verifies, one primary `auth.session.rotated`), `:1648` (RRC-006, every concurrent caller keeps a verifying token), `:1012` (two concurrent reuse presentations, one reuse event).
- `Replayed { flagReuse: true }`: `:884`, which absorbs `:1342`'s assertion that the reuse also publishes the family `auth.session.revoked` (`reuseDetected`).
- `Expired`: `:1363` (ESA-006).
- Config in force reaches the verdict: `:647` (a tenant's `touchEvery` decides whether `verify` rotates), `:616` (per-request lifetimes).
- Wiring that is not a decision: `:94` (EOTS-004 message), `:105`, `:123` (DRS-001 tenant on the view), `:145` (RSC-001, no internal fields), `:473` (supersede then verify), `:531` (`actingAs` round-trips).

### 5.3 Tests deleted from `Sessions.test.ts` (19), with what replaces each

| Line | Name | Replaced by |
|---|---|---|
| `:172` | BEH-EA-050/056: a tampered secret is rejected | table 2, P1 |
| `:182` | BEH-EA-051/INV-EA-008: idle refresh never pushes past the absolute expiry | table 18, P2 |
| `:203` | BEH-EA-051: idle expiry fires before the absolute ceiling when idle is exhausted | table 11 |
| `:217` | PIL-007/BEH-EA-056: an expired row with a WRONG secret fails SessionNotFound, not SessionExpired | table 3, P1 |
| `:423` | BEH-EA-052: idle refresh is throttled to at most one write per touchEvery | tables 13–14, P6 |
| `:574` | BEH-EA-210: verify never advances idleExpiresAt for an actingAs session | table 12, P3 |
| `:826` | an ordinary session's own idle-refresh is unaffected by the actingAs skip logic | table 14 |
| `:939` | PIL-007/RRS-003: presenting a superseded id with a WRONG secret revokes nothing and publishes no reuse event | table 4, P1 |
| `:971` | PIL-007: replaying the full pre-supersede token still triggers reuse detection | table 6 (the write and events: `:884`) |
| `:1342` | TIR-008: reuse detection also publishes a family auth.session.revoked (reuseDetected) | folded into `:884` |
| `:1553` | RRS-005: the previous secret is dead once the grace window has passed | table 5 |
| `:1569` | RRS-005: rotationGrace of zero restores immediate invalidation | table 16, P5 |
| `:1580` | RRS-005: a configured window is honoured, not a fixed 30 seconds | table 17 |
| `:1594` | RRS-005: a previous secret is only ever valid for its own session | table 19 |
| `:1610` | RRS-005/RRS-003: presenting a previous secret in the window never revokes the family or publishes auth.session.reuse — even for a session since superseded | table 8, P4 |
| `:1634` | RRS-003: reuse detection still fires for a tombstoned row's current secret with a grace window configured | table 6 (with the default 30 s grace) |
| `:1668` | RRS-005: a grace-window rotation is announced as auth.session.rotated with viaGrace | folded into `:1531` |
| `:1865` | (rotation loser) refuses a row tombstoned in the meantime | `afterLostRotation` table |
| `:1881` | (rotation loser) refuses a row that is gone | `afterLostRotation` table |

About 335 lines and 18 of the 46 `TestClock.adjust` calls leave the file; one test (phase 0) is added. The new verdict file uses no `TestClock`.

### 5.4 BDD

No scenario changes: `07-sessions.feature` (34 scenarios), the rotation-delivery scenarios (BEH-EA-052 PIL-005, server and qadi Path B features) and the reuse scenarios exercise the layer end to end and pass unchanged. No new scenario: the one behaviour change (the lost-race expiry event) is a race a BDD world cannot stage without a store double, and the unit test owns it.

---

## 6. Spec, ADR, traceability and changesets

### 6.1 Behaviour specs

- `spec/behaviors/07-sessions.md` → rev 1.8 ("plan 19: one pure verdict for a presented credential; a rotation loser announces an expiry").
  - BEH-EA-052, the "Rotation grace window" paragraph: append "The decision (refuse, replay, expire, accept, rotate) is one pure function of the stored row, the presented secret's hash, the instant and the policy (`internal/sessionVerdict.ts`); `verify` executes it against `SessionStore`, whose compare-and-swap and once-only reuse flag stay the authority on every write."
  - BEH-EA-053, "One implementation over a store port": "expired is `SessionExpired`" → "expired is `SessionExpired`, announced with `auth.session.expired` and its kind like any other expired presentation".
  - BEH-EA-049: add "A presented value is a session token only when it has a non-empty id before its first `.`; anything else is offered to the legacy bridge (BAM-003) and otherwise answered `SessionNotFound`."
- `spec/behaviors/13-events.md` → rev 1.8: ESA-006 paragraph (`:112`): "… presented past its expiry — lazily, since no background reaper exists, and also when a concurrent rotation found the row expired."

### 6.2 Decisions

- **ADR-EA-014 rev 1.4** (`spec/decisions/014-session-storage-backend-neutrality.md`), no new ADR. Change history: "1.4 (date): where the rules live: the verdict over the record is a pure core function; a backend implements primitives only (plan 19)". Add a Consequences paragraph, **"The rules are one pure function; a backend only stores (plan 19)."**: "What a presented credential means — refused, a replay of a rotated-away row, expired (absolute or idle), accepted, or due for rotation — is decided by one pure function over the `SessionRecord` fields every backend stores, so decision 2's identical expiry behaviour is a single function pinned by table and property tests, not a property each adapter re-derives. The verdict is advisory: each write it implies goes through a store primitive whose own atomic precondition re-checks its premise (`rotate`'s compare-and-swap, `flagReuse`'s once-only flag), it is applied only to an authoritative read (`get`, or `rotate`'s `Lost.current`), and a lost swap is settled by a second pure rule with no retry. A KV backend still implements the nine primitives and passes `StoreContract.sessions`; nothing about the verdict is a backend's to implement or to override. `SessionStore.expiryOf` (ports) names which deadline passed and defines `isLive`."
- **ADR-EA-041**: no change (no primitive changes). Optionally add one sentence to its Consequences pointing at ADR-EA-014 rev 1.4; not required.

### 6.3 Traceability

- `spec/traceability.md` → rev 1.33 (or the next free revision; plan 18 also bumps it): add a row for `packages/core/test/SessionVerdict.test.ts`: "BEH-EA-049..053/056, RRS-003, RRS-005, INV-EA-008, BEH-EA-210: the pure verdict over a presented credential (`classify`), the rotation loser (`afterLostRotation`), the token codec, `SessionStore.expiryOf`; tables and properties (ADR-EA-014 rev 1.4)". Update the `Sessions.test.ts` rows (ADR-EA-028 `:170`, and the §5 sessions row) to say it covers the store writes, events, delivery, concurrency and config in force, the decision matrix having moved. Add `SessionVerdict.test.ts` to the ADR-EA-014 row and to the INV-EA-008 row.

### 6.4 Changeset

`.changeset/session-verdict.md`, `"@awthaq/core": patch`, `"@awthaq/ports": patch`:

> A `Sessions.verify` that loses the rotation race to a row that has meanwhile expired now publishes `auth.session.expired` with its `absolute`/`idle` kind, like every other expired presentation (ESA-006, BEH-EA-053). `SessionStore.expiryOf` names which deadline a session record has passed; `isLive` is defined by it. The rules of `verify` are one internal pure function (ADR-EA-014 rev 1.4).
>
> Migration: none. A token that starts with `.` is now answered as malformed (`SessionNotFound` without an id) instead of as an unknown empty id.

---

## 7. Risks, mitigations, rollback

| Risk | Mitigation |
|---|---|
| **A rule changes in the move** (the order of the tombstone, expiry, `actingAs` and touch checks; `>=` vs `>` at a deadline) | The §5.1 table is written against today's code first (phase 1, before `verify` changes), so it passes against the extracted `classify` and against the old generator's behaviour (run the kept `Sessions.test.ts` cases unchanged in phase 2). Rows 9, 10, 13 and 14 pin the orderings and boundaries explicitly |
| **Constant-time work changes** (PIL-007/RRS-005: both hash comparisons always run; an unknown id does a dummy compare) | `matched` is today's `matchedSecret` verbatim; `classify` keeps the dummy compare for `None`. The hash itself is still computed in `verify` before the read, so the I/O profile is unchanged |
| **The verdict is applied to a stale read and weakens atomicity** | §3.4: no verdict writes without a primitive that re-checks its premise; the `Lost` path is one pure step, no loop; the store primitives and `StoreContract.sessions` are untouched |
| **A rotation loser starts publishing `auth.session.expired`** (an audit row) | That is ESA-006's contract; the window is narrow. Q1 lets the user keep the old silence |
| **`Match.valueTags` inference** over a union of handler Effects | The `switch` + `absurd` fallback (§3.3) |
| **Circular import** (`internal/sessionVerdict.ts` ↔ `Sessions.ts`) | The module imports only ports and `SecretHash.ts`; `DEFAULT_ROTATION_GRACE` moves into it and `Sessions.ts` re-exports it. `pnpm circular` is in every phase gate |
| **knip flags the module's exports in phase 1** (reached only from a test) | Land phases 1 and 2 as one commit if it does (§4) |
| **Sibling plans edit `Sessions.ts`** (plan 17 seals `ipAddress`/`userAgent`; plan 11 may move `traceVerify`'s neighbours) | The verdict reads none of the sealed fields; `toView` (which reads them) stays in `Sessions.ts`. §8 |

**Rollback.** Phase 1 is additive (the `isLive` body change is meaning-preserving and pinned by `StoreContract.sessions`). Phase 2 reverts as a unit (the interpreter and the test moves together); the phase 0 test then fails again, which is the signal. Phase 3 is docs.

---

## 8. Interactions with other plans

**Done plans (01–10):**

- **02 (store seam, ADR-EA-041)**: this plan is the domain half of plan 02's split, made explicit: plan 02 put persistence and atomicity behind `SessionStore`; this plan puts the decision in a pure function. No primitive changes, so plan 02's adapters, `StoreContract.sessions` and its decision 0.2/0.3 (the reauthenticate swap, `markReusedOnce`) are untouched.
- **10 item 3 (`reauthenticate` refuses a dead session, BEH-EA-319)**: `SessionStore.reauthenticate`'s guard is `isLive`, now defined by `expiryOf`; same meaning. `reauthenticate` itself does not change.
- **01 (sign-in core)**: `SignIn` mints through `Sessions.issue`; only the token formatting inside `issue` moves to `format`. No caller change.
- **08 (test composition)**: `TestAuth.layer` composes `Sessions.layer` unchanged.
- **03–07, 09**: no interaction.

**Sibling plans (11–24):**

- **11 (credential-resolution)**: consumes `Sessions.verify` (`{ session, rotated }`, `SessionNotFound | SessionExpired | StoreUnavailable`), whose interface and semantics are unchanged except the lost-race event. Order-free. If plan 11 wants a reason for diagnostics (expired vs refused vs replayed) it should not read the verdict (package-private, Q3); `SessionExpired` vs `SessionNotFound` is the public distinction, by PIL-007's design.
- **17 (core sealed columns)**: makes `SessionRecord.ipAddress`/`userAgent` `Option<Sealed<string>>` and turns `toView`/`toItem` into effects (its §3 and §7). The verdict reads neither field, so `classify` and `afterLostRotation` are unaffected. If plan 17 lands first: the interpreter's `accepted(row)` becomes `Effect.map(toView(row), (session) => ({ session, rotated: Option.none() }))` and the `Rotated` branch maps `toView(outcome.session)` the same way; `SessionVerdict.test.ts`'s record builder fills the two fields with `Sealed.plain`. If this plan lands first, plan 17 makes those two edits in the interpreter. Order-free either way.
- **16 (sql-store-adapters)**: folds `Repositories.ts` into `SessionStoreSql`; the rotate compare-and-swap and the `Lost` re-read must keep their semantics (they are `StoreContract.sessions` cases). Order-free.
- **20 (in-process user agent)** and **21 (session-minting annotation)**: both observe rotation delivery and session minting from outside `Sessions`; the token format and delivery are unchanged.
- **18 (verification-link-redeem)**: independent; the same style of extraction (a pure codec plus a thin orchestration), no shared file. Both bump `spec/traceability.md`; whichever lands second takes the next revision.
- **24 (memory records over SQLite)**: would replace `SessionStore.layerMemory`; the verdict does not care which adapter answers.
- **12, 13, 14, 15, 19's other siblings (22, 23)**: none.

---

## 9. Acceptance checklist

- [ ] `packages/core/src/internal/sessionVerdict.ts` exports `parse`, `format`, `spanId`, `Policy`, `policyOf`, `Verdict`, `classify`, `AfterLost`, `afterLostRotation`, `DEFAULT_ROTATION_GRACE`; it imports neither `Sessions.ts` nor any Effect runtime module beyond `DateTime`/`Duration`/`Option`/`Brand`; no `as`.
- [ ] `SessionStore.expiryOf` exists; `isLive` is defined by it; `StoreContract.sessions` passes unchanged on every runner.
- [ ] `Sessions.verify` is an exhaustive interpreter of `Verdict` (`Match.valueTags` or `switch` + `absurd`), with no row-state branch of its own; `Sessions.ts` has no `indexOf(".")` and no `${id}.${secret}` template outside `format`.
- [ ] The phase 0 test passes: a rotation loser that finds the row expired publishes `auth.session.expired` with its kind.
- [ ] `SessionVerdict.test.ts`: the 19-row `classify` table, the `afterLostRotation`, codec and `expiryOf` tables, and properties P1–P9 pass; the file uses no `TestClock` and builds no layer.
- [ ] `Sessions.test.ts` has 68 cases (86 − 19 + 1) and 28 `TestClock.adjust` calls; the 19 tests of §5.3 are gone and the two folded assertions live in `:884` and `:1531`.
- [ ] `SessionToken.property.test.ts` and `pnpm test:bdd` pass unchanged.
- [ ] BEH-EA-049/052/053 (rev 1.8 of `07-sessions.md`), ESA-006 (rev 1.8 of `13-events.md`), ADR-EA-014 rev 1.4 and `spec/traceability.md` are updated; `pnpm spec:verify:strict` passes.
- [ ] `.changeset/session-verdict.md` exists with its `Migration:` line.
- [ ] `pnpm check` is green on the final commit.

---

## 10. Open questions only the user can answer

1. **The lost-race expiry event.** Recommended: publish `auth.session.expired` with its kind (ESA-006 says every expired presentation is announced). Alternative: keep today's silence and only fix the message's kind; the phase 0 test then asserts no event.
2. **A token that starts with `.`.** Recommended: treat it as opaque (offered to the legacy bridge, then `SessionNotFound` without an id, message "malformed"), the same rule the span already uses. Alternative: keep looking up the empty id (`SessionNotFound("")`). Neither is observable on the wire.
3. **Visibility of the verdict.** Recommended: package-private (`internal/`), because it is not a seam anyone substitutes and its shape should stay free to change. Alternative: export it as `Sessions.Verdict` for a third-party `Sessions` implementation or plan 11's diagnostics.
4. **Rotation loser semantics.** Recommended: unchanged (authenticate the winner's row without re-checking the secret and without a rotation of its own). Alternative: re-classify the winner's row fully, which would rotate again via the grace window and multiply rotations under concurrency; listed only so the choice is explicit.
5. **Where the concurrency integration tests run.** Recommended: over the memory store only, as today (`StoreContract.sessions` already proves the primitives' atomicity on SQLite, WAL and Postgres). Alternative: also run `:1012`, `:1225` and `:1648` over SQLite through `Persistence.sql()`, for an end-to-end race on a real adapter at the cost of a slower suite.
6. **Fold `SessionToken.property.test.ts` into the verdict suite?** Recommended: keep it as is (it is the end-to-end witness that any presented string is a typed `NotFound`, never a defect, through the real layer); the verdict's P8 covers the codec in isolation. Alternative: replace its first and third properties with P8 and keep only the two that need the layer.

---

## Decisions taken

Defaults for the six open questions (§10), all the recommended ones:

1. **Lost-race expiry**: published (`auth.session.expired` with its kind; the message is "idle-expired" for an idle expiry).
2. **A token starting with `.`**: opaque (bridge, then `SessionNotFound` without an id).
3. **Visibility**: package-private (`internal/sessionVerdict.ts`); `DEFAULT_ROTATION_GRACE` is re-exported from `Sessions.ts`.
4. **Rotation loser**: unchanged (authenticates the winner's row, no rotation of its own).
5. **Concurrency tests**: memory store only, as before.
6. **`SessionToken.property.test.ts`**: kept unchanged.

Divergences: phases 0, 1 and 2 landed as one commit (a red test cannot be committed alone, and knip flags the module until `verify` calls it, as §4 allows). `Sessions.test.ts` has 68 cases and 28 `TestClock.adjust` calls as planned; the `viaGrace` and family-revoked assertions were folded into the grace recovery test and the reuse test. `Rotation` is not exported (knip). `pnpm test:pg` was not run: no SQL adapter changed (`isLive`'s body is meaning-preserving and `StoreContract.sessions` passes on the memory and SQLite runners).
