// THS-001, ARF-005 (BEH-EA-259 to BEH-EA-266): the plugin over a real `HttpRouter`, composed the way a
// host composes it — `Auth.make([Password, TwoFactor])` served through `TestAuth.layer` — so the
// wire contract is what is proven: a first factor answers 401 `TwoFactorRequired { challengeId }`
// with no session cookie, `/two-factor/verify` completes it, and the reset endpoint asks for the
// second factor.
import { Api, SessionContract } from "@awthaq/api";
import { Auth, Sessions } from "@awthaq/core";
import { Password } from "@awthaq/password";
import { CookieAssertions, TestAuth, TestMailbox, type UserAgent } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TwoFactor from "../src/TwoFactor.ts";
import { Gates, codeFor } from "./support/harness.ts";

const built = Auth.make([Password.Password, TwoFactor.TwoFactor]);

const AppLayer = TestAuth.layer(built, {
  services: Layer.merge(Gates, TestAuth.httpClient.noBreach),
});

// Each test serves its own app: the handler and the test's own reads of its mailbox share it.
const serveApp = TestAuth.serve(AppLayer);
type Served = Effect.Success<typeof serveApp>;

/** The mail of `template` to `to`, once the handler's detached dispatch has recorded it. */
const mailed = (app: Pick<Served, "run">, to: string, template: string) =>
  Effect.promise(() =>
    app.run(Effect.flatMap(TestMailbox.Mailbox, (box) => box.mail.waitFor({ to, template }))),
  );

/** One request, from `options.as` (a browser holding its cookies) or a fresh anonymous agent. */
const call = (
  testApp: Served,
  method: "GET" | "POST",
  path: string,
  options?: { readonly body?: unknown; readonly as?: UserAgent.UserAgent },
) =>
  Effect.promise(() => {
    const init = options?.body === undefined ? {} : { json: options.body };
    return options?.as === undefined
      ? testApp.request(method, path, init)
      : options.as.request(method, path, init);
  });

const json = (response: Response) => Effect.promise(() => response.json());

const Enrollment = Schema.Struct({ secret: Schema.String, otpauthUri: Schema.String });
const Codes = Schema.Struct({ recoveryCodes: Schema.Array(Schema.String) });
const Status = Schema.Struct({ enabled: Schema.Boolean, remainingRecoveryCodes: Schema.Number });
const Divert = Schema.Struct({
  _tag: Schema.Literal("TwoFactorRequired"),
  challengeId: Schema.String,
});
const Retry = Schema.Struct({
  _tag: Schema.Literal("InvalidTwoFactorCode"),
  challengeId: Schema.optional(Schema.String),
});
const SessionBody = Schema.Struct({ id: Schema.String, amr: Schema.Array(Schema.String) });
const Tagged = Schema.Struct({ _tag: Schema.String });

const password = "correct horse battery staple";

/** Signs up over HTTP and verifies the mailbox; returns the browser now holding the fresh session. */
const registerOverHttp = (testApp: Served, email: string) =>
  Effect.gen(function* () {
    const browser = yield* Effect.promise(() => testApp.agent());
    const signUp = yield* call(testApp, "POST", "/password/sign-up", {
      as: browser,
      body: { email, password },
    });
    assert.strictEqual(signUp.status, 200);
    const verifyMail = yield* mailed(testApp, email, "verify-email");
    assert.strictEqual(
      (yield* call(testApp, "POST", "/verify-email", {
        body: { token: TestMailbox.secret(verifyMail) },
      })).status,
      204,
    );
    return browser;
  });

/** Enrols over HTTP and returns the secret and the recovery codes. */
const enrolOverHttp = (testApp: Served, browser: UserAgent.UserAgent) =>
  Effect.gen(function* () {
    const enrollment = Schema.decodeUnknownSync(Enrollment)(
      yield* json(yield* call(testApp, "POST", "/two-factor/enable", { as: browser })),
    );
    const codes = Schema.decodeUnknownSync(Codes)(
      yield* json(
        yield* call(testApp, "POST", "/two-factor/confirm", {
          as: browser,
          body: { code: yield* codeFor(enrollment.secret) },
        }),
      ),
    );
    return { enrollment, codes };
  });

