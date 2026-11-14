// @awthaq/test — minting without HTTP: request facts (ADR-EA-047), sessions (BEH-EA-197) and CSRF tokens (BEH-EA-T3), behind the TestAuth facade (spec/behaviors/25-testing-harness.md).
import { Api } from "@awthaq/api";
import { SessionCookie, Sessions, Users } from "@awthaq/core";
import { createHmac, randomBytes } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Cookies from "effect/http/Cookies";

/**
 * ADR-EA-047: runs `self` as if it answered an HTTP request with these facts: an in-process unit test of a plugin
 * operation that records or keys on the request. The correlation id defaults to `"test"`.
 */
export const withRequest =
  (
    facts: {
      readonly ip?: string | undefined;
      readonly userAgent?: string | undefined;
      readonly correlationId?: string | undefined;
    } = {},
  ) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.provideService(
      self,
      Api.AuthRequestContext,
      Api.AuthRequestContext.request({ ...facts, correlationId: facts.correlationId ?? "test" }),
    );

/** ADR-EA-047: runs `self` as in-process work that answers no request (a job, a CLI command). */
export const withoutRequest = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.provideService(self, Api.AuthRequestContext, Api.AuthRequestContext.noRequest);

export interface SignedInSession {
  readonly userId: Users.UserId;
  readonly token: Redacted.Redacted<string>;
  /**
   * The session's `Set-Cookie`, rendered under the composition's own `SessionCookieConfig` (name, `Domain`,
   * `SameSite`, `Max-Age`): hand it to an agent with `agent.cookies.receive(setCookie)`.
   */
  readonly setCookie: string;
}

/** Serialises a cookie Effect's `Cookies` accepts; a value it refuses is a defect of the fixture. */
const serialize = (name: string, value: string, options: Cookies.Cookie["options"]) =>
  Effect.fromResult(Cookies.makeCookie(name, value, options)).pipe(
    Effect.map(Cookies.serializeCookie),
    Effect.orDie,
  );

/**
 * The `Set-Cookie` the server would answer for `issued`, rendered under the ambient `SessionCookieConfig` (the
 * composition's, inside `app.run`): for a session issued straight against `Sessions` (an existing user, a second
 * session of one user), handed to an agent with `agent.cookies.receive(...)`.
 */
export const sessionSetCookie = (issued: Sessions.IssuedSession) =>
  Effect.gen(function* () {
    const rendered = yield* SessionCookie.render(issued.session, issued.token);
    return yield* serialize(rendered.name, rendered.value, rendered.options);
  });

/**
 * BEH-EA-197: mints a real user and a real session directly against
 * `Users`/`Sessions` — no password, no HTTP round trip — so an
 * authorization test's setup cost is independent of whichever credential
 * plugin (if any) is installed, matching this behavior's own point: testing
 * *authorization*, not sign-up. The cookie is rendered under the ambient
 * `SessionCookieConfig`, the one the composition's server reads.
 */
export const signInAs = (input: {
  readonly email: string;
  readonly name?: string;
  readonly onSignedUp?: (userId: Users.UserId) => Effect.Effect<void>;
  /** How the session says the user authenticated (`["pwd"]`, `["fed"]`, ...); none by default. */
  readonly amr?: ReadonlyArray<Sessions.AuthMethod>;
  /** ADR-EA-047: the request the session records (`withRequest`'s facts); by default none (`noRequest`). */
  readonly request?: Parameters<typeof withRequest>[0];
}): Effect.Effect<SignedInSession, never, Users.Users | Sessions.Sessions> =>
  Effect.gen(function* () {
    const users = yield* Users.Users;
    const sessions = yield* Sessions.Sessions;
    const user = yield* users
      .create({ identity: { _tag: "Email", email: input.email }, name: input.name ?? input.email })
      .pipe(Effect.orDie);
    if (input.onSignedUp !== undefined) {
      yield* input.onSignedUp(user.id);
    }
    const issued = yield* sessions
      .issue({ userId: user.id, ...(input.amr === undefined ? {} : { amr: input.amr }) })
      .pipe(
        input.request === undefined ? withoutRequest : withRequest(input.request),
        Effect.orDie,
      );
    return { userId: user.id, token: issued.token, setCookie: yield* sessionSetCookie(issued) };
  });

/**
 * BEH-EA-T3: a signed double-submit CSRF token (`<iat>.<random>.<hmac>`), computed with `node:crypto`
 * independently of `Csrf.ts`'s own implementation, so a passing request proves RFC 2104 compatibility and
 * not mere self-consistency with the code under test. Valid for the secret it was minted against.
 */
export const csrfToken = (
  secret: Redacted.Redacted<string> | string,
  options?: {
    /** The `iat` in seconds; defaults to the wall clock. A suite running under `TestClock` (which starts at 0) passes `0`. */
    readonly issuedAt?: number;
  },
): string => {
  const signed = `${options?.issuedAt ?? Math.floor(Date.now() / 1000)}.${randomBytes(32).toString("hex")}`;
  const key = Redacted.isRedacted(secret) ? Redacted.value(secret) : secret;
  return `${signed}.${createHmac("sha256", key).update(signed).digest("hex")}`;
};

/**
 * The `Set-Cookie` of a freshly minted `__Host-csrf` (see `csrfToken`), for seeding an agent over a hand-wired
 * handler the way `TestAuth.app` seeds its own: `agent.cookies.receive(TestAuth.csrfSetCookie(secret))`.
 * `sameSite`/`partitioned` follow `SessionCookie.csrfCookieOptions` (default `Strict`).
 */
export const csrfSetCookie = (
  secret: Redacted.Redacted<string> | string,
  options?: {
    readonly issuedAt?: number;
    readonly sameSite?: "strict" | "none";
    readonly partitioned?: true;
  },
): string =>
  Effect.runSync(
    serialize(
      Api.CSRF_COOKIE_NAME,
      csrfToken(
        secret,
        options?.issuedAt === undefined ? undefined : { issuedAt: options.issuedAt },
      ),
      {
        path: "/",
        secure: true,
        httpOnly: false,
        sameSite: options?.sameSite ?? "strict",
        ...(options?.partitioned === undefined ? {} : { partitioned: options.partitioned }),
      },
    ),
  );
