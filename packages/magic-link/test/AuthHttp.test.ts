// BAM-007, MLO-005, SOS-001 (BEH-EA-267/269/271/273): the wire contract of both plugins over a real
// `HttpRouter`, and the property that matters most for a link: nothing under `/magic-link` (or
// `/email-otp`) is a GET, so a mail scanner or a browser prefetch cannot consume a link.
import { Api } from "@awthaq/api";
import { Auth } from "@awthaq/core";
import { Mailer } from "@awthaq/ports";
import { Authentication, Csrf } from "@awthaq/server";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import { createHmac, randomBytes } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as EmailOtp from "../src/EmailOtp.ts";
import * as MagicLink from "../src/MagicLink.ts";
import { letForkedFibersRun, secretOf } from "./support/harness.ts";

const built = Auth.make([MagicLink.MagicLink, EmailOtp.EmailOtp]);

const CSRF_SECRET = "magic-link-authhttp-test-csrf-secret-padded-32";
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
    MagicLink.config({ baseUrl: "https://app.example.com" }),
  ),
);

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

const call = (method: string, path: string, body?: unknown) =>
  Effect.promise(() =>
    handler(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          cookie: `${Api.CSRF_COOKIE_NAME}=${CSRF_TOKEN}`,
          [Api.CSRF_HEADER_NAME]: CSRF_TOKEN,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    ),
  );

const Tagged = Schema.Struct({ _tag: Schema.String });
const SessionBody = Schema.Struct({ id: Schema.String, amr: Schema.Array(Schema.String) });

describe("the contracts have no GET route (MLO-005)", () => {
  it("every endpoint of the magicLink and emailOtp groups is a POST", () => {
    const methods = Object.values(built.api.groups)
      .filter((group) => group.identifier === "magicLink" || group.identifier === "emailOtp")
      .flatMap((group) =>
        Object.values(group.endpoints).map(
          (endpoint) => `${group.identifier} ${endpoint.method} ${endpoint.path}`,
        ),
      );
    assert.deepStrictEqual(methods.sort(), [
      "emailOtp POST /email-otp/request",
      "emailOtp POST /email-otp/verify",
      "magicLink POST /magic-link/request",
      "magicLink POST /magic-link/verify",
    ]);
  });
});

describe("MagicLink and EmailOtp over HTTP", () => {
  it.live(
    "a link is requested (202), never consumable by GET, and POST /magic-link/verify signs in once",
    () =>
      Effect.gen(function* () {
        const requested = yield* call("POST", "/magic-link/request", { email: "ada@example.com" });
        assert.strictEqual(requested.status, 202);
        yield* letForkedFibersRun;
        const mail = (yield* Effect.promise(sentMail)).findLast((m) => m.template === "magic-link");
        const token = secretOf(mail, "token");
        // The mailed URL carries the token in the fragment.
        assert.strictEqual(
          String(mail?.data?.["url"]),
          `https://app.example.com/magic-link#token=${encodeURIComponent(token)}`,
        );

        // A prefetch (GET, with the token every way it could be smuggled) consumes nothing.
        for (const url of [
          `/magic-link/verify?token=${encodeURIComponent(token)}`,
          `/magic-link?token=${encodeURIComponent(token)}`,
        ]) {
          const prefetch = yield* call("GET", url);
          assert.isTrue(prefetch.status === 404 || prefetch.status === 405);
        }

        const verified = yield* call("POST", "/magic-link/verify", { token });
        assert.strictEqual(verified.status, 200);
        assert.include(verified.headers.get("set-cookie") ?? "", `${Api.SESSION_COOKIE_NAME}=`);
        const body = Schema.decodeUnknownSync(SessionBody)(
          yield* Effect.promise(() => verified.json()),
        );
        assert.deepStrictEqual(body.amr, ["email"]);

        const replay = yield* call("POST", "/magic-link/verify", { token });
        assert.strictEqual(replay.status, 410);
        assert.strictEqual(
          Schema.decodeUnknownSync(Tagged)(yield* Effect.promise(() => replay.json()))._tag,
          "MagicLinkConsumed",
        );
      }),
  );

  it.live(
    "an emailed code signs in over POST /email-otp/verify, and a wrong one is 401 InvalidEmailOtp",
    () =>
      Effect.gen(function* () {
        const requested = yield* call("POST", "/email-otp/request", { email: "otp@example.com" });
        assert.strictEqual(requested.status, 202);
        yield* letForkedFibersRun;
        const mail = (yield* Effect.promise(sentMail)).findLast((m) => m.template === "email-otp");
        const code = secretOf(mail, "code");

        const wrong = yield* call("POST", "/email-otp/verify", {
          email: "otp@example.com",
          code: code === "000000" ? "111111" : "000000",
        });
        assert.strictEqual(wrong.status, 401);
        assert.strictEqual(
          Schema.decodeUnknownSync(Tagged)(yield* Effect.promise(() => wrong.json()))._tag,
          "InvalidEmailOtp",
        );

        const verified = yield* call("POST", "/email-otp/verify", {
          email: "otp@example.com",
          code,
        });
        assert.strictEqual(verified.status, 200);
        const body = Schema.decodeUnknownSync(SessionBody)(
          yield* Effect.promise(() => verified.json()),
        );
        assert.deepStrictEqual(body.amr, ["otp", "email"]);
      }),
  );

  it.live(
    "a malformed address is rejected at decode (400) before any limit or store is touched",
    () =>
      Effect.gen(function* () {
        const response = yield* call("POST", "/magic-link/request", { email: "not-an-email" });
        assert.strictEqual(response.status, 400);
      }),
  );
});
