// Shipping-gap map (.scratch/shipping-gaps), ticket 21: the real wire-level
// seam `packages/server/test/AuthHttp.test.ts` establishes for
// `@awthaq/server`'s own core `session` HTTP group
// (`/session`, `/session/list`, `/session/sign-out`, `/session/revoke`,
// `/session/revoke-others`), plus `@awthaq/password`'s `/password/sign-up`
// composed alongside it on the same `HttpRouter` — Session's own contract has
// no HTTP endpoint that *issues* a session (only ones that consume an
// already-issued cookie), so a real Set-Cookie response (REQ-EA-136/154/155)
// needs an actual sign-in flow, the same way any real deployment would.
import { AuthCore } from "@awthaq/api";
import {
  AuditLog,
  AuthEvents,
  Accounts,
  DataExport,
  Erasure,
  Hooks,
  RateLimits,
  Sessions,
  Users,
  Verification,
} from "@awthaq/core";
import { ClientAddress, Mailer, PasswordHasher, RateLimiter, SqlTransaction } from "@awthaq/ports";
import { Password, PasswordApi } from "@awthaq/password";
import { Account, Authentication, AuthHttp, Csrf, Session } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { CSRF_TEST_COOKIE_VALUE, CsrfConfigForTests, withCsrfCookie } from "./CsrfTestSupport.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Path from "effect/Path";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { mailedToken } from "./MailedToken.ts";

const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

const CoreLive = Layer.mergeAll(Erasure.layer, DataExport.layer).pipe(
  // CSG-001: the account handler runs `AccountErasure` over these same stores (and
  // over the registry `Hooks.HooksLive` provides).
  Layer.provideMerge(
    Layer.mergeAll(
      Users.layerMemory,
      Accounts.layerMemory,
      Sessions.layerMemory,
      Verification.layerMemory,
    ),
  ),
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(NodeCrypto.layer),
);

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(Layer.succeed(Csrf.CsrfConfig, CsrfConfigForTests)),
  Layer.provide(NodeCrypto.layer),
);

const NoBreachHttpClient: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
  ),
);

/**
 * Mirrors `PasswordWorld.ts`'s own `capturingMailer` — a capture cell
 * built *outside* the layer graph so `signUp` below can read it back after
 * the graph is torn down into the handler closure. Upstream-hardening
 * ticket 04: needed so `signUp` can consume its own dispatched
 * verification mail and pass `signIn`'s new `emailVerified` gate — this
 * file's own scope stays session behavior, not verification, so that
 * consumption happens transparently inside `signUp` itself, never exposed
 * to a scenario.
 */
const buildApp = () => {
  const messages = Effect.runSync(Ref.make<ReadonlyArray<Mailer.MailMessage>>([]));
  const capturingMailer = Layer.succeed(
    Mailer.Mailer,
    Mailer.Mailer.of({
      send: (message) => Ref.update(messages, (existing) => [...existing, message]),
      sent: Ref.get(messages),
    }),
  );

  const appLayer = Layer.mergeAll(
    AuthHttp.routes(AuthCore.AuthCoreApi, { openapiPath: "/openapi.json" }).pipe(
      Layer.provide(Session.SessionHandlers),
      Layer.provide(Account.AccountHandlers),
    ),
    AuthHttp.routes(PasswordApi.PasswordApi, { openapiPath: "/password-openapi.json" }).pipe(
      Layer.provide(Password.Password.layer),
    ),
    AuthHttp.docs(AuthCore.AuthCoreApi),
  ).pipe(
    Layer.provideMerge(AuthenticationLive),
    Layer.provide(CsrfProtectionLive),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(
      Layer.mergeAll(
        PasswordHasher.layerArgon2id,
        capturingMailer,
        RateLimiter.layerPermissive,
      ).pipe(Layer.provideMerge(NodeCrypto.layer)),
    ),
    Layer.provideMerge(RateLimits.layer),
    Layer.provide(NoBreachHttpClient),
    // CSG-001/DRS-002: `Account.deleteUser` now runs inside a
    // `SqlTransaction` — a no-op wrapper for this in-memory composition,
    // same as `TestAuth.layer`'s own default and `OAuth.test.ts`'s.
    Layer.provide(SqlTransaction.layerNoop),
    // AGA-001/NHS-003: `Password`'s `signUp`/`signIn`/`requestReset` now
    // resolve through `ClientAddress` too.
    Layer.provide(ClientAddress.layerDirect),
    Layer.provideMerge(TestServices),
    Layer.provideMerge(HttpRouter.layer),
  );
  const { handler } = HttpRouter.toWebHandler(appLayer);
  return { handler, sentMail: Ref.get(messages) };
};

