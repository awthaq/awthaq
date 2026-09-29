// THS-001, ARF-005 (BEH-EA-259 to BEH-EA-266): the plugin over a real `HttpRouter`, composed the way a
// host composes it — `Auth.make([Password, TwoFactor])` served through `TestAuth.layer` — so the
// wire contract is what is proven: a first factor answers 401 `TwoFactorRequired { challengeId }`
// with no session cookie, `/two-factor/verify` completes it, and the reset endpoint asks for the
// second factor.
import { Api } from "@awthaq/api";
import { Auth } from "@awthaq/core";
import { Mailer } from "@awthaq/ports";
import { Password } from "@awthaq/password";
import { Authentication, Csrf } from "@awthaq/server";
import { TestAuth } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import { createHmac, randomBytes } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as SecondFactor from "../src/SecondFactor.ts";
import * as TwoFactor from "../src/TwoFactor.ts";
import {
  EncryptionLive,
  Gates,
  NoBreachHttpClient,
  Stores,
  codeFor,
  letForkedFibersRun,
  tokenOf,
} from "./support/harness.ts";

const built = Auth.make([Password.Password, TwoFactor.TwoFactor]);

const CSRF_SECRET = "two-factor-authhttp-test-csrf-secret-padded-32";
const CSRF_TOKEN = (() => {
  const signed = `${Math.floor(Date.now() / 1000)}.${randomBytes(32).toString("hex")}`;
  return `${signed}.${createHmac("sha256", CSRF_SECRET).update(signed).digest("hex")}`;
})();

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make(CSRF_SECRET),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

const AppLayer = TestAuth.layer(
  built,
  Layer.mergeAll(
    Authentication.AuthenticationLive.pipe(Layer.provide(Authentication.PrincipalResolverLive)),
    CsrfProtectionLive,
    Gates.pipe(
      Layer.provideMerge(SecondFactor.layer),
      Layer.provideMerge(Stores),
      Layer.provideMerge(EncryptionLive),
    ),
    NoBreachHttpClient,
  ),
);

// One running app, shared by the handler and by the test's own reads of its `Mailer` (via the memo map).
const memoMap = Layer.makeMemoMapUnsafe();
const { handler } = HttpRouter.toWebHandler(AppLayer, { memoMap });

const sentMail = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const context = yield* Layer.buildWithMemoMap(AppLayer, memoMap, scope);
        return yield* Effect.gen(function* () {
          const mailer = yield* Mailer.Mailer;
          return yield* mailer.sent;
        }).pipe(Effect.provide(context));
      }),
    ),
  );

const call = (
  method: "GET" | "POST",
  path: string,
  options?: { readonly body?: unknown; readonly cookie?: string },
) =>
  Effect.promise(() =>
    handler(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          cookie: [options?.cookie, `${Api.CSRF_COOKIE_NAME}=${CSRF_TOKEN}`]
            .filter((part) => part !== undefined)
            .join("; "),
          [Api.CSRF_HEADER_NAME]: CSRF_TOKEN,
        },
        ...(options?.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }),
    ),
  );

