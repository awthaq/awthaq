// @effect-auth/react — AuthClientAtom
//
// spec/behaviors/22-client-effect.md, BEH-EA-169 (the reactive
// `AtomHttpApi.Service` alternative form this file builds);
// spec/behaviors/23-react.md, BEH-EA-177/178.
//
// `effect` itself ships `AtomHttpApi`/`Atom`/`AtomRegistry` natively at
// `effect/unstable/reactivity` (confirmed present in this repo's installed
// `effect@4.0.0-rc.115` dependency) — no external, v3-pinned
// `@effect-atom/atom` needed; see `@effect-auth/client`'s `AuthClient.ts`
// header comment for the corrected history of that reasoning.
//
// `ReactAuthClient` is built against `@effect-auth/api`'s `AuthCore.AuthCoreApi`
// specifically — the one fixed contract every effect-auth composition serves
// regardless of which plugins are installed (a standalone `HttpApi` carrying
// only the core `session` group; see `@effect-auth/api`'s `Session.ts` header
// comment) — not the application's own full, per-composition
// `Auth.make`-derived `api`, whose shape this package cannot know generically.
// An application wanting reactive atoms for its own plugin endpoints (e.g.
// Password's sign-in mutation) builds its own `AtomHttpApi.Service` directly
// against its own composed `api`, the same way it already builds its own
// `Auth`/`AuthPlugin` classes (ADR-EA-005/008) — this module only owns the
// one thing every composition shares: the session.
// `SubjectContract.SubjectApi` (BEH-EA-026's `SubjectDto`, `@effect-auth/api`'s
// own file — not `@effect-auth/qadi`'s `SubjectApi.ts`, which attaches the
// real `AuthorizedSubject` middleware and would pull qadi's much heavier,
// server-only dependency graph into a browser bundle; see that file's own
// header comment) backs `subjectDtoAtom` — BEH-EA-179's other half, composed
// with `sessionAtom` in `Providers.tsx`, not merged into one query.
import { AuthCore, SubjectContract } from "@effect-auth/api";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/unstable/http";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as AtomHttpApi from "effect/unstable/reactivity/AtomHttpApi";

export class ReactAuthClient extends AtomHttpApi.Service<ReactAuthClient>()(
  "effect-auth/react/ReactAuthClient",
  {
    api: AuthCore.AuthCoreApi,
    httpClient: FetchHttpClient.layer,
  },
) {}

const rawSessionAtom = ReactAuthClient.query("session", "current", {
  reactivityKeys: ["session"],
});

/**
 * BEH-EA-177/178: the one session atom every `Providers` tree seeds for SSR
 * and every session-changing mutation invalidates via
 * `reactivityKeys: ["session"]` — `sessionAtom = AuthClient.query("session",
 * "current", { reactivityKeys: ["session"] })`'s own illustration, built
 * here once so every consumer reads the identical atom rather than each
 * defining its own equivalent query and accidentally tracking session state
 * twice under two different atoms.
 *
 * Wraps the raw query rather than exposing it directly: `AuthCoreApi`'s
 * `session` group is guarded by mandatory `Authentication`
 * (`@effect-auth/api`'s `Session.ts` — a caller with no session has no
 * session to look up), so the raw query fails `Unauthenticated` for every
 * anonymous visitor instead of resolving — the opposite of
 * `subjectDtoAtom`'s own `OptionalAuthentication`-backed guarantee that it
 * always resolves. `sessionAtom` translates that one specific,
 * always-expected failure into `AsyncResult.success(null)` — "confirmed, no
 * session" — so every consumer sees one honest three-state contract
 * (pending / `null` / a real `SessionDto`), never a raw 401 for the
 * ordinary logged-out case; any *other* failure (a genuine network/server
 * error) still surfaces as a real `AsyncResult.Failure`, not swallowed.
 */
export const sessionAtom = Atom.make((get) => {
  const result = get(rawSessionAtom);
  if (AsyncResult.isFailure(result)) {
    const cause = AsyncResult.error(result);
    if (Option.isSome(cause) && cause.value._tag === "Unauthenticated") {
      return AsyncResult.success(null);
    }
  }
  return result;
});

export class ReactSubjectClient extends AtomHttpApi.Service<ReactSubjectClient>()(
  "effect-auth/react/ReactSubjectClient",
  {
    api: SubjectContract.SubjectApi,
    httpClient: FetchHttpClient.layer,
  },
) {}

/**
 * BEH-EA-179: the subject half `Providers.tsx`'s `toSubject` reads —
 * `reactivityKeys: ["session"]` too, the same key `sessionAtom`'s own
 * session-changing mutations already invalidate, since a subject can only
 * ever be as current as the session it was resolved for (sign-in, sign-out,
 * a role change behind a re-issued session all need to refetch both).
 */
export const subjectDtoAtom = ReactSubjectClient.query("subject", "current", {
  reactivityKeys: ["session"],
});
