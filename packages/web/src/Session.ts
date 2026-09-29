// @awthaq/web — Session
//
// spec/behaviors/24-nextjs-ssr.md, BEH-EA-185.
//
// The real, database-verified boundary: called from a server component, a
// server action, a load function or an endpoint, it resolves the incoming request's session
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
// `ManagedRuntime` construction of its own — see `@awthaq/next`'s README for
// the `globalThis`-pinned pattern a Next.js app needs to build one safely.
//
// BO-004: framework-neutral. The one framework-specific decision — how a
// per-render dedup of `verify` is done (Next: `React.cache`) — is injected
// through `makeGetSession`; the plain `getSession` here does not dedupe.

import { Api } from "@awthaq/api";
import { SessionCookie, Sessions, Users } from "@awthaq/core";
import { Authentication } from "@awthaq/server";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { findCookieValue } from "./CookieHeader.ts";
import type { HeadersLike } from "./CookieHeader.ts";
import { setCookie } from "./CookieJar.ts";
import type { CookieJarLike } from "./CookieJar.ts";

/**
 * BEH-EA-185: what a valid, database-verified session resolves to.
 *
 * RSC-005: a server-only shape — `SessionView`/`UserRecord` carry `DateTime`,
 * `Option` and the rotated secret, and none of it may become a Client
 * Component prop. Cross to the client through `@awthaq/next`'s `toInitialSession`.
 */
export interface Session {
  readonly principal: Api.Principal;
  readonly user: Users.UserRecord;
  readonly session: Sessions.SessionView;
  /**
   * BO-001/IC-001: `Sessions.verify` may rotate the session's secret on a
   * throttled touch (`Sessions.ts`'s own header: the old secret keeps
   * verifying only for `SessionConfig.rotationGrace`), and this field carries that
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
      "Sessions/NotFound": () => Effect.succeed(undefined),
      SessionExpired: () => Effect.succeed(undefined),
      UserNotFound: () => Effect.succeed(undefined),
    }),
  );

/** The services `getSession` needs; a runtime may carry more (`Extra`). */
export type SessionServices = Sessions.Sessions | Users.Users | Authentication.PrincipalResolver;

export type SessionRuntime = ManagedRuntime.ManagedRuntime<SessionServices, never>;

/**
 * Verifies one session token against the database — the unit `getSession`
 * calls per candidate cookie, and the seam an adapter wraps to dedupe per
 * render (`makeGetSession`).
 */
export type VerifySessionToken = (
  token: string,
  runtime: SessionRuntime,
) => Promise<Session | undefined>;

export const verifySessionToken: VerifySessionToken = (token, runtime) =>
  runtime.runPromise(resolve(token));

/**
 * BEH-EA-185: builds a `getSession` over `verify`. `@awthaq/next` passes
 * `React.cache(verifySessionToken)` — NSA-002, the framework-idiomatic
 * per-request/per-render dedup, scoped to exactly one render pass or one
 * Server Action invocation, never spanning across them (so it doesn't
 * relitigate BEH-EA-190's "a server action MUST call getSession fresh on every
 * invocation") — so two calls against the same cookie within one render hit
 * `sessions.verify` exactly once, closing the "second call loses the rotation
 * race" scenario structurally. An adapter with no such primitive (SvelteKit's
 * `event.locals`, Astro's `Astro.locals`) memoizes in its own request scope,
 * or uses the plain `getSession` below.
 */
export const makeGetSession =
  (verify: VerifySessionToken) =>
  <Extra = never>(
    headers: HeadersLike,
    runtime: ManagedRuntime.ManagedRuntime<SessionServices | Extra, never>,
  ): Promise<Session | undefined> => {
    const cookieHeader = headers.get("cookie");
    const token = cookieValue(cookieHeader, Api.SessionCookie.key);
    // APS-006: a live impersonation cookie shadows the caller's own session, the
    // same precedence `Api.Authentication` applies; only a session carrying
    // `actingAs` counts from it, otherwise fall through to the ordinary cookie.
    const impersonationToken = cookieValue(cookieHeader, Api.ImpersonationCookie.key);
    const own = () => (token === undefined ? Promise.resolve(undefined) : verify(token, runtime));
    if (impersonationToken === undefined) return own();
    return verify(impersonationToken, runtime).then((impersonated) =>
      impersonated !== undefined && Option.isSome(impersonated.session.actingAs)
        ? impersonated
        : own(),
    );
  };

/**
 * BEH-EA-185: verifies the incoming request's session cookie against the
 * database. Resolves `undefined` — never throws, never rejects — for a
 * missing, malformed, expired, or unknown-session cookie; only a genuine
 * backing-store outage propagates as a rejection.
 */
export const getSession = makeGetSession(verifySessionToken);

/**
 * BO-001/IC-001: delivers `session.rotated`, if any, into `jar` — a no-op
 * when nothing rotated this call. Reuses `CookieJar.ts`'s
 * `CookieJarLike`/`Sessions.SESSION_COOKIE_ATTRIBUTES`, the same shape and
 * attribute set every other session-cookie write in this codebase already
 * uses, rather than inventing a second cookie-jar interface.
 *
 * Only a Server Action, Route Handler, endpoint or load function — which hold
 * a mutable cookie jar (`cookies()` in Next, `event.cookies` in SvelteKit) —
 * can call this meaningfully:
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
  // IC-007: rendered by the shared `SessionCookie` renderer under the default
  // config (this adapter has no Effect context to read a custom one from), so
  // a rotation carries the same attributes as every other write, with a
  // `Max-Age` recomputed from the session's remaining absolute lifetime.
  const cookie = SessionCookie.renderAt(
    SessionCookie.SessionCookieConfig.defaultValue(),
    Redacted.value(session.rotated),
    session.session.absoluteExpiresAt,
    DateTime.nowUnsafe(),
  );
  const { maxAge, partitioned, ...rest } = cookie.options;
  setCookie(jar, cookie.name, cookie.value, {
    ...rest,
    ...(maxAge === undefined ? {} : { maxAge: Math.floor(Duration.toSeconds(maxAge)) }),
    ...(partitioned === undefined ? {} : { partitioned }),
  });
};