export interface ActorState {
  email: string;
  /** The bare `name=value` pair, ready to send back as a request's own `cookie` header. */
  cookie: string;
  /** The full raw `Set-Cookie` response header this session's own cookie was issued under — carries the attributes (`Secure`, `HttpOnly`, `SameSite`, `Path`, any `Domain`) REQ-EA-154/155 inspect. */
  setCookie: string;
}

export interface WorldShape {
  readonly handler: (request: Request) => Promise<Response>;
  readonly sentMail: Effect.Effect<ReadonlyArray<Mailer.MailMessage>>;
  readonly actors: Ref.Ref<Record<string, ActorState>>;
  readonly responses: Ref.Ref<Record<string, Response>>;
}

export class World extends Context.Service<World, WorldShape>()("features/SessionWorld") {}

export const WorldLive = Layer.effect(
  World,
  Effect.gen(function* () {
    const { handler, sentMail } = buildApp();
    return World.of({
      handler,
      sentMail,
      actors: yield* Ref.make<Record<string, ActorState>>({}),
      responses: yield* Ref.make<Record<string, Response>>({}),
    });
  }),
);

const STRONG_PASSWORD = "correct horse battery staple";
let nextEmail = 0;

const get = (
  handler: (request: Request) => Promise<Response>,
  path: string,
  cookie?: string,
): Promise<Response> =>
  handler(
    new Request(`http://localhost${path}`, {
      method: "GET",
      headers: { cookie: withCsrfCookie(cookie) },
    }),
  );

