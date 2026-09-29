// @awthaq/server — internal CurrentUser
//
// GC-003: the one place a verified session's principal is re-branded into the
// domain (`Users.UserId`/`Sessions.SessionId` are nominal brands — no runtime
// check — so re-establishing them at every handler was a dozen unchecked
// casts). `Authentication` (required, not `OptionalAuthentication`) already
// refused the request before any handler ran, so a non-`User` principal
// reaching a required-auth group is a wiring defect, not a request-level
// condition a caller can act on.

import { Api } from "@awthaq/api";
import { Sessions, Users } from "@awthaq/core";
import * as Effect from "effect/Effect";
import { HandlerInvariantViolation } from "./Defects.ts";

export const currentUser = Effect.gen(function* () {
  const principal = yield* Api.CurrentPrincipal;
  if (principal._tag !== "User") {
    return yield* Effect.die(
      new HandlerInvariantViolation({
        invariant: "NonUserPrincipal",
        message: `awthaq: a required-auth group was reached with a non-User principal: ${principal._tag}`,
      }),
    );
  }
  return {
    principal,
    userId: Users.UserId(principal.ref.id),
    sessionId: Sessions.SessionId(principal.sessionId),
  };
});
