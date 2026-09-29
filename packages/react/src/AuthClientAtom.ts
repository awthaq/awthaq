// @awthaq/react — AuthClientAtom
//
// spec/behaviors/22-client-effect.md, BEH-EA-169 (the reactive
// `AtomHttpApi.Service` alternative form this file builds);
// spec/behaviors/23-react.md, BEH-EA-177/178.
//
// `effect` itself ships `AtomHttpApi`/`Atom`/`AtomRegistry` natively at
// `effect/unstable/reactivity` (confirmed present in this repo's installed
// `effect@4.0.0-rc.115` dependency) — no external, v3-pinned
// `@effect-atom/atom` needed; see `@awthaq/client`'s `AuthClient.ts`
// header comment for the corrected history of that reasoning.
//
// `ReactAuthClient` is built against `@awthaq/api`'s `AuthCore.AuthCoreApi`
// specifically — the one fixed contract every awthaq composition serves
// regardless of which plugins are installed (a standalone `HttpApi` carrying
// only the core `session` group; see `@awthaq/api`'s `Session.ts` header
// comment) — because this module only owns the one thing every composition
// shares: the session. An application wanting reactive atoms for its own
// plugin endpoints (organizations, password sign-in, ...) builds them with
// `ReactClient.makeReactClient` over its own composed `auth.api` (BE-004).
//
// `SubjectContract.SubjectApi` (BEH-EA-026's `SubjectDto`, `@awthaq/api`'s
// own file — not `@awthaq/qadi`'s `SubjectApi.ts`, which attaches the
// real `AuthorizedSubject` middleware and would pull qadi's much heavier,
// server-only dependency graph into a browser bundle; see that file's own
// header comment) backs `subjectDtoAtom` — BEH-EA-179's other half.
//
// EAR-002/BEH-EA-179: the qadi subject is *not* `subjectDtoAtom` read on its
// own — that endpoint answers an anonymous `SubjectDto` for a signed-out
// caller, which would hand qadi a real (empty) subject after sign-out.
// `subjectAtom` is the one derivation Providers feeds qadi: `sessionAtom` is
// the gate, and the DTO only counts once the session is a settled, real one.
import { AuthCore, SubjectContract } from "@awthaq/api";
import type { AccountContract, Api, SessionContract } from "@awthaq/api";
import * as Data from "effect/Data";
import type * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Atom from "effect/unstable/reactivity/Atom";
import type { AuthSubject } from "@qadi/core";
import { SESSION_KEY, makeReactClient } from "./ReactClient.ts";
import { toSubject } from "./Subject.ts";

/**
 * The contract types `ReactAuthClient` and `sessionAtom` are built from,
 * named once in this module's own scope. Not a convenience alias: declaration
 * emit can only spell a type reachable through an in-scope import, and
 * `@awthaq/api` exposes these classes only as members of namespace re-exports
 * (`Api.Authentication`, `SessionContract.SessionDto`, ...) whose files a
 * consumer package's `tsc` cannot address by path — without these imports,
 * a clean `tsc -b` fails with TS2883 (incremental caches mask it), and the
 * only alternatives are return-type annotations on the atoms. Kept as a
 * public type because it doubles as documentation of what the core atoms
 * carry.
 */
export interface AuthCoreTypes {
  readonly session: SessionContract.SessionDto;
  readonly account: AccountContract.AccountDto;
  readonly middleware: Api.Authentication | Api.CsrfProtection;
  readonly errors: Api.Unauthenticated | Api.CsrfRejected | SessionContract.SessionNotFound;
}

export class ReactAuthClient extends makeReactClient<ReactAuthClient>()(
  "awthaq/react/ReactAuthClient",
  { api: AuthCore.AuthCoreApi },
) {}

const rawSessionAtom = ReactAuthClient.query("session", "current", {
  reactivityKeys: [SESSION_KEY],
});

