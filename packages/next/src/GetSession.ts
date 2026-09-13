// @effect-auth/next — GetSession
//
// spec/behaviors/24-nextjs-ssr.md, BEH-EA-185.
//
// The real, database-verified boundary: called from a React Server
// Component or a server action, it resolves the incoming request's session
// cookie against `@effect-auth/core`'s `Sessions` service and returns the
// principal, user, and session — or `undefined` for a missing, malformed,
// expired, or unknown-session cookie. `HasSessionCookie.ts`'s cheap
// presence-only check is the `proxy.ts`-only alternative; never treat that
// one as proof of anything this module alone establishes.
//
// Returns a 3-field struct, not `spec/overview.md`'s aspirational 4-field
// `SessionView` (which also carries a qadi `subject`) — resolving a subject
// stays the caller's own job, via `@qadi/core`'s `SubjectResolver.resolve`
// against this struct's `principal`. See `.scratch/next-package/spec.md`'s
// Implementation Decisions for why: it keeps this package off of
// `@effect-auth/qadi` entirely, the same stratum-layering rule that already
// forced `@effect-auth/api`'s `Subject.ts`/`@effect-auth/qadi`'s
// `SubjectApi.ts` split.
//
// Reuses `@effect-auth/server`'s `Authentication.PrincipalResolver` — the
// one place a verified session already maps to a `Principal` — rather than
// reconstructing that mapping a second time here, which would duplicate a
// decision an application may have overridden (`spec/overview.md`'s "one
// source of truth per concept").
//
// Takes the runtime as an explicit argument; this package owns no
// `ManagedRuntime` construction of its own — see this package's README for
// the `globalThis`-pinned pattern a Next.js app needs to build one safely.

import { Api } from "@effect-auth/api";
import { Sessions, Users } from "@effect-auth/core";
import { Authentication } from "@effect-auth/server";
import * as Effect from "effect/Effect";
import type * as ManagedRuntime from "effect/ManagedRuntime";
import * as Redacted from "effect/Redacted";
import { findCookieValue } from "./CookieHeader.ts";

/**
 * The minimal shape both `await headers()` (Next's `ReadonlyHeaders`, in a
 * Server Component or server action) and a Route Handler's `request.headers`
 * (the Web platform's own `Headers`) already satisfy — this module never
 * imports from `"next/headers"` itself.
 */
export interface HeadersLike {
  readonly get: (name: string) => string | null;
}

/** BEH-EA-185: what a valid, database-verified session resolves to. */
export interface Session {
  readonly principal: Api.Principal;
  readonly user: Users.UserRecord;
  readonly session: Sessions.SessionView;
}

/**
 * The percent-decoded value of the session cookie, or `undefined` if it's
 * missing or fails to decode. Degrades silently — never throws — since
 * this is untrusted client input.
 */
const cookieValue = (cookieHeader: string | null, name: string): string | undefined => {
  const raw = findCookieValue(cookieHeader, name);
  if (raw === undefined) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
};

const resolve = (token: string) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions.Sessions;
    const users = yield* Users.Users;
    const resolver = yield* Authentication.PrincipalResolver;
    const session = yield* sessions.verify(Redacted.make(token));
    const user = yield* users.findById(session.userId);
    const principal = yield* resolver.resolve(session);
    return { principal, user, session };
  }).pipe(
    // BEH-EA-185: "no valid session" — cookie names a session that doesn't
    // exist, has expired, or belongs to a user record that's gone — is the
    // one ordinary case, collapsed to `undefined` rather than a rejection.
    // A `PlatformError` (a real backing-store outage) is not caught here
    // and propagates, distinct from the ordinary case.
    Effect.catchTags({
      SessionNotFound: () => Effect.succeed(undefined),
      SessionExpired: () => Effect.succeed(undefined),
      UserNotFound: () => Effect.succeed(undefined),
    }),
  );

/**
 * BEH-EA-185: verifies the incoming request's session cookie against the
 * database. Resolves `undefined` — never throws, never rejects — for a
 * missing, malformed, expired, or unknown-session cookie; only a genuine
 * backing-store outage propagates as a rejection.
 */
export const getSession = <Extra = never>(
  headers: HeadersLike,
  runtime: ManagedRuntime.ManagedRuntime<
    Sessions.Sessions | Users.Users | Authentication.PrincipalResolver | Extra,
    never
  >,
): Promise<Session | undefined> => {
  const token = cookieValue(headers.get("cookie"), Api.SessionCookie.key);
  return token === undefined ? Promise.resolve(undefined) : runtime.runPromise(resolve(token));
};
