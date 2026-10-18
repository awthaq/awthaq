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
// Reuses `@awthaq/server`'s `Credentials.PrincipalResolver` — the
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

import type { Api } from "@awthaq/api";
import { SessionCookie, Sessions, Users } from "@awthaq/core";
import { Credentials } from "@awthaq/server";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
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
  /** The user tier admits only a `User` (`Credentials.userTier`). */
  readonly principal: Api.UserPrincipal;
  readonly user: Users.UserRecord;
  readonly session: Sessions.SessionView;
  /**
   * BO-001/IC-001: `Sessions.verify` may rotate the session's secret on a
   * throttled touch (`Sessions.ts`'s own header: the old secret keeps
   * verifying only for `SessionConfig.rotationGrace`), and this field carries that
   * fresh token exactly when this call was the one that rotated it —
   * `undefined` otherwise — with the cookie already rendered under the
   * runtime's `SessionCookieConfig` (name, `Domain`, `SameSite`, and a `Max-Age`
   * from the runtime `Clock`) for the cookie kind it came in on. A Server
   * Component render has no mutable cookie jar to deliver it through
   * (Next.js RSCs cannot set cookies at all); a Server Action or Route Handler
   * does, via `applyRotatedSession` below.
   */
  readonly rotated:
    | { readonly token: Redacted.Redacted<string>; readonly cookie: SessionCookie.RenderedCookie }
    | undefined;
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

/**
 * BEH-EA-185: the whole cookie header resolved through `Credentials` under the user tier (ADR-EA-042): the
 * impersonation cookie, then the session cookie, each under the runtime's `SessionCookieConfig` (IC-007), falling
 * through exactly as `Api.Authentication` does. "No valid session" (nothing presented, or nothing resolves, or the
 * session's user is gone) is the one ordinary case, `undefined`. A `StoreUnavailable` (a real backing-store outage)
 * is not caught and propagates as a rejection.
 */
const resolveCookies = (cookieHeader: string | null) =>
  Effect.gen(function* () {
    const users = yield* Users.Users;
    const base = yield* Credentials.PrincipalResolver;
    // RSC-007: the user lookup runs beside the principal resolution, not after it, by decorating the resolver the
    // module uses for this one call (no interface change to Credentials).
    const found = yield* Ref.make(Option.none<Users.UserRecord>());
    const alongside = Credentials.PrincipalResolver.of({
      resolve: (session) =>
        Effect.all([base.resolve(session), users.findById(session.userId).pipe(Effect.option)], {
          concurrency: "unbounded",
        }).pipe(
          Effect.tap(([, user]) => Ref.set(found, user)),
          Effect.map(([principal]) => principal),
        ),
    });
    const credentials = yield* Credentials.make.pipe(
      Effect.provideService(Credentials.PrincipalResolver, alongside),
    );
    const { scope, rotations } = yield* Credentials.collecting;
    const presented = yield* Credentials.presented({
      cookie: (name) => cookieValue(cookieHeader, name),
      header: () => undefined,
    });
    const resolved = yield* credentials.resolve(presented, Credentials.userTier, scope);
    // A cookie-only call presents nothing claimable.
    if (resolved._tag === "Claimed") return undefined;
    const user = yield* Ref.get(found);
    // BEH-EA-185: the session's user is gone.
    if (Option.isNone(user)) return undefined;
    // Only the resolved session's rotation is rendered: a planted ordinary session's rotation in the
    // impersonation cookie is collected but dropped (it fails after `rotationGrace` and the request falls through).
    const own = (yield* rotations).find((rotation) => rotation.session.id === resolved.session.id);
    const rotated =
      own === undefined
        ? undefined
        : {
            token: own.token,
            cookie: yield* SessionCookie.render(
              own.session,
              own.token,
              own.carrier === "impersonation" ? "impersonation" : "session",
            ),
          };
    return { principal: resolved.principal, user: user.value, session: resolved.session, rotated };
  }).pipe(Effect.catchTag("Unauthenticated", () => Effect.succeed(undefined)));

/** The services `getSession` needs; a runtime may carry more (`Extra`). */
export type SessionServices = Sessions.Sessions | Users.Users | Credentials.PrincipalResolver;

export type SessionRuntime = ManagedRuntime.ManagedRuntime<SessionServices, never>;

/**
 * The unit an adapter dedupes per render (`@awthaq/next`: `React.cache(resolveSessionCookies)`): the whole
 * cookie-header resolution, so the precedence, both verifies and the rotation's rendering are one unit. Within one
 * render `headers().get("cookie")` is the same string and the runtime the same object.
 */
export type ResolveSessionCookies = (
  cookieHeader: string | null,
  runtime: SessionRuntime,
) => Promise<Session | undefined>;

export const resolveSessionCookies: ResolveSessionCookies = (cookieHeader, runtime) =>
  runtime.runPromise(resolveCookies(cookieHeader));

/**
 * BEH-EA-185: builds a `getSession` over the cookie-header resolution. `@awthaq/next` passes
 * `React.cache(resolveSessionCookies)` — NSA-002, the framework-idiomatic per-request/per-render
 * dedup, scoped to exactly one render pass or one Server Action invocation, never spanning across them (so it
 * doesn't relitigate BEH-EA-190's "a server action MUST call getSession fresh on every invocation") — so two calls
 * against the same cookie header within one render hit `sessions.verify` exactly once, closing the "second call
 * loses the rotation race" scenario structurally. An adapter with no such primitive (SvelteKit's `event.locals`,
 * Astro's `Astro.locals`) memoizes in its own request scope, or uses the plain `getSession` below.
 */
export const makeGetSession =
  (resolveCookieHeader: ResolveSessionCookies) =>
  <Extra = never>(
    headers: HeadersLike,
    runtime: ManagedRuntime.ManagedRuntime<SessionServices | Extra, never>,
  ): Promise<Session | undefined> =>
    resolveCookieHeader(headers.get("cookie"), runtime);

/**
 * BEH-EA-185: verifies the incoming request's session cookie against the
 * database. Resolves `undefined` — never throws, never rejects — for a
 * missing, malformed, expired, or unknown-session cookie; only a genuine
 * backing-store outage propagates as a rejection.
 */
export const getSession = makeGetSession(resolveSessionCookies);

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
  // BO-001/IC-007: already rendered under the runtime's config (name, attributes, `Max-Age`
  // from the runtime clock); nothing to look up or get wrong here.
  const { maxAge, partitioned, ...rest } = session.rotated.cookie.options;
  setCookie(jar, session.rotated.cookie.name, session.rotated.cookie.value, {
    ...rest,
    ...(maxAge === undefined ? {} : { maxAge: Math.floor(Duration.toSeconds(maxAge)) }),
    ...(partitioned === undefined ? {} : { partitioned }),
  });
};
