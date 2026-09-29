// spec/behaviors/15-password.md, BEH-EA-113 through BEH-EA-120.
// spec/behaviors/11-http-error-mapping.md, BEH-EA-083 through BEH-EA-088.
//
// The wire-level counterpart `Password.test.ts`'s own header comment
// pointed at: `AuthHttp.routes`/`AuthHttp.docs` registering this plugin's
// own `PasswordApi` with a real `HttpRouter`, requests built from actual
// `Request` objects, cookies actually set on the response
// (`HttpApiBuilder.securitySetCookie`), and `httpApiStatus` annotations
// (422/409/401/410) landing on the real response status. Domain-level
// rules (uniform-latency sign-in, breach-check fail-open/closed, replay
// protection, …) are already covered in `Password.test.ts`; this file only
// proves the HTTP plumbing itself is wired correctly end to end.
//
// Requests go through `HttpRouter.toWebHandler` (BEH-EA-085/087's real
// serving path), not `router.asHttpEffect()` directly — the pre-response
// hook `HttpApiBuilder.securitySetCookie` registers to attach `Set-Cookie`
// only actually runs as part of the full handled-request lifecycle
// (`HttpEffect.toHandled`'s `sendResponse`), which `toWebHandler` goes
// through and a bare `router.asHttpEffect()` call does not.
import { Api } from "@awthaq/api";
import {
  AuditLog,
  Hooks,
  AuthEvents,
  RateLimits,
  Sessions,
  Users,
  Verification,
  Accounts,
} from "@awthaq/core";
import { ClientAddress, Mailer, PasswordHasher, RateLimiter, SqlTransaction } from "@awthaq/ports";
import { Authentication, AuthHttp, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import { createHmac, randomBytes } from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as Password from "../src/Password.ts";
import * as PasswordApi from "../src/PasswordApi.ts";
import { tokenOf } from "./harness.ts";

/** BEH-EA-119: nothing in the corpus ever matches — this file never exercises the breach check itself. */
const NoBreachHttpClient: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
  ),
);

const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

const CoreLive = Layer.mergeAll(
  Users.layerMemory,
  Accounts.layerMemory,
  Sessions.layerMemory,
  Verification.layerMemory,
).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(NodeCrypto.layer),
);

/**
 * `changePassword` (shipping-gap map, ticket 11) is the one endpoint in
 * this plugin's contract carrying `Authentication` middleware.
 */
const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

/**
 * CSS-001/CDS-001/APS-001/NHS-001/PIL-001/TMS-001: `PasswordGroup` now
 * carries `.middleware(Api.CsrfProtection)` at the group level — this file
 * calls the composed app's real HTTP handler directly, never through
 * `@awthaq/client`'s generated `CsrfClientLive`, so every unsafe-method
 * request built below has to play the double-submit role a real browser
 * client would (see `withCsrfCookie`/`CSRF_TEST_COOKIE_VALUE` below).
 * A reference HMAC computed independently of `Csrf.ts`'s own implementation
 * (Node's `node:crypto`), mirroring `packages/server/test/Csrf.test.ts`'s
 * own `validCookieValue()`.
 */
const CSRF_TEST_SECRET = "password-authhttp-test-csrf-secret";
const CSRF_TEST_COOKIE_VALUE: string = (() => {
  // CDS-006: `<iat>.<random>.<hmac(iat.random)>`. The handler under test runs on the real clock here (a web handler).
  const signed = `${Math.floor(Date.now() / 1000)}.${randomBytes(32).toString("hex")}`;
  const signature = createHmac("sha256", CSRF_TEST_SECRET).update(signed).digest("hex");
  return `${signed}.${signature}`;
})();

const withCsrfCookie = (cookie?: string): string =>
  cookie
    ? `${cookie}; ${Api.CSRF_COOKIE_NAME}=${CSRF_TEST_COOKIE_VALUE}`
    : `${Api.CSRF_COOKIE_NAME}=${CSRF_TEST_COOKIE_VALUE}`;

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make(CSRF_TEST_SECRET),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

