// @awthaq/server — internal SessionDto
//
// RSC-005: the one `SessionView` -> `SessionDto` mapper, in a module of its own so that `SessionDelivery`
// (which delivers a minted session as a DTO) and the `session` handlers (which end sessions through
// `SessionDelivery`) can both use it without an import cycle. `Session.toSessionDto` re-exports it.

import { SessionContract } from "@awthaq/api";
import type { Sessions } from "@awthaq/core";
import * as Option from "effect/Option";

/**
 * RSC-005: the one `SessionView` -> `SessionDto` mapper. The password/admin/
 * passkey handlers used to each keep a private identical copy, and
 * `@awthaq/next`'s `toInitialSession` needs the same mapping to seed
 * `@awthaq/react`'s `Providers`. `current` defaults to `true` — the view a
 * sign-in/sign-up/`getSession` returns is, by construction, the caller's own.
 */
export const toSessionDto = (
  view: Sessions.SessionView,
  current = true,
): SessionContract.SessionDto =>
  new SessionContract.SessionDto({
    id: view.id,
    createdAt: view.createdAt,
    lastActiveAt: view.lastActiveAt,
    expiresAt: view.absoluteExpiresAt,
    userAgent: Option.getOrNull(view.userAgent),
    amr: view.amr,
    current,
  });