const post = (
  handler: (request: Request) => Promise<Response>,
  path: string,
  body: unknown,
  cookie?: string,
): Promise<Response> =>
  handler(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: withCsrfCookie(cookie),
        "x-csrf-token": CSRF_TEST_COOKIE_VALUE,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

export const cookieFrom = (response: Response): string => {
  const raw = response.headers.get("set-cookie");
  if (raw === null) throw new Error("expected a set-cookie header");
  return raw.split(";")[0] ?? raw;
};

const setCookieHeader = (response: Response): string => {
  const raw = response.headers.get("set-cookie");
  if (raw === null) throw new Error("expected a set-cookie header");
  return raw;
};

/**
 * `signUp`'s verification mail is dispatched via `Effect.forkDetach`
 * (BEH-EA-113: never awaited) — a few cooperative scheduler turns give
 * that detached fiber a chance to run to completion, mirroring
 * `AuthHttp.test.ts`'s own `letForkedFibersRun`.
 */
const letForkedFibersRun = Effect.gen(function* () {
  for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
});

/** Signs a fresh user up (BEH-EA-113's own detail is out of scope here — Password's `AuthHttp.test.ts` already covers it), returning the resulting `__Host-session` cookie. */
export const signUp = Effect.fn("features.session.signUp")(function* (name: string) {
  const { handler, sentMail } = yield* World;
  const email = `${name}-${nextEmail++}@example.com`;
  const response = yield* Effect.promise(() =>
    post(handler, "/password/sign-up", { email, password: STRONG_PASSWORD }),
  );
  if (response.status !== 200) throw new Error(`sign-up failed for ${email}: ${response.status}`);
  const cookie = cookieFrom(response);
  const setCookie = setCookieHeader(response);
  const { actors } = yield* World;
  yield* Ref.update(actors, (existing) => ({ ...existing, [name]: { email, cookie, setCookie } }));

  // Upstream-hardening map, ticket 04: `signIn` now hard-blocks an
  // unverified account — consume signUp's own dispatched verification
  // mail so every later sign-in this suite drives (`signInAgain`) passes
  // that gate. Transparent to every scenario: this file's own scope is
  // session behavior, not verification.
  yield* letForkedFibersRun;
  const messages = yield* sentMail;
  const verifyMail = messages.findLast(
    (message) => message.template === "verify-email" && message.to === email,
  );
  if (verifyMail === undefined) throw new Error(`expected a verify-email mail for ${email}`);
  const verifyToken = mailedToken(verifyMail);
  const verified = yield* Effect.promise(() =>
    post(handler, "/verify-email", { token: verifyToken }),
  );
  if (verified.status !== 204) {
    throw new Error(`verify-email failed for ${email}: ${verified.status}`);
  }

  return { response, cookie, setCookie };
});

/** Mints a second (third, ...) session for the SAME account an earlier `signUp`/`signInAgain` call already created — BEH-EA-053's "a new session is issued, never reused" at each sign-in, the real way to get more than one live session for one user. Stored under `newName`, a fresh label for this particular session. */
export const signInAgain = Effect.fn("features.session.signInAgain")(function* (
  newName: string,
  existingName: string,
) {
  const { handler } = yield* World;
  const owner = yield* getActor(existingName);
  const response = yield* Effect.promise(() =>
    post(handler, "/password/sign-in", { email: owner.email, password: STRONG_PASSWORD }),
  );
  if (response.status !== 200) {
    throw new Error(`sign-in failed for ${owner.email}: ${response.status}`);
  }
  const cookie = cookieFrom(response);
  const setCookie = setCookieHeader(response);
  const { actors } = yield* World;
  yield* Ref.update(actors, (existing) => ({
    ...existing,
    [newName]: { email: owner.email, cookie, setCookie },
  }));
  return { response, cookie, setCookie };
});

/** The `id` half of an actor's own current session — resolved via the real `/session` "current" endpoint, the same id shape `/session/revoke` expects. */
export const sessionIdOf = Effect.fn("features.session.sessionIdOf")(function* (cookie: string) {
  const { handler } = yield* World;
  const response = yield* Effect.promise(() => get(handler, "/session", cookie));
  const body = (yield* Effect.promise(() => response.json())) as { readonly id: string };
  return body.id;
});

export const getSession = Effect.fn("features.session.getSession")(function* (
  path: string,
  cookie?: string,
) {
  const { handler } = yield* World;
  return yield* Effect.promise(() => get(handler, path, cookie));
});

export const postSession = Effect.fn("features.session.postSession")(function* (
  path: string,
  body: unknown,
  cookie?: string,
) {
  const { handler } = yield* World;
  return yield* Effect.promise(() => post(handler, path, body, cookie));
});

/** Registers `newName` as another name for the same already-set-up actor's session — e.g. "alice" is also her own "current" session "s1" in REQ-EA-151's own Given. */
export const aliasActor = Effect.fn("features.session.aliasActor")(function* (
  newName: string,
  existingName: string,
) {
  const { actors } = yield* World;
  const existing = (yield* Ref.get(actors))[existingName];
  if (existing === undefined) throw new Error(`no actor named "${existingName}" has been set up`);
  yield* Ref.update(actors, (state) => ({ ...state, [newName]: existing }));
});

export const getActor = Effect.fn("features.session.getActor")(function* (name: string) {
  const { actors } = yield* World;
  const found = (yield* Ref.get(actors))[name];
  if (found === undefined) throw new Error(`no actor named "${name}" has been set up`);
  return found;
});

export const setLastResponse = Effect.fn("features.session.setLastResponse")(function* (
  key: string,
  response: Response,
) {
  const { responses } = yield* World;
  yield* Ref.update(responses, (existing) => ({ ...existing, [key]: response }));
});

export const getLastResponse = Effect.fn("features.session.getLastResponse")(function* (
  key: string,
) {
  const { responses } = yield* World;
  const found = (yield* Ref.get(responses))[key];
  if (found === undefined) throw new Error(`no response recorded for "${key}"`);
  return found;
});