const buildAppLayer = (
  mailerLayer: Layer.Layer<Mailer.Mailer>,
  passwordConfig: Partial<Password.PasswordConfigShape> = {},
) =>
  Layer.mergeAll(
    AuthHttp.routes(PasswordApi.PasswordApi, { openapiPath: "/openapi.json" }).pipe(
      Layer.provide(Password.Password.layer.pipe(Layer.provide(Password.config(passwordConfig)))),
    ),
    AuthHttp.docs(PasswordApi.PasswordApi),
  ).pipe(
    Layer.provideMerge(AuthenticationLive),
    Layer.provide(CsrfProtectionLive),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(
      Layer.mergeAll(PasswordHasher.layerArgon2id, mailerLayer, RateLimiter.layerPermissive).pipe(
        Layer.provideMerge(NodeCrypto.layer),
      ),
    ),
    Layer.provideMerge(RateLimits.layer),
    Layer.provide(NoBreachHttpClient),
    // ARF-001: `confirmReset` now runs inside a `SqlTransaction` — a
    // no-op wrapper for this in-memory composition.
    Layer.provide(SqlTransaction.layerNoop),
    // AGA-001/NHS-003: `signUp`/`signIn`/`requestReset` now resolve
    // through `ClientAddress` — the direct passthrough is byte-for-byte
    // today's `remoteAddress` behavior.
    Layer.provide(ClientAddress.layerDirect),
    Layer.provideMerge(TestServices),
    Layer.provideMerge(HttpRouter.layer),
  );

const AppLayer = buildAppLayer(Mailer.layerMemory);

/**
 * A `Mailer` whose recorded messages are readable from outside the layer
 * itself (`AppLayer`'s own `Mailer.layerMemory` keeps its `Ref` sealed
 * inside the layer's construction — nothing outside the built runtime can
 * reach it) — the same pattern `AuthEvents.test.ts` uses for its `seen`
 * `Ref`: create it here, hand only a `Layer.succeed` wrapping it to the
 * app, and read it back directly.
 */
const capturingMailer = (): {
  readonly layer: Layer.Layer<Mailer.Mailer>;
  readonly sent: Effect.Effect<ReadonlyArray<Mailer.MailMessage>>;
} => {
  const messages = Effect.runSync(Ref.make<ReadonlyArray<Mailer.MailMessage>>([]));
  return {
    layer: Layer.succeed(
      Mailer.Mailer,
      Mailer.Mailer.of({
        send: (message) => Ref.update(messages, (existing) => [...existing, message]),
        sent: Ref.get(messages),
      }),
    ),
    sent: Ref.get(messages),
  };
};

const strongPassword = "correct horse battery staple";

/**
 * `signUp`'s verification mail is dispatched via `Effect.forkDetach`
 * (BEH-EA-113: never awaited) — a few cooperative scheduler turns give
 * that detached fiber a chance to run its two effectful steps to
 * completion, mirroring `Password.test.ts`'s own `letForkedFibersRun`.
 */
const letForkedFibersRun = Effect.gen(function* () {
  for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
});

const post = (
  handler: (request: Request) => Promise<Response>,
  path: string,
  body: unknown,
  cookie?: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> =>
  handler(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        ...extraHeaders,
        "content-type": "application/json",
        cookie: withCsrfCookie(cookie),
        [Api.CSRF_HEADER_NAME]: CSRF_TEST_COOKIE_VALUE,
      },
      body: JSON.stringify(body),
    }),
  );

const cookieFrom = (response: Response): string => {
  const raw = response.headers.get("set-cookie");
  if (raw === null) throw new Error("expected a set-cookie header");
  return raw.split(";")[0] ?? raw;
};

/**
 * Upstream-hardening ticket 04: `signIn` now hard-blocks an unverified
 * account — every test below that needs a real, working sign-in after
 * sign-up must consume signUp's own dispatched verification mail first,
 * the same wiring `shipping-gaps/08`'s own test already proves works.
 */
const verifyLatestSignUp = (
  handler: (request: Request) => Promise<Response>,
  mailer: { readonly sent: Effect.Effect<ReadonlyArray<Mailer.MailMessage>> },
) =>
  Effect.gen(function* () {
    yield* letForkedFibersRun;
    const messages = yield* mailer.sent;
    const verifyMail = messages.findLast((m) => m.template === "verify-email");
    if (verifyMail === undefined) throw new Error("expected a verify-email mail");
    const token = tokenOf(verifyMail);
    const verified = yield* Effect.promise(() => post(handler, "/verify-email", { token }));
    assert.strictEqual(verified.status, 204);
  });

