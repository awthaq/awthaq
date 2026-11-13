// @awthaq/core — CurrentUser
//
// GC-003: the one place a verified session's principal is re-branded into the
// domain (`Users.UserId`/`Sessions.SessionId` are nominal brands — no runtime
// check). `of` is that one re-brand; every user-tier handler in every plugin reads the caller
// through `current`, so "the principal must be a `User`" is written once.

import { Api } from "@awthaq/api";
import { Defects } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Sessions from "./Sessions.ts";
import * as Users from "./Users.ts";

/** GC-003: the caller of a user-tier group in domain terms; `actingAs` is BEH-EA-211's impersonating administrator. */
export interface Caller {
  readonly userId: Users.UserId;
  readonly sessionId: Sessions.SessionId;
  readonly actingAs: Option.Option<Sessions.ActingAs>;
}

/** GC-003: the one re-brand of a verified user principal into a `Caller`. */
export const of = (principal: Api.UserPrincipal): Caller => ({
  userId: Users.UserId(principal.ref.id),
  sessionId: Sessions.SessionId(principal.sessionId),
  actingAs: Option.map(Option.fromNullishOr(principal.actingAs), (ref) => ({
    type: ref.type,
    id: ref.id,
  })),
});

/**
 * GC-003: the caller of a user-tier group, re-branded into the domain. `Authentication` (the user tier)
 * admits only a `User` (`Credentials.userTier`), so anything else here is a wiring defect
 * (`Defects/InvariantViolation`, `invariant: "NonUserPrincipal"`), never a request-level condition.
 */
export const current = Effect.gen(function* () {
  const principal = yield* Api.CurrentPrincipal;
  if (principal._tag !== "User") {
    return yield* Defects.invariantViolation(
      "NonUserPrincipal",
      `awthaq: a user-tier group was reached with a non-User principal: ${principal._tag}`,
    );
  }
  return of(principal);
});