// The handler runs on the real clock (a web handler), so the TOTPs are computed on it too (`it.live`).
describe("TwoFactor over HTTP", () => {
  // ADR-EA-047 (plan 26 ticket 19): the wiring probe. Two-factor reads no address and no header; the completed
  // session records the request context's facts, and the per-source rule counts per request address.
  it.live(
    "ADR-EA-047: a completed second factor's session records the request's address and user agent; verify counts per address",
    () =>
      Effect.gen(function* () {
        const appAt = (clientAddress: string) =>
          TestAuth.serve(
            TestAuth.layer(built, {
              services: Layer.merge(Gates, TestAuth.httpClient.noBreach),
              rateLimiter: "enforcing",
              clientAddress,
            }),
          );
        const probe = yield* appAt("198.51.100.19");
        const email = "probe-2fa@example.com";
        const browser = yield* Effect.promise(() => probe.agent());
        const post = (path: string, body: unknown, headers?: Record<string, string>) =>
          Effect.promise(() =>
            probe.request("POST", path, {
              json: body,
              ...(headers === undefined ? {} : { headers }),
            }),
          );
        assert.strictEqual(
          (yield* Effect.promise(() =>
            browser.request("POST", "/password/sign-up", { json: { email, password } }),
          )).status,
          200,
        );
        const verifyMail = yield* mailed(probe, email, "verify-email");
        assert.strictEqual(
          (yield* post("/verify-email", { token: TestMailbox.secret(verifyMail) })).status,
          204,
        );
        const enrollment = Schema.decodeUnknownSync(Enrollment)(
          yield* json(yield* Effect.promise(() => browser.request("POST", "/two-factor/enable"))),
        );
        const code = yield* codeFor(enrollment.secret);
        const codes = Schema.decodeUnknownSync(Codes)(
          yield* json(
            yield* Effect.promise(() =>
              browser.request("POST", "/two-factor/confirm", { json: { code } }),
            ),
          ),
        );
        const divert = Schema.decodeUnknownSync(Divert)(
          yield* json(yield* post("/password/sign-in", { email, password })),
        );
        const recovered = yield* post(
          "/two-factor/verify-recovery",
          { challengeId: divert.challengeId, recoveryCode: codes.recoveryCodes[0] },
          { [Api.TOKEN_DELIVERY_HEADER]: "bearer", "user-agent": "TwoFactorProbe/1" },
        );
        assert.strictEqual(recovered.status, 200);
        const token = Schema.decodeUnknownSync(SessionContract.SessionDto)(
          yield* json(recovered),
        ).token;
        const verified = yield* Effect.promise(() =>
          probe.run(
            Effect.flatMap(Effect.service(Sessions.Sessions), (sessions) =>
              sessions.verify(Redacted.make(token ?? "")),
            ),
          ),
        );
        assert.deepStrictEqual(verified.session.ipAddress, Option.some("198.51.100.19"));
        assert.deepStrictEqual(verified.session.userAgent, Option.some("TwoFactorProbe/1"));
        // `verifyByIp` is 30 per window: one verify above, 29 more (refused codes), then refused; another address
        // is not.
        const bogus = (app: typeof probe) =>
          Effect.promise(() =>
            app.request("POST", "/two-factor/verify", {
              json: { challengeId: "not-a-challenge", code: "000000" },
            }),
          ).pipe(Effect.map((response) => response.status));
        for (let i = 0; i < 29; i++) assert.notStrictEqual(yield* bogus(probe), 429);
        assert.strictEqual(yield* bogus(probe), 429);
        const other = yield* appAt("198.51.100.20");
        assert.notStrictEqual(yield* bogus(other), 429);
      }),
  );

  it.live("enrol, then a password sign-in is diverted and /two-factor/verify completes it", () =>
    Effect.gen(function* () {
      const testApp = yield* serveApp;
      const email = "ada@example.com";
      const browser = yield* registerOverHttp(testApp, email);
      // No session, no enrolment endpoints.
      assert.strictEqual((yield* call(testApp, "POST", "/two-factor/enable")).status, 401);

      const { enrollment, codes } = yield* enrolOverHttp(testApp, browser);
      assert.match(enrollment.otpauthUri, /^otpauth:\/\/totp\//);
      assert.strictEqual(codes.recoveryCodes.length, 10);
      assert.deepStrictEqual(
        Schema.decodeUnknownSync(Status)(
          yield* json(yield* call(testApp, "GET", "/two-factor/status", { as: browser })),
        ),
        { enabled: true, remainingRecoveryCodes: 10 },
      );

      // The first factor now answers a divert, and mints no cookie.
      const diverted = yield* call(testApp, "POST", "/password/sign-in", {
        body: { email, password },
      });
      assert.strictEqual(diverted.status, 401);
      assert.isNull(diverted.headers.get("set-cookie"));
      const divert = Schema.decodeUnknownSync(Divert)(yield* json(diverted));

      // A wrong code answers a fresh challenge to retry with.
      const wrong = yield* call(testApp, "POST", "/two-factor/verify", {
        body: { challengeId: divert.challengeId, code: "000000" },
      });
      assert.strictEqual(wrong.status, 401);
      const retry = Schema.decodeUnknownSync(Retry)(yield* json(wrong));
      assert.isDefined(retry.challengeId);

      // The next step's code (inside the drift window, later than the enrolment's) completes it.
      const verified = yield* call(testApp, "POST", "/two-factor/verify", {
        body: { challengeId: retry.challengeId, code: yield* codeFor(enrollment.secret, 1) },
      });
      assert.strictEqual(verified.status, 200);
      assert.strictEqual(
        CookieAssertions.findSetCookie(verified, Api.SESSION_COOKIE_NAME).name,
        Api.SESSION_COOKIE_NAME,
      );
      const session = Schema.decodeUnknownSync(SessionBody)(yield* json(verified));
      assert.deepStrictEqual(session.amr, ["pwd", "otp", "mfa"]);

      // A recovery code completes a sign-in too — once.
      const again = Schema.decodeUnknownSync(Divert)(
        yield* json(
          yield* call(testApp, "POST", "/password/sign-in", { body: { email, password } }),
        ),
      );
      const recovered = yield* call(testApp, "POST", "/two-factor/verify-recovery", {
        body: { challengeId: again.challengeId, recoveryCode: codes.recoveryCodes[0] },
      });
      assert.strictEqual(recovered.status, 200);
      const third = Schema.decodeUnknownSync(Divert)(
        yield* json(
          yield* call(testApp, "POST", "/password/sign-in", { body: { email, password } }),
        ),
      );
      const reused = yield* call(testApp, "POST", "/two-factor/verify-recovery", {
        body: { challengeId: third.challengeId, recoveryCode: codes.recoveryCodes[0] },
      });
      assert.strictEqual(reused.status, 401);
    }),
  );

  it.live(
    "a password reset of an enrolled account asks for the second factor (SecondFactorRequired, 401)",
    () =>
      Effect.gen(function* () {
        const testApp = yield* serveApp;
        const email = "reset@example.com";
        yield* enrolOverHttp(testApp, yield* registerOverHttp(testApp, email));

        yield* call(testApp, "POST", "/password/request-reset", { body: { email } });
        const resetMail = yield* mailed(testApp, email, "reset-password");
        const refused = yield* call(testApp, "POST", "/password/confirm-reset", {
          body: { token: TestMailbox.secret(resetMail), password: "a brand new strong password" },
        });
        assert.strictEqual(refused.status, 401);
        assert.strictEqual(
          Schema.decodeUnknownSync(Tagged)(yield* json(refused))._tag,
          "SecondFactorRequired",
        );
      }),
  );

  it.live("enable, disable and status need a session; only verify is public", () =>
    Effect.gen(function* () {
      const testApp = yield* serveApp;
      for (const [method, path] of [
        ["POST", "/two-factor/enable"],
        ["POST", "/two-factor/confirm"],
        ["POST", "/two-factor/disable"],
        ["POST", "/two-factor/recovery-codes/regenerate"],
        ["GET", "/two-factor/status"],
      ] as const) {
        const options = method === "GET" ? undefined : { body: { code: "000000" } };
        assert.strictEqual((yield* call(testApp, method, path, options)).status, 401);
      }
    }),
  );
});