const json = (response: Response) => Effect.promise(() => response.json());
const cookieOf = (response: Response): string =>
  (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

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

/** Signs up over HTTP and verifies the mailbox; returns the fresh session cookie. */
const registerOverHttp = (email: string) =>
  Effect.gen(function* () {
    const signUp = yield* call("POST", "/password/sign-up", { body: { email, password } });
    assert.strictEqual(signUp.status, 200);
    yield* letForkedFibersRun;
    const verifyMail = (yield* Effect.promise(sentMail)).findLast(
      (mail) => mail.template === "verify-email",
    );
    assert.strictEqual(
      (yield* call("POST", "/verify-email", { body: { token: tokenOf(verifyMail) } })).status,
      204,
    );
    return cookieOf(signUp);
  });

/** Enrols over HTTP and returns the secret and the recovery codes. */
const enrolOverHttp = (cookie: string) =>
  Effect.gen(function* () {
    const enrollment = Schema.decodeUnknownSync(Enrollment)(
      yield* json(yield* call("POST", "/two-factor/enable", { cookie })),
    );
    const codes = Schema.decodeUnknownSync(Codes)(
      yield* json(
        yield* call("POST", "/two-factor/confirm", {
          cookie,
          body: { code: yield* codeFor(enrollment.secret) },
        }),
      ),
    );
    return { enrollment, codes };
  });

// The handler runs on the real clock (a web handler), so the TOTPs are computed on it too (`it.live`).
describe("TwoFactor over HTTP", () => {
  it.live("enrol, then a password sign-in is diverted and /two-factor/verify completes it", () =>
    Effect.gen(function* () {
      const email = "ada@example.com";
      const cookie = yield* registerOverHttp(email);
      // No session, no enrolment endpoints.
      assert.strictEqual((yield* call("POST", "/two-factor/enable")).status, 401);

      const { enrollment, codes } = yield* enrolOverHttp(cookie);
      assert.match(enrollment.otpauthUri, /^otpauth:\/\/totp\//);
      assert.strictEqual(codes.recoveryCodes.length, 10);
      assert.deepStrictEqual(
        Schema.decodeUnknownSync(Status)(
          yield* json(yield* call("GET", "/two-factor/status", { cookie })),
        ),
        { enabled: true, remainingRecoveryCodes: 10 },
      );

      // The first factor now answers a divert, and mints no cookie.
      const diverted = yield* call("POST", "/password/sign-in", { body: { email, password } });
      assert.strictEqual(diverted.status, 401);
      assert.isNull(diverted.headers.get("set-cookie"));
      const divert = Schema.decodeUnknownSync(Divert)(yield* json(diverted));

      // A wrong code answers a fresh challenge to retry with.
      const wrong = yield* call("POST", "/two-factor/verify", {
        body: { challengeId: divert.challengeId, code: "000000" },
      });
      assert.strictEqual(wrong.status, 401);
      const retry = Schema.decodeUnknownSync(Retry)(yield* json(wrong));
      assert.isDefined(retry.challengeId);

      // The next step's code (inside the drift window, later than the enrolment's) completes it.
      const verified = yield* call("POST", "/two-factor/verify", {
        body: { challengeId: retry.challengeId, code: yield* codeFor(enrollment.secret, 1) },
      });
      assert.strictEqual(verified.status, 200);
      assert.include(verified.headers.get("set-cookie") ?? "", `${Api.SESSION_COOKIE_NAME}=`);
      const session = Schema.decodeUnknownSync(SessionBody)(yield* json(verified));
      assert.deepStrictEqual(session.amr, ["pwd", "otp", "mfa"]);

      // A recovery code completes a sign-in too — once.
      const again = Schema.decodeUnknownSync(Divert)(
        yield* json(yield* call("POST", "/password/sign-in", { body: { email, password } })),
      );
      const recovered = yield* call("POST", "/two-factor/verify-recovery", {
        body: { challengeId: again.challengeId, recoveryCode: codes.recoveryCodes[0] },
      });
      assert.strictEqual(recovered.status, 200);
      const third = Schema.decodeUnknownSync(Divert)(
        yield* json(yield* call("POST", "/password/sign-in", { body: { email, password } })),
      );
      const reused = yield* call("POST", "/two-factor/verify-recovery", {
        body: { challengeId: third.challengeId, recoveryCode: codes.recoveryCodes[0] },
      });
      assert.strictEqual(reused.status, 401);
    }),
  );

  it.live(
    "a password reset of an enrolled account asks for the second factor (SecondFactorRequired, 401)",
    () =>
      Effect.gen(function* () {
        const email = "reset@example.com";
        const cookie = yield* registerOverHttp(email);
        yield* enrolOverHttp(cookie);

        yield* call("POST", "/password/request-reset", { body: { email } });
        yield* letForkedFibersRun;
        const resetMail = (yield* Effect.promise(sentMail)).findLast(
          (mail) => mail.template === "reset-password",
        );
        const refused = yield* call("POST", "/password/confirm-reset", {
          body: { token: tokenOf(resetMail), password: "a brand new strong password" },
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
      for (const [method, path] of [
        ["POST", "/two-factor/enable"],
        ["POST", "/two-factor/confirm"],
        ["POST", "/two-factor/disable"],
        ["POST", "/two-factor/recovery-codes/regenerate"],
        ["GET", "/two-factor/status"],
      ] as const) {
        const options = method === "GET" ? undefined : { body: { code: "000000" } };
        assert.strictEqual((yield* call(method, path, options)).status, 401);
      }
    }),
  );
});
