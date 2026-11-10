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
import { Api, SessionContract } from "@awthaq/api";
import { Auth, Errors, Sessions } from "@awthaq/core";
import { CookieAssertions, TestAuth, TestMailbox, type UserAgent } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Password from "../src/Password.ts";
import * as PasswordApi from "../src/PasswordApi.ts";
import { NoBreachHttpClient } from "./harness.ts";

const built = Auth.make([Password.Password]);

const buildAppLayer = (
  passwordConfig: Partial<Password.PasswordConfigShape> = {},
  coreOverride?: Layer.Layer<Sessions.Sessions, never, Sessions.Sessions>,
) =>
  TestAuth.layer(built, {
    // BEH-EA-119: nothing in the corpus ever matches: this file never exercises the breach check itself.
    services: Layer.mergeAll(NoBreachHttpClient, Password.config(passwordConfig)),
    ...(coreOverride === undefined ? {} : { decorate: coreOverride }),
    openapiPath: "/openapi.json",
    docsPath: "/docs",
  });

const AppLayer = buildAppLayer();

const strongPassword = "correct horse battery staple";

/**
 * Waits for the nth mail matching `match` in the app's own `TestMailbox`: the mail is dispatched from a detached
 * fiber (BEH-EA-113: never awaited), so the request answering is no evidence it has been sent yet.
 */
const mailed = (
  app: MailApp,
  match: { readonly to?: string; readonly template: string },
  nth = 1,
) =>
  Effect.promise(() =>
    app.run(Effect.flatMap(TestMailbox.Mailbox, (box) => box.mail.waitFor(match, { nth }))),
  );

/**
 * `PasswordGroup` carries `.middleware(Api.CsrfProtection)`: every request comes from an agent of the app, which
 * holds a `__Host-csrf` minted against the harness's own `CsrfConfig` and echoes it on unsafe methods, as a
 * browser's script would. `from` is the app (a fresh anonymous agent per call) or a browser that keeps the
 * cookies it is answered with.
 */
type MailApp = {
  readonly run: <X>(effect: Effect.Effect<X, never, TestMailbox.Mailbox>) => Promise<X>;
};

type Requester = {
  readonly request: (
    method: string,
    path: string,
    init?: UserAgent.RequestInit,
  ) => Promise<Response>;
};