/**
 * BEH-EA-177/178: the one session atom every `Providers` tree seeds for SSR
 * and every session-changing mutation invalidates via
 * `reactivityKeys: [SESSION_KEY]` — `sessionAtom = AuthClient.query("session",
 * "current", { reactivityKeys: [SESSION_KEY] })`'s own illustration, built
 * here once so every consumer reads the identical atom rather than each
 * defining its own equivalent query and accidentally tracking session state
 * twice under two different atoms.
 *
 * Wraps the raw query rather than exposing it directly: `AuthCoreApi`'s
 * `session` group is guarded by mandatory `Authentication`
 * (`@awthaq/api`'s `Session.ts` — a caller with no session has no
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
export const sessionAtom = Atom.readable(
  (get) => {
    const result = get(rawSessionAtom);
    if (AsyncResult.isFailure(result)) {
      const cause = AsyncResult.error(result);
      if (Option.isSome(cause) && cause.value._tag === "Unauthenticated") {
        return AsyncResult.success(null, { waiting: result.waiting });
      }
    }
    return result;
  },
  // Refreshing the wrapper means re-running the query it reads (`useAtomRefresh(sessionAtom)`).
  (refresh) => refresh(rawSessionAtom),
);

export class ReactSubjectClient extends makeReactClient<ReactSubjectClient>()(
  "awthaq/react/ReactSubjectClient",
  { api: SubjectContract.SubjectApi },
) {}

/**
 * BEH-EA-179: the raw subject half `subjectAtom` (below) is derived from —
 * `reactivityKeys: [SESSION_KEY]` too, the same key `sessionAtom`'s own
 * session-changing mutations already invalidate, since a subject can only
 * ever be as current as the session it was resolved for (sign-in, sign-out,
 * a role change behind a re-issued session all need to refetch both).
 */
export const subjectDtoAtom = ReactSubjectClient.query("subject", "current", {
  reactivityKeys: [SESSION_KEY],
});

/**
 * EAR-001/EAR-002/BEH-EA-179: the subject `Providers` feeds qadi —
 * `AuthSubject | undefined`, `undefined` meaning "no subject *yet*" so every
 * gate stays pending rather than momentarily granting or denying.
 *
 * `sessionAtom` is the gate: the subject exists only while the session is a
 * settled, real one (`Success`, non-`null`) *and* `subjectDtoAtom` has a
 * settled `Success` of its own. Consequences, each a registry-level fact and
 * not a render-timing hope:
 *
 * - sign-out (`sessionAtom` -> `success(null)`) makes the subject
 *   `undefined` in the same registry batch, so no render sees "signed out,
 *   still holding the old user's grants";
 * - a session-keyed mutation refetches both queries at once
 *   (`reactivityKeys: [SESSION_KEY]`), and the subject's own `waiting` closes
 *   the gate until it has settled against the new session, so a session
 *   swap never leaves the previous user's permissions visible;
 * - an anonymous visitor gets `undefined`, not the anonymous DTO
 *   `/subject` would answer (BEH-EA-179 states it; anonymous-permitted gates
 *   would be a spec amendment).
 *
 * `sessionAtom`'s own `waiting` is deliberately *not* part of the gate: a
 * background re-check of the session (window-focus revalidation) must not
 * blink every guarded control back to pending — if the session turned out
 * to be gone it settles to `success(null)`, which closes the gate anyway.
 *
 * Refreshing it (`useAtomRefresh(subjectAtom)`) re-runs both queries.
 */
export const subjectAtom = Atom.readable(
  (get): AuthSubject | undefined => {
    const session = get(sessionAtom);
    if (!AsyncResult.isSuccess(session) || session.value === null) return undefined;
    const dto = get(subjectDtoAtom);
    if (!AsyncResult.isSuccess(dto) || dto.waiting) return undefined;
    return toSubject(dto.value);
  },
  (refresh) => {
    refresh(sessionAtom);
    refresh(subjectDtoAtom);
  },
);

/**
 * EAR-006: what the auth pipeline is doing, as one value — replaces a
 * render-phase `console.error` that made a failed fetch indistinguishable
 * from "still loading". `Failed` is a persistent failure of either query
 * (a signed-out visitor is `SignedOut`, never `Failed`: `sessionAtom`
 * already translated that 401).
 */
export type AuthStatus = Data.TaggedEnum<{
  Pending: {};
  SignedOut: {};
  Ready: { readonly subject: AuthSubject };
  Failed: { readonly cause: Cause.Cause<unknown> };
}>;
export const AuthStatus = Data.taggedEnum<AuthStatus>();

export const authStatusAtom = Atom.readable(
  (get) => {
    const session = get(sessionAtom);
    if (AsyncResult.isFailure(session)) {
      return session.waiting ? AuthStatus.Pending() : AuthStatus.Failed({ cause: session.cause });
    }
    if (!AsyncResult.isSuccess(session)) return AuthStatus.Pending();
    if (session.value === null) return AuthStatus.SignedOut();
    const dto = get(subjectDtoAtom);
    if (AsyncResult.isFailure(dto) && !dto.waiting) return AuthStatus.Failed({ cause: dto.cause });
    const subject = get(subjectAtom);
    return subject === undefined ? AuthStatus.Pending() : AuthStatus.Ready({ subject });
  },
  (refresh) => refresh(subjectAtom),
);
