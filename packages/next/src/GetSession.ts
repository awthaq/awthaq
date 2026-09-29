// @awthaq/next — GetSession
//
// spec/behaviors/24-nextjs-ssr.md, BEH-EA-185.
//
// The real, database-verified boundary: called from a React Server
// Component or a server action, it resolves the incoming request's session
// cookie against `@awthaq/core`'s `Sessions` service and returns the
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
// `@awthaq/qadi` entirely, the same stratum-layering rule that already
// forced `@awthaq/api`'s `Subject.ts`/`@awthaq/qadi`'s
// `SubjectApi.ts` split.
//
// Reuses `@awthaq/server`'s `Authentication.PrincipalResolver` — the
// one place a verified session already maps to a `Principal` — rather than
// reconstructing that mapping a second time here, which would duplicate a
// decision an application may have overridden (`spec/overview.md`'s "one
// source of truth per concept").
//
// Takes the runtime as an explicit argument; this package owns no
// `ManagedRuntime` construction of its own — see this package's README for
// the `globalThis`-pinned pattern a Next.js app needs to build one safely.

import { Api } from "@awthaq/api";
import { Sessions, Users } from "@awthaq/core";
import { Authentication } from "@awthaq/server";
import * as Effect from "effect/Effect";
import type * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { cache } from "react";
import { findCookieValue } from "./CookieHeader.ts";
import type { CookieJarLike } from "./WithNextCookies.ts";

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
  /**
   * BO-001/IC-001: `Sessions.verify` may rotate the session's secret on a
   * throttled touch (`Sessions.ts`'s own header: the old secret "stops
   * verifying immediately — no grace window"), and this field carries that
   * fresh token exactly when this call was the one that rotated it —
   * `undefined` otherwise. A Server Component render has no mutable cookie
   * jar to deliver it through (Next.js RSCs cannot set cookies at all); a
   * Server Action or Route Handler does, via `applyRotatedSession` below.
   */
  readonly rotated: Redacted.Redacted<string> | undefined;
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
    const { session, rotated } = yield* sessions.verify(Redacted.make(token));
    // RSC-007: independent of each other once `verify` has succeeded.
    const [user, principal] = yield* Effect.all(
      [users.findById(session.userId), resolver.resolve(session)],
      { concurrency: "unbounded" },
    );
    return { principal, user, session, rotated: Option.getOrUndefined(rotated) };
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
 * NSA-002: `React.cache()` — the framework-idiomatic per-request/per-render
 * dedup mechanism Next.js itself documents, scoped to exactly one render
 * pass or one Server Action invocation, never spanning across them (so it
 * doesn't relitigate BEH-EA-190's "a server action MUST call getSession
 * fresh on every invocation"). Two `getSession` calls against the same
 * cookie within one render/action now hit `sessions.verify` exactly once —
 * closing the "second call loses the rotation race" scenario structurally,
 * the same way ticket 03's `Authentication.ts` cache closed it for the HTTP
 * path (a `WeakMap` keyed on `HttpServerRequest` identity, which a Server
 * Component/Server Action never has — that mechanism doesn't reach here).
 */
const verifyCached = cache(
  (
    token: string,
    runtime: ManagedRuntime.ManagedRuntime<
      Sessions.Sessions | Users.Users | Authentication.PrincipalResolver,
      never
    >,
  ): Promise<Session | undefined> => runtime.runPromise(resolve(token)),
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
  return token === undefined ? Promise.resolve(undefined) : verifyCached(token, runtime);
};

/**
 * BO-001/IC-001: delivers `session.rotated`, if any, into `jar` — a no-op
 * when nothing rotated this call. Reuses `WithNextCookies.ts`'s
 * `CookieJarLike`/`Sessions.SESSION_COOKIE_ATTRIBUTES`, the same shape and
 * attribute set every other session-cookie write in this codebase already
 * uses, rather than inventing a second cookie-jar interface.
 *
 * Only a Server Action or Route Handler — both of which hold a mutable
 * `cookies()` jar per Next's own API — can call this meaningfully:
 * `applyRotatedSession(await getSession(await headers(), runtime), await cookies())`.
 * A pure Server Component render has no mutable jar at all; for that
 * context, delivering a mid-render rotation is a genuine Next.js platform
 * limitation, not something this function can work around. An app that is
 * 100% pure-RSC rendering with no Server Action/Route Handler traffic ever
 * touching a session can mitigate by raising `touchEvery` in its own
 * `SessionConfig`.
 */
export const applyRotatedSession = (session: Session | undefined, jar: CookieJarLike): void => {
  if (session?.rotated === undefined) return;
  jar.set(
    Api.SessionCookie.key,
    Redacted.value(session.rotated),
    Sessions.SESSION_COOKIE_ATTRIBUTES,
  );
};