describe("AuthHttp + Password (real HTTP)", () => {
  it.effect("BEH-EA-113/083: sign-up sets a session cookie and answers 200", () =>
    Effect.gen(function* () {
      const { handler } = HttpRouter.toWebHandler(AppLayer);
      const response = yield* Effect.promise(() =>
        post(handler, "/password/sign-up", { email: "ada@example.com", password: strongPassword }),
      );
      assert.strictEqual(response.status, 200);
      const body = (yield* Effect.promise(() => response.json())) as { current: boolean };
      assert.isTrue(body.current);
      assert.match(cookieFrom(response), /^__Host-session=/);
    }),
  );

  it.effect(
    "CSD-003: sign-up records the request's User-Agent on the session (capped at 512)",
    () =>
      Effect.gen(function* () {
        const { handler } = HttpRouter.toWebHandler(AppLayer);
        const signUp = (email: string, userAgent: string) =>
          Effect.promise(() =>
            handler(
              new Request("http://localhost/password/sign-up", {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "user-agent": userAgent,
                  cookie: withCsrfCookie(),
                  [Api.CSRF_HEADER_NAME]: CSRF_TEST_COOKIE_VALUE,
                },
                body: JSON.stringify({ email, password: strongPassword }),
              }),
            ),
          );
        const plain = yield* signUp("ua-plain@example.com", "TestBrowser/1.0");
        assert.strictEqual(plain.status, 200);
        const plainBody = (yield* Effect.promise(() => plain.json())) as {
          userAgent: string | null;
        };
        assert.strictEqual(plainBody.userAgent, "TestBrowser/1.0");

        const long = yield* signUp("ua-long@example.com", "x".repeat(2000));
        const longBody = (yield* Effect.promise(() => long.json())) as { userAgent: string | null };
        assert.strictEqual(longBody.userAgent?.length, 512);
      }),
  );

  it.effect(
    "IC-007/BO-005: the session Set-Cookie carries the default attributes and a 30-day Max-Age",
    () =>
      Effect.gen(function* () {
        const { handler } = HttpRouter.toWebHandler(AppLayer);
        const response = yield* Effect.promise(() =>
          post(handler, "/password/sign-up", {
            email: "cookie-attrs@example.com",
            password: strongPassword,
          }),
        );
        assert.strictEqual(response.status, 200);
        const setCookie = response.headers.get("set-cookie") ?? "";
        assert.match(setCookie, /^__Host-session=/);
        // Real clock here (a web handler, no TestClock): a hair under 30 days.
        const maxAge = Number(/;\s*Max-Age=(\d+)/i.exec(setCookie)?.[1]);
        assert.isAtMost(maxAge, 2_592_000);
        assert.isAtLeast(maxAge, 2_591_990);
        assert.match(setCookie, /;\s*Path=\/(;|$)/i);
        assert.match(setCookie, /;\s*Secure/i);
        assert.match(setCookie, /;\s*HttpOnly/i);
        assert.match(setCookie, /;\s*SameSite=Strict/i);
        assert.notMatch(setCookie, /;\s*Domain=/i);
        assert.notMatch(setCookie, /;\s*Partitioned/i);
      }),
  );

  it.effect("BEH-EA-113/422: a too-short password answers WeakPassword", () =>
    Effect.gen(function* () {
      const { handler } = HttpRouter.toWebHandler(AppLayer);
      const response = yield* Effect.promise(() =>
        post(handler, "/password/sign-up", { email: "weak@example.com", password: "short" }),
      );
      assert.strictEqual(response.status, 422);
    }),
  );

  it.effect("BEH-EA-113/409: signing up twice with the same email answers EmailAlreadyExists", () =>
    Effect.gen(function* () {
      const { handler } = HttpRouter.toWebHandler(AppLayer);
      const signUp = () =>
        post(handler, "/password/sign-up", { email: "dupe@example.com", password: strongPassword });
      assert.strictEqual((yield* Effect.promise(signUp)).status, 200);
      assert.strictEqual((yield* Effect.promise(signUp)).status, 409);
    }),
  );

  it.effect(
    "BEH-EA-114/401: sign-in with the wrong password answers uniform InvalidCredentials",
    () =>
      Effect.gen(function* () {
        const mailer = capturingMailer();
        const { handler } = HttpRouter.toWebHandler(buildAppLayer(mailer.layer));

        const signedUp = yield* Effect.promise(() =>
          post(handler, "/password/sign-up", { email: "bo@example.com", password: strongPassword }),
        );
        assert.strictEqual(signedUp.status, 200);
        yield* verifyLatestSignUp(handler, mailer);

        const wrongPassword = yield* Effect.promise(() =>
          post(handler, "/password/sign-in", {
            email: "bo@example.com",
            password: "totally wrong password",
          }),
        );
        assert.strictEqual(wrongPassword.status, 401);

        const unknownEmail = yield* Effect.promise(() =>
          post(handler, "/password/sign-in", {
            email: "nobody@example.com",
            password: strongPassword,
          }),
        );
        assert.strictEqual(unknownEmail.status, 401);

        const correct = yield* Effect.promise(() =>
          post(handler, "/password/sign-in", { email: "bo@example.com", password: strongPassword }),
        );
        assert.strictEqual(correct.status, 200);
        assert.match(cookieFrom(correct), /^__Host-session=/);
      }),
  );

  it.effect(
    // Revocation-of-other-sessions itself is a domain rule already proven
    // directly against `Sessions`/`Verification` in `Password.test.ts`;
    // this only checks the HTTP plumbing — status codes and that the new
    // password actually takes effect.
    "BEH-EA-064/117: request-reset (202, always), then confirm-reset changes the password",
    () =>
      Effect.gen(function* () {
        const mailer = capturingMailer();
        const { handler } = HttpRouter.toWebHandler(buildAppLayer(mailer.layer));

        const signUp = yield* Effect.promise(() =>
          post(handler, "/password/sign-up", {
            email: "reset@example.com",
            password: strongPassword,
          }),
        );
        assert.strictEqual(signUp.status, 200);
        yield* verifyLatestSignUp(handler, mailer);

        const requestUnknown = yield* Effect.promise(() =>
          post(handler, "/password/request-reset", { email: "not-a-real-user@example.com" }),
        );
        assert.strictEqual(requestUnknown.status, 202);

        const requestReal = yield* Effect.promise(() =>
          post(handler, "/password/request-reset", { email: "reset@example.com" }),
        );
        assert.strictEqual(requestReal.status, 202);

        // TSS-001/EEM-001/MLO-001: request-reset now forkDetaches its
        // mail dispatch (mirroring sign-up's own posture) — give that
        // fiber a chance to run before reading `mailer.sent`.
        yield* letForkedFibersRun;
        const messages = yield* mailer.sent;
        const resetMail = messages.findLast((m) => m.template === "reset-password");
        if (resetMail === undefined) throw new Error("expected a reset-password mail");
        const token = tokenOf(resetMail);

        const confirmed = yield* Effect.promise(() =>
          post(handler, "/password/confirm-reset", {
            token,
            password: "a whole new strong password",
          }),
        );
        assert.strictEqual(confirmed.status, 204);

        const oldPassword = yield* Effect.promise(() =>
          post(handler, "/password/sign-in", {
            email: "reset@example.com",
            password: strongPassword,
          }),
        );
        assert.strictEqual(oldPassword.status, 401);

        const newPassword = yield* Effect.promise(() =>
          post(handler, "/password/sign-in", {
            email: "reset@example.com",
            password: "a whole new strong password",
          }),
        );
        assert.strictEqual(newPassword.status, 200);
      }),
  );

  it.effect(
    "BEH-EA-117/410: confirming an already-consumed reset token answers TokenConsumed",
    () =>
      Effect.gen(function* () {
        const mailer = capturingMailer();
        const { handler } = HttpRouter.toWebHandler(buildAppLayer(mailer.layer));

        yield* Effect.promise(() =>
          post(handler, "/password/sign-up", {
            email: "replay@example.com",
            password: strongPassword,
          }),
        );
        yield* Effect.promise(() =>
          post(handler, "/password/request-reset", { email: "replay@example.com" }),
        );
        yield* letForkedFibersRun;
        const messages = yield* mailer.sent;
        const resetMail = messages.findLast((m) => m.template === "reset-password");
        if (resetMail === undefined) throw new Error("expected a reset-password mail");
        const token = tokenOf(resetMail);

        const first = yield* Effect.promise(() =>
          post(handler, "/password/confirm-reset", { token, password: "second strong password" }),
        );
        assert.strictEqual(first.status, 204);

        const replayed = yield* Effect.promise(() =>
          post(handler, "/password/confirm-reset", { token, password: "third strong password" }),
        );
        assert.strictEqual(replayed.status, 410);
      }),
  );

  it.effect(
    // Shipping-gap map (.scratch/shipping-gaps), ticket 08: verify-email
    // wiring gap. Domain rules (uniform response, defect-not-request-error
    // for a missing user) are proven in `Password.test.ts`; this only
    // checks the HTTP plumbing.
    "shipping-gaps/08: verify-email consumes the sign-up mail's token and flips emailVerified",
    () =>
      Effect.gen(function* () {
        const mailer = capturingMailer();
        const { handler } = HttpRouter.toWebHandler(buildAppLayer(mailer.layer));

        const signUp = yield* Effect.promise(() =>
          post(handler, "/password/sign-up", {
            email: "verify@example.com",
            password: strongPassword,
          }),
        );
        assert.strictEqual(signUp.status, 200);

        yield* letForkedFibersRun;
        const messages = yield* mailer.sent;
        const verifyMail = messages.findLast((m) => m.template === "verify-email");
        if (verifyMail === undefined) throw new Error("expected a verify-email mail");
        const token = tokenOf(verifyMail);

        const verified = yield* Effect.promise(() => post(handler, "/verify-email", { token }));
        assert.strictEqual(verified.status, 204);

        const replayed = yield* Effect.promise(() => post(handler, "/verify-email", { token }));
        assert.strictEqual(replayed.status, 410);
      }),
  );

  it.effect("shipping-gaps/08/410: verifying with a garbage token answers TokenConsumed", () =>
    Effect.gen(function* () {
      const { handler } = HttpRouter.toWebHandler(AppLayer);
      const response = yield* Effect.promise(() =>
        post(handler, "/verify-email", { token: "not-a-real-token" }),
      );
      assert.strictEqual(response.status, 410);
    }),
  );

  it.effect("shipping-gaps/11: change-password rotates the hash for the authenticated caller", () =>
    Effect.gen(function* () {
      const mailer = capturingMailer();
      const { handler } = HttpRouter.toWebHandler(buildAppLayer(mailer.layer));
      const signUp = yield* Effect.promise(() =>
        post(handler, "/password/sign-up", {
          email: "change@example.com",
          password: strongPassword,
        }),
      );
      assert.strictEqual(signUp.status, 200);
      yield* verifyLatestSignUp(handler, mailer);
      const cookie = cookieFrom(signUp);

      const authed = (path: string, body: unknown) =>
        handler(
          new Request(`http://localhost${path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              cookie: withCsrfCookie(cookie),
              [Api.CSRF_HEADER_NAME]: CSRF_TEST_COOKIE_VALUE,
            },
            body: JSON.stringify(body),
          }),
        );

      const wrongCurrent = yield* Effect.promise(() =>
        authed("/change-password", {
          currentPassword: "totally wrong password",
          newPassword: "a whole new strong password",
        }),
      );
      assert.strictEqual(wrongCurrent.status, 401);

      const changed = yield* Effect.promise(() =>
        authed("/change-password", {
          currentPassword: strongPassword,
          newPassword: "a whole new strong password",
        }),
      );
      // PIL-002/RRS-001/SMS-001: BEH-EA-053 — changePassword now rotates
      // the caller's own session, so the response carries a fresh
      // SessionDto and Set-Cookie instead of a bare 204.
      assert.strictEqual(changed.status, 200);
      const rotatedCookie = cookieFrom(changed);
      assert.notStrictEqual(rotatedCookie, cookie);

      const oldPassword = yield* Effect.promise(() =>
        post(handler, "/password/sign-in", {
          email: "change@example.com",
          password: strongPassword,
        }),
      );
      assert.strictEqual(oldPassword.status, 401);

      const newPassword = yield* Effect.promise(() =>
        post(handler, "/password/sign-in", {
          email: "change@example.com",
          password: "a whole new strong password",
        }),
      );
      assert.strictEqual(newPassword.status, 200);
    }),
  );

  it.effect("shipping-gaps/11/401: change-password without a session is rejected", () =>
    Effect.gen(function* () {
      const { handler } = HttpRouter.toWebHandler(AppLayer);
      const response = yield* Effect.promise(() =>
        post(handler, "/change-password", {
          currentPassword: strongPassword,
          newPassword: "a whole new strong password",
        }),
      );
      assert.strictEqual(response.status, 401);
    }),
  );

  it.effect(
    "BEH-EA-084: serves generated OpenAPI JSON and Scalar docs from this plugin's own api",
    () =>
      Effect.gen(function* () {
        const { handler } = HttpRouter.toWebHandler(AppLayer);

        const openapi = yield* Effect.promise(() =>
          handler(new Request("http://localhost/openapi.json")),
        );
        assert.strictEqual(openapi.status, 200);
        const spec = (yield* Effect.promise(() => openapi.json())) as { paths?: unknown };
        assert.isDefined(spec.paths);

        const docs = yield* Effect.promise(() => handler(new Request("http://localhost/docs")));
        assert.strictEqual(docs.status, 200);
      }),
  );

  // TMS-005 (ADR-EA-026): `conceal` answers a fresh and an already-registered
  // address identically, and issues no session for either.
  it.effect("TMS-005: with signUpEnumeration conceal, a duplicate and a fresh sign-up look identical", () => {
    const mailer = capturingMailer();
    return Effect.gen(function* () {
      const { handler } = HttpRouter.toWebHandler(
        buildAppLayer(mailer.layer, { signUpEnumeration: "conceal" }),
      );
      const signUp = () =>
        post(handler, "/password/sign-up", { email: "dupe@example.com", password: strongPassword });
      const fresh = yield* Effect.promise(signUp);
      const duplicate = yield* Effect.promise(signUp);
      assert.strictEqual(fresh.status, 202);
      assert.strictEqual(duplicate.status, 202);
      assert.strictEqual(yield* Effect.promise(() => fresh.text()), "");
      assert.strictEqual(yield* Effect.promise(() => duplicate.text()), "");
      assert.isNull(fresh.headers.get("set-cookie"));
      assert.isNull(duplicate.headers.get("set-cookie"));

      yield* letForkedFibersRun;
      const templates = (yield* mailer.sent).map((m) => m.template);
      assert.deepStrictEqual(templates, ["verify-email", "account-exists"]);
    });
  });

  it.effect("TMS-005: conceal still reports a weak password, and reveal stays the default", () =>
    Effect.gen(function* () {
      const { handler } = HttpRouter.toWebHandler(
        buildAppLayer(Mailer.layerMemory, { signUpEnumeration: "conceal" }),
      );
      const weak = yield* Effect.promise(() =>
        post(handler, "/password/sign-up", { email: "weak@example.com", password: "short" }),
      );
      assert.strictEqual(weak.status, 422);
    }),
  );

  // ESS-006: malformed input is rejected at decode, before any rate-limit,
  // hasher or database work.
  it.effect("ESS-006: a malformed email answers 400 and creates no user", () =>
    Effect.gen(function* () {
      const { handler } = HttpRouter.toWebHandler(AppLayer);
      for (const path of ["/password/sign-up", "/password/sign-in", "/password/request-reset", "/resend-verification"]) {
        const response = yield* Effect.promise(() =>
          post(handler, path, { email: "junk", password: strongPassword }),
        );
        assert.strictEqual(response.status, 400, path);
      }
    }),
  );

  it.effect("ESS-006: an oversized password answers 400 before reaching the hasher", () =>
    Effect.gen(function* () {
      const { handler } = HttpRouter.toWebHandler(AppLayer);
      const response = yield* Effect.promise(() =>
        post(handler, "/password/sign-in", {
          email: "ada@example.com",
          password: "x".repeat(PasswordApi.MAX_PASSWORD_LENGTH + 1),
        }),
      );
      assert.strictEqual(response.status, 400);
    }),
  );

  // EHA-007: the plugin contract follows the dotted-sub-group convention.
  it("EHA-007: every password.account endpoint requires Authentication; no endpoint in the public group does", () => {
    const requiresAuthentication = (endpoint: { readonly middlewares: ReadonlySet<unknown> }) =>
      endpoint.middlewares.has(Api.Authentication);
    const groups = PasswordApi.PasswordApi.groups;
    const account = Object.values(groups["password.account"].endpoints);
    assert.deepStrictEqual(account.map((endpoint) => endpoint.identifier).sort(), [
      "changePassword",
      "reauthenticate",
    ]);
    for (const endpoint of account) assert.isTrue(requiresAuthentication(endpoint), endpoint.identifier);
    for (const endpoint of Object.values(groups["password"].endpoints)) {
      assert.isFalse(requiresAuthentication(endpoint), endpoint.identifier);
    }
  });

  // CSD-003: the handler threads the request's User-Agent onto the session.
  it.effect("CSD-003: sign-up with a User-Agent yields a session that reports it", () =>
    Effect.gen(function* () {
      const { handler } = HttpRouter.toWebHandler(AppLayer);
      const response = yield* Effect.promise(() =>
        post(
          handler,
          "/password/sign-up",
          { email: "device@example.com", password: strongPassword },
          undefined,
          { "user-agent": "AwthaqTest/1.0" },
        ),
      );
      assert.strictEqual(response.status, 200);
      const body = (yield* Effect.promise(() => response.json())) as { userAgent: string | null };
      assert.strictEqual(body.userAgent, "AwthaqTest/1.0");
    }),
  );
});
