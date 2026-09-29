// @awthaq/two-factor — Challenge
//
// THS-001 step 5, TTE-008, THS-007 (BEH-EA-262; ADR-EA-020 decision 2): the pre-session state of a
// sign-in that passed its first factor and now owes a second, as a small state machine the type
// system enforces.
//
// The state lives in `Verification` (not a cookie): `verification.issue` under the identifier
// `two-factor-challenge:<userId>`. Issuing supersedes any earlier live challenge for that identifier
// (one live challenge per account), the value is single-use, and every failed or replayed consume
// publishes `auth.token.replay` (BEH-EA-059). The `challengeId` the client holds is
// `two-factor-challenge:<userId>.<value>` — the user id is not a secret here (`TwoFactorRequired`
// already tells the client whose second factor is owed), and because the identifier is derived from
// the claimed user, a challenge minted for user A cannot be consumed as user B's.
//
// The payload carries what the finished sign-in needs: the first factor's `strategy` (for the
// audit trail), its `amr` (so the session records `[...amr, "otp", "mfa"]`) and how many wrong codes
// this sign-in has spent (`attempt`).
//
// Three types, in order — each producible only by the step before it:
//
// - `ConsumedChallenge`: `consumeChallenge` proved the caller holds a live challenge and spent it.
// - `FactorProof`: `SecondFactor.check` checked a code against the user's factor and it passed.
// - `VerifiedChallenge`: the two together, for the *same* user. It is a brand whose constructor is
//   private to this module, and `finalizeSignIn` — the one place this plugin calls `Sessions.issue`
//   — accepts nothing else, so "a session minted without a verified second factor" does not type-check.

import { Sessions, Users } from "@awthaq/core";
import { Defects } from "@awthaq/ports";
import * as Brand from "effect/Brand";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** The `Verification` purpose prefix; the row's identifier is `two-factor-challenge:<userId>`. */
export const CHALLENGE_PURPOSE = "two-factor-challenge";

/** The wire form of a challenge id — opaque to the client. Minted only by `SecondFactor.issueChallenge`. */
export type TwoFactorChallengeId = string & Brand.Brand<"TwoFactorChallengeId">;
export const TwoFactorChallengeId = Brand.nominal<TwoFactorChallengeId>();

/** What `issueChallenge` stores with the row and `consumeChallenge` hands back. */
export const ChallengePayload = Schema.Struct({
  strategy: Schema.String,
  amr: Schema.Array(Schema.String),
  attempt: Schema.Number,
});
export type ChallengePayload = typeof ChallengePayload.Type;

/** A live challenge that has just been spent. Its user has still proven only one factor. */
export interface ConsumedChallenge {
  readonly userId: Users.UserId;
  /** The first factor's strategy (`password`, an OAuth provider id, `passkey`, ...). */
  readonly strategy: string;
  /** How the first factor authenticated, as known session methods. */
  readonly amr: ReadonlyArray<Sessions.AuthMethod>;
  /** Wrong codes already spent on this sign-in (0 for the first challenge). */
  readonly attempt: number;
}

export type TwoFactorMethodUsed = "totp" | "recovery";

/**
 * A code presented for `userId` was checked against their second factor and passed (and, for a
 * recovery code, was spent). Minted only by `SecondFactor.check`.
 */
export type FactorProof = {
  readonly userId: Users.UserId;
  readonly method: TwoFactorMethodUsed;
} & Brand.Brand<"TwoFactorFactorProof">;

export type VerifiedChallenge = ConsumedChallenge & {
  readonly method: TwoFactorMethodUsed;
} & Brand.Brand<"TwoFactorVerifiedChallenge">;

// The one constructor — not exported, so only `verified` below can mint the brand.
const brand = Brand.nominal<VerifiedChallenge>();

/**
 * Joins a spent challenge with a proof that the same user's second factor passed. A proof for a
 * different user is a programming error, never a runtime condition (both come from one request's
 * own flow), so it is refused as a defect rather than silently minting a session for the wrong person.
 */
export const verified = (
  challenge: ConsumedChallenge,
  proof: FactorProof,
): Effect.Effect<VerifiedChallenge> =>
  challenge.userId === proof.userId
    ? Effect.succeed(brand({ ...challenge, method: proof.method }))
    : Defects.invariantViolation(
        "TwoFactorProofMismatch",
        "awthaq: a second-factor proof was joined to another user's challenge",
      );
