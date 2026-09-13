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
import { AuthEvents, Sessions, Users, Verification, Accounts } from "@effect-auth/core";
import { Mailer, PasswordHasher } from "@effect-auth/ports";
import { Authentication, AuthHttp } from "@effect-auth/server";
import { NodeCrypto } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { Password, PasswordApi } from "../src/index.ts";

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
).pipe(Layer.provideMerge(AuthEvents.layer), Layer.provideMerge(NodeCrypto.layer));

/**
 * `changePassword` (shipping-gap map, ticket 11) is the one endpoint in
 * this plugin's contract carrying `Authentication` middleware.
 */
const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const buildAppLayer = (mailerLayer: Layer.Layer<Mailer.Mailer>) =>
  Layer.mergeAll(
    AuthHttp.routes(PasswordApi.PasswordApi, { openapiPath: "/openapi.json" }).pipe(
      Layer.provide(Password.Password.layer),
    ),
    AuthHttp.docs(PasswordApi.PasswordApi),
  ).pipe(
    Layer.provideMerge(AuthenticationLive),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(
      Layer.mergeAll(PasswordHasher.layerArgon2id, mailerLayer).pipe(
        Layer.provideMerge(NodeCrypto.layer),
      ),
    ),
    Layer.provide(NoBreachHttpClient),
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
): Promise<Response> =>
  handler(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const cookieFrom = (response: Response): string => {
  const raw = response.headers.get("set-cookie");
  if (raw === null) throw new Error("expected a set-cookie header");
  return raw.split(";")[0] ?? raw;
};

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
        const { handler } = HttpRouter.toWebHandler(AppLayer);

        const signedUp = yield* Effect.promise(() =>
          post(handler, "/password/sign-up", { email: "bo@example.com", password: strongPassword }),
        );
        assert.strictEqual(signedUp.status, 200);

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

        const requestUnknown = yield* Effect.promise(() =>
          post(handler, "/password/request-reset", { email: "not-a-real-user@example.com" }),
        );
        assert.strictEqual(requestUnknown.status, 202);

        const requestReal = yield* Effect.promise(() =>
          post(handler, "/password/request-reset", { email: "reset@example.com" }),
        );
        assert.strictEqual(requestReal.status, 202);

        const messages = yield* mailer.sent;
        const resetMail = messages.findLast((m) => m.template === "reset-password");
        if (resetMail === undefined) throw new Error("expected a reset-password mail");
        const token = (resetMail.data as { token: string }).token;

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
        const messages = yield* mailer.sent;
        const resetMail = messages.findLast((m) => m.template === "reset-password");
        if (resetMail === undefined) throw new Error("expected a reset-password mail");
        const token = (resetMail.data as { token: string }).token;

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
        const token = (verifyMail.data as { token: string }).token;

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
      const { handler } = HttpRouter.toWebHandler(AppLayer);
      const signUp = yield* Effect.promise(() =>
        post(handler, "/password/sign-up", {
          email: "change@example.com",
          password: strongPassword,
        }),
      );
      assert.strictEqual(signUp.status, 200);
      const cookie = cookieFrom(signUp);

      const authed = (path: string, body: unknown) =>
        handler(
          new Request(`http://localhost${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
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
      assert.strictEqual(changed.status, 204);

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
});
