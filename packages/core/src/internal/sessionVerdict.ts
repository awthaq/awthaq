// @awthaq/core — internal/sessionVerdict
//
// BEH-EA-049..056, RRS-003, RRS-005 (ADR-EA-014 rev 1.4): what a presented session credential means,
// as a pure function of the stored row, the presented secret's hash, the instant and the policy.
// `Sessions.verify` executes the verdict against `SessionStore`; the store's own atomic preconditions
// stay authoritative (a verdict is advisory). Package-private: `core/package.json` exports only ".".
// Imports `@awthaq/ports` and `../SecretHash.ts` only, never `../Sessions.ts` (scripts/circular.mjs
// fails type-only cycles).
//
// The order of the checks is the contract: the secret is proven before any row state is consulted
// (PIL-007), and the tombstone is checked before expiry (RRS-003). Historical note (upstream-hardening
// ticket 03): a rotation is compare-and-swapped against the hash this verdict read, so a losing
// concurrent request never clobbers a winner's write with its own independently-generated secret.

import { type Ids, SessionStore } from "@awthaq/ports";
import * as Brand from "effect/Brand";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as SecretHash from "../SecretHash.ts";

const sessionId = Brand.nominal<Ids.SessionId>();

// ---- the token codec (BEH-EA-049) -------------------------------------------------------------

export type Presented =
  /** No id before a `.`: never a session token of ours; the legacy bridge may know it (BAM-003). */
  | { readonly _tag: "Opaque"; readonly raw: string }
  | { readonly _tag: "Credential"; readonly id: Ids.SessionId; readonly secret: string };

/** Split at the first `.`; the id must be non-empty (an id never contains `.`; a secret may be empty, and then never matches). */
export const parse = (raw: string): Presented => {
  const separator = raw.indexOf(".");
  return separator > 0
    ? {
        _tag: "Credential",
        id: sessionId(raw.slice(0, separator)),
        secret: raw.slice(separator + 1),
      }
    : { _tag: "Opaque", raw };
};

export const format = (id: Ids.SessionId, secret: string): string => `${id}.${secret}`;

/** MW-001: the id half, when it is safe to put on a span (attacker-controlled: id-shaped and bounded only). */
export const spanId = (presented: Presented): Option.Option<string> =>
  presented._tag === "Credential" && /^[A-Za-z0-9-]{1,64}$/.test(presented.id)
    ? Option.some(presented.id)
    : Option.none();

// ---- the policy ------------------------------------------------------------------------------

/** RRS-005: the bounded window `SessionConfig.rotationGrace` defaults to. */
export const DEFAULT_ROTATION_GRACE = Duration.seconds(30);

/** The part of `SessionConfig` a verdict reads, with the grace default applied once. */
export interface Policy {
  readonly touchEvery: Duration.Duration;
  readonly idle: Duration.Duration;
  readonly grace: Duration.Duration;
}

export const policyOf = (config: {
  readonly touchEvery: Duration.Duration;
  readonly idle: Duration.Duration;
  readonly rotationGrace?: Duration.Duration | undefined;
}): Policy => ({
  touchEvery: config.touchEvery,
  idle: config.idle,
  grace: config.rotationGrace ?? DEFAULT_ROTATION_GRACE,
});

// ---- the verdict -----------------------------------------------------------------------------

/** What a compare-and-swap rotation writes; `expectedSecretHash` is the hash this verdict read. */
interface Rotation {
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
 * - `Rotate`   `SessionStore.rotate` (compare-and-swap); `Rotated` publishes `auth.session.rotated` and
 *              hands back the new token; `Lost` is settled by `afterLostRotation`.
 */
export type Verdict =
  | { readonly _tag: "Unknown" }
  | { readonly _tag: "Refused" }
  | { readonly _tag: "Replayed"; readonly flagReuse: boolean }
  | {
      readonly _tag: "Expired";
      readonly kind: "absolute" | "idle";
      readonly row: SessionStore.SessionRecord;
    }
  | { readonly _tag: "Accepted"; readonly row: SessionStore.SessionRecord }
  | {
      readonly _tag: "Rotate";
      readonly row: SessionStore.SessionRecord;
      /** RRS-005: the presented secret was the previous one, inside its window. */
      readonly viaGrace: boolean;
      readonly rotation: Rotation;
    };

/**
 * RRS-005: which of a session's accepted secrets the presented hash is. Both comparisons always run
 * (the previous one against `NEVER_MATCHES` when there is none), so the work done does not reveal
 * whether the row has a live grace window. A previous secret only counts before its own expiry.
 */
const matched = (
  row: SessionStore.SessionRecord,
  presentedHash: string,
  now: DateTime.Utc,
): "current" | "previous" | "none" => {
  const previousHash = Option.getOrUndefined(row.previousSecretHash);
  const previousExpiresAt = Option.getOrUndefined(row.previousSecretExpiresAt);
  const current = SecretHash.equals(presentedHash, row.secretHash);
  const previous = SecretHash.equals(presentedHash, previousHash ?? SecretHash.NEVER_MATCHES);
  if (current) return "current";
  return previous &&
    previousHash !== undefined &&
    previousExpiresAt !== undefined &&
    DateTime.toEpochMillis(now) < DateTime.toEpochMillis(previousExpiresAt)
    ? "previous"
    : "none";
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
  // RRS-003: checked before expiry; only the current secret of an unflagged tombstone is reuse. A
  // previous secret inside its grace window is a stale-but-legitimate holder, never a family-revoking
  // signal (RRS-005).
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
          ? Option.some({
              hash: row.secretHash,
              expiresAt: DateTime.addDuration(now, policy.grace),
            })
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
  | {
      readonly _tag: "Expired";
      readonly kind: "absolute" | "idle";
      readonly row: SessionStore.SessionRecord;
    }
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