const post = (
  from: Requester,
  path: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<Response> =>
  from.request("POST", path, { json: body, ...(headers === undefined ? {} : { headers }) });

/**
 * Upstream-hardening ticket 04: `signIn` now hard-blocks an unverified
 * account — every test below that needs a real, working sign-in after
 * sign-up must consume signUp's own dispatched verification mail first,
 * the same wiring `shipping-gaps/08`'s own test already proves works.
 */
const verifyLatestSignUp = (app: Requester & MailApp) =>
  Effect.gen(function* () {
    const verifyMail = yield* mailed(app, { template: "verify-email" });
    const token = TestMailbox.secret(verifyMail);
    const verified = yield* Effect.promise(() => post(app, "/verify-email", { token }));
    assert.strictEqual(verified.status, 204);
  });

describe("AuthHttp + Password (real HTTP)", () => {
  it.effect("BEH-EA-113/083: sign-up sets a session cookie and answers 200", () =>
    Effect.gen(function* () {
      const app = yield* TestAuth.serve(AppLayer);
      const response = yield* Effect.promise(() =>
        post(app, "/password/sign-up", { email: "ada@example.com", password: strongPassword }),
      );
      assert.strictEqual(response.status, 200);
      const body = Schema.decodeUnknownSync(SessionContract.SessionDto)(
        yield* Effect.promise(() => response.json()),
      );
      assert.isTrue(body.current);
      assert.strictEqual(
        CookieAssertions.findSetCookie(response, Api.SESSION_COOKIE_NAME).name,
        Api.SESSION_COOKIE_NAME,
      );
    }),
  );

  // ADR-EA-047 (plan 26 ticket 13): the wiring probe. The plugin reads no address and no header; the request context
  // the group declares is what the session records and what the per-source rules key on.
  it.effect(
    "ADR-EA-047: sign-up records the request's address and user agent (capped at 512) from the request context",
    () =>
      Effect.gen(function* () {
        const app = yield* TestAuth.serve(
          TestAuth.layer(built, {
            services: NoBreachHttpClient,
            clientAddress: "198.51.100.4",
          }),
        );
        const recorded = (email: string, userAgent: string) =>
          Effect.gen(function* () {
            const browser = yield* Effect.promise(() => app.agent());
            const response = yield* Effect.promise(() =>
              post(
                browser,
                "/password/sign-up",
                { email, password: strongPassword },
                { "user-agent": userAgent },
              ),
            );
            assert.strictEqual(response.status, 200);
            const token = browser.cookies.get(Api.SESSION_COOKIE_NAME)?.value ?? "";
            return yield* Effect.promise(() =>
              app.run(
                Effect.flatMap(Effect.service(Sessions.Sessions), (sessions) =>
                  sessions.verify(Redacted.make(token)),
                ),
              ),
            );
          });
        const plain = yield* recorded("ua-plain@example.com", "TestBrowser/1.0");
        assert.deepStrictEqual(plain.session.ipAddress, Option.some("198.51.100.4"));
        assert.deepStrictEqual(plain.session.userAgent, Option.some("TestBrowser/1.0"));
        const long = yield* recorded("ua-long@example.com", "x".repeat(2000));
        assert.strictEqual(Option.getOrUndefined(long.session.userAgent)?.length, 512);
      }),
  );

  it.effect(
    "ADR-EA-047: a per-source rule counts per request address (resendVerificationByIp, 20 per window)",
    () =>
      Effect.gen(function* () {
        const appAt = (clientAddress: string) =>
          TestAuth.serve(
            TestAuth.layer(built, {
              services: NoBreachHttpClient,
              rateLimiter: "enforcing",
              clientAddress,
            }),
          );
        const busy = yield* appAt("203.0.113.50");
        const other = yield* appAt("203.0.113.51");
        const resend = (app: typeof busy, i: number) =>
          Effect.promise(() =>
            post(app, "/resend-verification", { email: `resend-${i}@example.com` }),
          ).pipe(Effect.map((response) => response.status));
        for (let i = 0; i < 20; i++) assert.strictEqual(yield* resend(busy, i), 202);
        assert.strictEqual(yield* resend(busy, 20), 429);
        assert.strictEqual(yield* resend(other, 21), 202);
      }),
  );

  it.effect(
    "IC-007/BO-005: the session Set-Cookie carries the default attributes and a 30-day Max-Age",
    () =>
      Effect.gen(function* () {
        const app = yield* TestAuth.serve(AppLayer);
        const response = yield* Effect.promise(() =>
          post(app, "/password/sign-up", {
            email: "cookie-attrs@example.com",
            password: strongPassword,
          }),
        );
        assert.strictEqual(response.status, 200);
        const session = CookieAssertions.findSetCookie(response, Api.SESSION_COOKIE_NAME);
        // Real clock here (a web handler, no TestClock): a hair under 30 days.
        assert.isAtMost(session.maxAge ?? 0, 2_592_000);
        assert.isAtLeast(session.maxAge ?? 0, 2_591_990);
        CookieAssertions.assertHostPrefixedCookie(session, { httpOnly: true, sameSite: "strict" });
        assert.isFalse(session.partitioned);
      }),
  );

  it.effect("BEH-EA-113/422: a too-short password answers WeakPassword", () =>
    Effect.gen(function* () {
      const app = yield* TestAuth.serve(AppLayer);
      const response = yield* Effect.promise(() =>
        post(app, "/password/sign-up", { email: "weak@example.com", password: "short" }),
      );
      assert.strictEqual(response.status, 422);
    }),
  );

  it.effect("BEH-EA-113/409: signing up twice with the same email answers EmailAlreadyExists", () =>
    Effect.gen(function* () {
      const app = yield* TestAuth.serve(AppLayer);
      const signUp = () =>
        post(app, "/password/sign-up", { email: "dupe@example.com", password: strongPassword });
      assert.strictEqual((yield* Effect.promise(signUp)).status, 200);
      assert.strictEqual((yield* Effect.promise(signUp)).status, 409);
    }),
  );

  it.effect(
    "BEH-EA-114/401: sign-in with the wrong password answers uniform InvalidCredentials",
    () =>
      Effect.gen(function* () {
        const app = yield* TestAuth.serve(buildAppLayer());

        const signedUp = yield* Effect.promise(() =>
          post(app, "/password/sign-up", { email: "bo@example.com", password: strongPassword }),
        );
        assert.strictEqual(signedUp.status, 200);
        yield* verifyLatestSignUp(app);

        const wrongPassword = yield* Effect.promise(() =>
          post(app, "/password/sign-in", {
            email: "bo@example.com",
            password: "totally wrong password",
          }),
        );
        assert.strictEqual(wrongPassword.status, 401);

        const unknownEmail = yield* Effect.promise(() =>
          post(app, "/password/sign-in", {
            email: "nobody@example.com",
            password: strongPassword,
          }),
        );
        assert.strictEqual(unknownEmail.status, 401);

        const correct = yield* Effect.promise(() =>
          post(app, "/password/sign-in", { email: "bo@example.com", password: strongPassword }),
        );
        assert.strictEqual(correct.status, 200);
        assert.strictEqual(
          CookieAssertions.findSetCookie(correct, Api.SESSION_COOKIE_NAME).name,
          Api.SESSION_COOKIE_NAME,
        );
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
        const app = yield* TestAuth.serve(buildAppLayer());

        const signUp = yield* Effect.promise(() =>
          post(app, "/password/sign-up", {
            email: "reset@example.com",
            password: strongPassword,
          }),
        );
        assert.strictEqual(signUp.status, 200);
        yield* verifyLatestSignUp(app);

        const requestUnknown = yield* Effect.promise(() =>
          post(app, "/password/request-reset", { email: "not-a-real-user@example.com" }),
        );
        assert.strictEqual(requestUnknown.status, 202);

        const requestReal = yield* Effect.promise(() =>
          post(app, "/password/request-reset", { email: "reset@example.com" }),
        );
        assert.strictEqual(requestReal.status, 202);

        // TSS-001/EEM-001/MLO-001: request-reset forkDetaches its mail dispatch (mirroring sign-up's own posture).
        const resetMail = yield* mailed(app, { template: "reset-password" });
        const token = TestMailbox.secret(resetMail);

        const confirmed = yield* Effect.promise(() =>
          post(app, "/password/confirm-reset", {
            token,
            password: "a whole new strong password",
          }),
        );
        assert.strictEqual(confirmed.status, 204);

        const oldPassword = yield* Effect.promise(() =>
          post(app, "/password/sign-in", {
            email: "reset@example.com",
            password: strongPassword,
          }),
        );
        assert.strictEqual(oldPassword.status, 401);

        const newPassword = yield* Effect.promise(() =>
          post(app, "/password/sign-in", {
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
        const app = yield* TestAuth.serve(buildAppLayer());

        yield* Effect.promise(() =>
          post(app, "/password/sign-up", {
            email: "replay@example.com",
            password: strongPassword,
          }),
        );
        yield* Effect.promise(() =>
          post(app, "/password/request-reset", { email: "replay@example.com" }),
        );
        const resetMail = yield* mailed(app, { template: "reset-password" });
        const token = TestMailbox.secret(resetMail);

        const first = yield* Effect.promise(() =>
          post(app, "/password/confirm-reset", { token, password: "second strong password" }),
        );
        assert.strictEqual(first.status, 204);

        const replayed = yield* Effect.promise(() =>
          post(app, "/password/confirm-reset", { token, password: "third strong password" }),
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
        const app = yield* TestAuth.serve(buildAppLayer());

        const signUp = yield* Effect.promise(() =>
          post(app, "/password/sign-up", {
            email: "verify@example.com",
            password: strongPassword,
          }),
        );
        assert.strictEqual(signUp.status, 200);

        const verifyMail = yield* mailed(app, { template: "verify-email" });
        const token = TestMailbox.secret(verifyMail);

        const verified = yield* Effect.promise(() => post(app, "/verify-email", { token }));
        assert.strictEqual(verified.status, 204);

        const replayed = yield* Effect.promise(() => post(app, "/verify-email", { token }));
        assert.strictEqual(replayed.status, 410);
      }),
  );

  it.effect("shipping-gaps/08/410: verifying with a garbage token answers TokenConsumed", () =>
    Effect.gen(function* () {
      const app = yield* TestAuth.serve(AppLayer);
      const response = yield* Effect.promise(() =>
        post(app, "/verify-email", { token: "not-a-real-token" }),
      );
      assert.strictEqual(response.status, 410);
    }),
  );

  it.effect("shipping-gaps/11: change-password rotates the hash for the authenticated caller", () =>
    Effect.gen(function* () {
      const app = yield* TestAuth.serve(buildAppLayer());
      // One browser: it keeps the session sign-up answers with, and follows the rotation.
      const browser = yield* Effect.promise(() => app.agent());
      const signUp = yield* Effect.promise(() =>
        post(browser, "/password/sign-up", {
          email: "change@example.com",
          password: strongPassword,
        }),
      );
      assert.strictEqual(signUp.status, 200);
      yield* verifyLatestSignUp(app);
      const before = browser.cookies.get(Api.SESSION_COOKIE_NAME)?.value;
      assert.isString(before);

      const authed = (path: string, body: unknown) => post(browser, path, body);

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
      CookieAssertions.findSetCookie(changed, Api.SESSION_COOKIE_NAME);
      const rotated = browser.cookies.get(Api.SESSION_COOKIE_NAME)?.value;
      assert.isString(rotated);
      assert.notStrictEqual(rotated, before);
      // The rotated session is the one the browser now presents.
      assert.strictEqual(
        (yield* Effect.promise(() => browser.request("GET", "/session"))).status,
        200,
      );

      const oldPassword = yield* Effect.promise(() =>
        post(app, "/password/sign-in", {
          email: "change@example.com",
          password: strongPassword,
        }),
      );
      assert.strictEqual(oldPassword.status, 401);

      const newPassword = yield* Effect.promise(() =>
        post(app, "/password/sign-in", {
          email: "change@example.com",
          password: "a whole new strong password",
        }),
      );
      assert.strictEqual(newPassword.status, 200);
    }),
  );

  it.effect(
    "BAM-009: change-email mails the new address, and confirming the token replaces the address",
    () =>
      Effect.gen(function* () {
        const app = yield* TestAuth.serve(buildAppLayer());
        const browser = yield* Effect.promise(() => app.agent());
        const signUp = yield* Effect.promise(() =>
          post(browser, "/password/sign-up", {
            email: "before@example.com",
            password: strongPassword,
          }),
        );
        assert.strictEqual(signUp.status, 200);
        yield* verifyLatestSignUp(app);

        // Anonymous: refused before anything is mailed.
        const anonymous = yield* Effect.promise(() =>
          post(app, "/change-email", { newEmail: "after@example.com" }),
        );
        assert.strictEqual(anonymous.status, 401);

        const requested = yield* Effect.promise(() =>
          post(browser, "/change-email", { newEmail: "after@example.com" }),
        );
        assert.strictEqual(requested.status, 202);
        const mail = yield* mailed(app, { template: "change-email" });
        assert.strictEqual(mail.to, "after@example.com");

        // The old address still signs in until the change is confirmed.
        const stillOld = yield* Effect.promise(() =>
          post(app, "/password/sign-in", {
            email: "before@example.com",
            password: strongPassword,
          }),
        );
        assert.strictEqual(stillOld.status, 200);

        const token = TestMailbox.secret(mail);
        const confirmed = yield* Effect.promise(() =>
          post(app, "/change-email/confirm", { token }),
        );
        assert.strictEqual(confirmed.status, 204);
        const replay = yield* Effect.promise(() => post(app, "/change-email/confirm", { token }));
        assert.strictEqual(replay.status, 410);

        const oldAddress = yield* Effect.promise(() =>
          post(app, "/password/sign-in", {
            email: "before@example.com",
            password: strongPassword,
          }),
        );
        assert.strictEqual(oldAddress.status, 401);
        const newAddress = yield* Effect.promise(() =>
          post(app, "/password/sign-in", {
            email: "after@example.com",
            password: strongPassword,
          }),
        );
        // Verified by the confirmation itself: no separate verify-email round trip.
        assert.strictEqual(newAddress.status, 200);
      }),
  );

  it.effect("shipping-gaps/11/401: change-password without a session is rejected", () =>
    Effect.gen(function* () {
      const app = yield* TestAuth.serve(AppLayer);
      const response = yield* Effect.promise(() =>
        post(app, "/change-password", {
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
        const app = yield* TestAuth.serve(AppLayer);

        const openapi = yield* Effect.promise(() =>
          app.handler(new Request("http://localhost/openapi.json")),
        );
        assert.strictEqual(openapi.status, 200);
        const spec = Schema.decodeUnknownSync(Schema.Struct({ paths: Schema.Unknown }))(
          yield* Effect.promise(() => openapi.json()),
        );
        assert.isDefined(spec.paths);

        const docs = yield* Effect.promise(() => app.handler(new Request("http://localhost/docs")));
        assert.strictEqual(docs.status, 200);
      }),
  );

  // TMS-005 (ADR-EA-026): `conceal` answers a fresh and an already-registered
  // address identically, and issues no session for either.
  it.effect(
    "TMS-005: with signUpEnumeration conceal, a duplicate and a fresh sign-up look identical",
    () => {
      return Effect.gen(function* () {
        const app = yield* TestAuth.serve(buildAppLayer({ signUpEnumeration: "conceal" }));
        const signUp = () =>
          post(app, "/password/sign-up", {
            email: "dupe@example.com",
            password: strongPassword,
          });
        const fresh = yield* Effect.promise(signUp);
        const duplicate = yield* Effect.promise(signUp);
        assert.strictEqual(fresh.status, 202);
        assert.strictEqual(duplicate.status, 202);
        assert.strictEqual(yield* Effect.promise(() => fresh.text()), "");
        assert.strictEqual(yield* Effect.promise(() => duplicate.text()), "");
        assert.isNull(fresh.headers.get("set-cookie"));
        assert.isNull(duplicate.headers.get("set-cookie"));

        yield* mailed(app, {
          to: "dupe@example.com",
          template: "account-exists",
        });
        const templates = yield* Effect.promise(() =>
          app.run(
            Effect.gen(function* () {
              const box = yield* TestMailbox.Mailbox;
              yield* box.mail.refute({ to: "dupe@example.com" }, { beyond: 2 });
              return (yield* box.mail.messages).map((m) => m.template);
            }),
          ),
        );
        assert.deepStrictEqual(templates, ["verify-email", "account-exists"]);
      });
    },
  );

  it.effect("TMS-005: conceal still reports a weak password, and reveal stays the default", () =>
    Effect.gen(function* () {
      const app = yield* TestAuth.serve(buildAppLayer({ signUpEnumeration: "conceal" }));
      const weak = yield* Effect.promise(() =>
        post(app, "/password/sign-up", { email: "weak@example.com", password: "short" }),
      );
      assert.strictEqual(weak.status, 422);
    }),
  );

  // ESS-006: malformed input is rejected at decode, before any rate-limit,
  // hasher or database work.
  it.effect("ESS-006: a malformed email answers 400 and creates no user", () =>
    Effect.gen(function* () {
      const app = yield* TestAuth.serve(AppLayer);
      for (const path of [
        "/password/sign-up",
        "/password/sign-in",
        "/password/request-reset",
        "/resend-verification",
      ]) {
        const response = yield* Effect.promise(() =>
          post(app, path, { email: "junk", password: strongPassword }),
        );
        assert.strictEqual(response.status, 400, path);
      }
    }),
  );

  it.effect("ESS-006: an oversized password answers 400 before reaching the hasher", () =>
    Effect.gen(function* () {
      const app = yield* TestAuth.serve(AppLayer);
      const response = yield* Effect.promise(() =>
        post(app, "/password/sign-in", {
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
      "changeEmail",
      "changePassword",
      "reauthenticate",
    ]);
    for (const endpoint of account)
      assert.isTrue(requiresAuthentication(endpoint), endpoint.identifier);
    for (const endpoint of Object.values(groups["password"].endpoints)) {
      assert.isFalse(requiresAuthentication(endpoint), endpoint.identifier);
    }
  });

  // CSD-003: the handler threads the request's User-Agent onto the session.
  it.effect("CSD-003: sign-up with a User-Agent yields a session that reports it", () =>
    Effect.gen(function* () {
      const app = yield* TestAuth.serve(AppLayer);
      const response = yield* Effect.promise(() =>
        post(
          app,
          "/password/sign-up",
          { email: "device@example.com", password: strongPassword },
          { "user-agent": "AwthaqTest/1.0" },
        ),
      );
      assert.strictEqual(response.status, 200);
      const body = Schema.decodeUnknownSync(SessionContract.SessionDto)(
        yield* Effect.promise(() => response.json()),
      );
      assert.strictEqual(body.userAgent, "AwthaqTest/1.0");
    }),
  );
  // MNA-001 (decision ticket 17): opt-in bearer delivery on every
  // session-minting response — token in the body, no Set-Cookie, mutually
  // exclusive per request; absent header leaves the browser path unchanged.
  it.effect(
    "MNA-001: sign-up with X-Awthaq-Token-Delivery: bearer returns body.token and no Set-Cookie; the token authenticates a bearer request",
    () =>
      Effect.gen(function* () {
        const app = yield* TestAuth.serve(AppLayer);
        const signedUp = yield* Effect.promise(() =>
          post(
            app,
            "/password/sign-up",
            { email: "native@example.com", password: strongPassword },
            { [Api.TOKEN_DELIVERY_HEADER]: "bearer" },
          ),
        );
        assert.strictEqual(signedUp.status, 200);
        assert.isNull(signedUp.headers.get("set-cookie"));
        assert.match(signedUp.headers.get("cache-control") ?? "", /no-store/);
        const body = Schema.decodeUnknownSync(SessionContract.SessionDto)(
          yield* Effect.promise(() => signedUp.json()),
        );
        assert.isString(body.token);

        // The bearer token is a real credential: it authenticates change-password.
        const changed = yield* Effect.promise(() =>
          app.handler(
            new Request("http://localhost/change-password", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${body.token}`,
                [Api.TOKEN_DELIVERY_HEADER]: "bearer",
              },
              body: JSON.stringify({
                currentPassword: strongPassword,
                newPassword: "a whole new strong password",
              }),
            }),
          ),
        );
        assert.strictEqual(changed.status, 200);
        assert.isNull(changed.headers.get("set-cookie"));
        const rotated = Schema.decodeUnknownSync(SessionContract.SessionDto)(
          yield* Effect.promise(() => changed.json()),
        );
        assert.isString(rotated.token);
        assert.notStrictEqual(rotated.token, body.token);
      }),
  );

  // Plan 21 (ADR-EA-045): a bearer client follows `set-auth-token`; `changePassword` superseded the presented
  // token, so presenting it again is refresh-token reuse (RRS-003) and revokes the whole family.
  it.effect(
    "a bearer changePassword names the new token in set-auth-token, so a client following the header stays signed in",
    () =>
      Effect.gen(function* () {
        const app = yield* TestAuth.serve(AppLayer);
        const signedUp = yield* Effect.promise(() =>
          post(
            app,
            "/password/sign-up",
            { email: "rotating@example.com", password: strongPassword },
            { [Api.TOKEN_DELIVERY_HEADER]: "bearer" },
          ),
        );
        const { token } = Schema.decodeUnknownSync(SessionContract.SessionDto)(
          yield* Effect.promise(() => signedUp.json()),
        );
        const bearer = (path: string, current: string | undefined, init: RequestInit = {}) =>
          Effect.promise(() =>
            app.handler(
              new Request(`http://localhost${path}`, {
                ...init,
                headers: {
                  "content-type": "application/json",
                  authorization: `Bearer ${current}`,
                  [Api.TOKEN_DELIVERY_HEADER]: "bearer",
                },
              }),
            ),
          );
        const changed = yield* bearer("/change-password", token, {
          method: "POST",
          body: JSON.stringify({
            currentPassword: strongPassword,
            newPassword: "a whole new strong password",
          }),
        });
        assert.strictEqual(changed.status, 200);
        // What `bearerTransformClient` stores: the header when present, else what it already held.
        const followed = changed.headers.get(Api.ROTATED_TOKEN_HEADER) ?? token;
        assert.strictEqual((yield* bearer("/session", followed)).status, 200);
        assert.strictEqual((yield* bearer("/session", followed)).status, 200);
      }),
  );

  it.effect("MNA-001: sign-in without the header sets the cookie and carries no body token", () =>
    Effect.gen(function* () {
      const app = yield* TestAuth.serve(buildAppLayer());
      yield* Effect.promise(() =>
        post(app, "/password/sign-up", {
          email: "cookie@example.com",
          password: strongPassword,
        }),
      );
      yield* verifyLatestSignUp(app);
      const response = yield* Effect.promise(() =>
        post(app, "/password/sign-in", {
          email: "cookie@example.com",
          password: strongPassword,
        }),
      );
      assert.strictEqual(response.status, 200);
      assert.strictEqual(
        CookieAssertions.findSetCookie(response, Api.SESSION_COOKIE_NAME).name,
        Api.SESSION_COOKIE_NAME,
      );
      const body = Schema.decodeUnknownSync(SessionContract.SessionDto)(
        yield* Effect.promise(() => response.json()),
      );
      assert.isUndefined(body.token);
    }),
  );

  it.effect("MNA-001: sign-in with bearer delivery returns the token and no cookie", () =>
    Effect.gen(function* () {
      const app = yield* TestAuth.serve(buildAppLayer());
      yield* Effect.promise(() =>
        post(app, "/password/sign-up", {
          email: "device@example.com",
          password: strongPassword,
        }),
      );
      yield* verifyLatestSignUp(app);
      const response = yield* Effect.promise(() =>
        post(
          app,
          "/password/sign-in",
          { email: "device@example.com", password: strongPassword },
          { [Api.TOKEN_DELIVERY_HEADER]: "bearer" },
        ),
      );
      assert.strictEqual(response.status, 200);
      assert.isNull(response.headers.get("set-cookie"));
      const body = Schema.decodeUnknownSync(SessionContract.SessionDto)(
        yield* Effect.promise(() => response.json()),
      );
      assert.isString(body.token);
    }),
  );

  // BEH-EA-077 (cookie-less exemption): a native client's very first sign-in has no cookie jar and no
  // Authorization header. Unlike every other request in this file it sends no `Cookie` header at all,
  // so the double-submit pair is not demanded; a browser holding any cookie still is asked for it.
  it.effect("native first sign-up and sign-in with no cookies and no CSRF pair succeed", () =>
    Effect.gen(function* () {
      const app = yield* TestAuth.serve(buildAppLayer());
      const cookieless = (path: string, body: unknown, extra: Record<string, string> = {}) =>
        Effect.promise(() =>
          app.handler(
            new Request(`http://localhost${path}`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                [Api.TOKEN_DELIVERY_HEADER]: "bearer",
                ...extra,
              },
              body: JSON.stringify(body),
            }),
          ),
        );
      const credentials = { email: "native@example.com", password: strongPassword };
      const signedUp = yield* cookieless("/password/sign-up", credentials);
      assert.strictEqual(signedUp.status, 200);
      yield* verifyLatestSignUp(app);
      const signedIn = yield* cookieless("/password/sign-in", credentials);
      assert.strictEqual(signedIn.status, 200);
      const body = Schema.decodeUnknownSync(SessionContract.SessionDto)(
        yield* Effect.promise(() => signedIn.json()),
      );
      assert.isString(body.token);
      // Login CSRF from a browser page on another site is still refused: the site check runs.
      const crossSite = yield* cookieless("/password/sign-in", credentials, {
        "sec-fetch-site": "cross-site",
      });
      assert.strictEqual(crossSite.status, 403);
      // A browser that holds any cookie is asked for the pair (stale session cookie, no token).
      const stale = yield* cookieless("/password/sign-in", credentials, {
        cookie: "__Host-session=stale.secret",
      });
      assert.strictEqual(stale.status, 403);
    }),
  );

  it.effect("MNA-001: an unknown delivery mode answers 400 and mints no session", () =>
    Effect.gen(function* () {
      const app = yield* TestAuth.serve(AppLayer);
      const response = yield* Effect.promise(() =>
        post(
          app,
          "/password/sign-up",
          { email: "typo@example.com", password: strongPassword },
          { [Api.TOKEN_DELIVERY_HEADER]: "beaerr" },
        ),
      );
      assert.strictEqual(response.status, 400);
      assert.isNull(response.headers.get("set-cookie"));
      // Rejected before the account exists: the same address signs up cleanly afterwards.
      const retry = yield* Effect.promise(() =>
        post(app, "/password/sign-up", { email: "typo@example.com", password: strongPassword }),
      );
      assert.strictEqual(retry.status, 200);
    }),
  );

  it.effect("ADR-EA-028: a session-store outage during sign-in answers 503 StoreUnavailable", () =>
    Effect.gen(function* () {
      const down = { value: false };
      const sessionsDown = Layer.effect(
        Sessions.Sessions,
        Effect.gen(function* () {
          const real = yield* Sessions.Sessions;
          return Sessions.Sessions.of({
            ...real,
            issue: (input) =>
              down.value
                ? Effect.fail(new Errors.StoreUnavailable({ operation: "Sessions.issue" }))
                : real.issue(input),
          });
        }),
      );
      const app = yield* TestAuth.serve(buildAppLayer({}, sessionsDown));
      const signedUp = yield* Effect.promise(() =>
        post(app, "/password/sign-up", { email: "cy@example.com", password: strongPassword }),
      );
      assert.strictEqual(signedUp.status, 200);
      yield* verifyLatestSignUp(app);

      down.value = true;
      const response = yield* Effect.promise(() =>
        post(app, "/password/sign-in", { email: "cy@example.com", password: strongPassword }),
      );
      assert.strictEqual(response.status, 503);
      // The wire error carries only its static `operation` label, never a cause.
      assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
        _tag: "StoreUnavailable",
        operation: "Sessions.issue",
      });
    }),
  );
});
