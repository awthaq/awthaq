// @awthaq/ports — Ids
//
// Plan 02 (ADR-EA-041): the identifier brands of the core entities, declared at the lowest stratum
// that names them, so a store port (`SessionStore`, `UserStore`, ...), its SQL adapter and the
// domain service all speak one type. MA-008: each brand is declared once, here; `@awthaq/sql`
// re-exports them from `Models.ts` (so every plugin's `SqlModels.UserId` keeps compiling) and
// `@awthaq/core` keeps only a nominal constructor.

import * as Schema from "effect/Schema";

export const UserId = Schema.String.pipe(Schema.brand("UserId"));
export type UserId = typeof UserId.Type;

export const AccountId = Schema.String.pipe(Schema.brand("AccountId"));
export type AccountId = typeof AccountId.Type;

export const SessionId = Schema.String.pipe(Schema.brand("SessionId"));
export type SessionId = typeof SessionId.Type;

export const VerificationTokenId = Schema.String.pipe(Schema.brand("VerificationTokenId"));
export type VerificationTokenId = typeof VerificationTokenId.Type;

/**
 * SOS-008/FAMS-002: the stored shape of `users.phone` — E.164 (`+` and 2-15 digits, no leading
 * zero after the `+`). `@awthaq/core`'s `Phone.ts` owns the normalizer that mints it.
 */
export const E164 = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\+[1-9]\d{1,14}$/)),
  Schema.brand("E164"),
);
export type E164 = typeof E164.Type;
