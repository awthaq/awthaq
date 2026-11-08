// BAM-007, MLO-005, SOS-001 (BEH-EA-267/269/271/273): the wire contract of both plugins over a real
// `HttpRouter`, and the property that matters most for a link: nothing under `/magic-link` (or
// `/email-otp`) is a GET, so a mail scanner or a browser prefetch cannot consume a link.
import { Api, SessionContract } from "@awthaq/api";
import { Auth, Sessions } from "@awthaq/core";
import { Mailer } from "@awthaq/ports";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as EmailOtp from "../src/EmailOtp.ts";
import * as MagicLink from "../src/MagicLink.ts";
import { awaitMails, secretOf } from "./support/harness.ts";

const built = Auth.make([MagicLink.MagicLink, EmailOtp.EmailOtp]);

const AppLayer = TestAuth.layer(built, {
  services: MagicLink.config({ baseUrl: "https://app.example.com" }),
});

const testApp = TestAuth.app(AppLayer);

const sentMail = () => testApp.run(Effect.flatMap(Mailer.Mailer, (mailer) => mailer.sent));

const call = (method: string, path: string, body?: unknown) =>
  Effect.promise(() => testApp.request(method, path, body === undefined ? {} : { json: body }));

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
  // ADR-EA-047 (plan 26 ticket 17): the wiring probe. Neither plugin reads an address or a header; the session
  // records the request context's facts, and the per-source rule counts per request address.
  it.live(
    "ADR-EA-047: a verified link's session records the request's address and user agent; request counts per address",
    () =>
      Effect.gen(function* () {
        const appAt = (clientAddress: string) =>
          TestAuth.app(
            TestAuth.layer(built, {
              services: MagicLink.config({ baseUrl: "https://app.example.com" }),
              rateLimiter: "enforcing",
              clientAddress,
            }),
          );
        const probe = appAt("198.51.100.17");
        const mails = () => probe.run(Effect.flatMap(Mailer.Mailer, (mailer) => mailer.sent));
        const requested = yield* Effect.promise(() =>
          probe.request("POST", "/magic-link/request", { json: { email: "probe@example.com" } }),
        );
        assert.strictEqual(requested.status, 202);
        yield* awaitMails(Effect.promise(mails), 1);
        const token = secretOf(
          (yield* Effect.promise(mails)).findLast((m) => m.template === "magic-link"),
          "token",
        );
        const verified = yield* Effect.promise(() =>
          probe.request("POST", "/magic-link/verify", {
            json: { token },
            headers: { [Api.TOKEN_DELIVERY_HEADER]: "bearer", "user-agent": "LinkProbe/1" },
          }),
        );
        assert.strictEqual(verified.status, 200);
        const body = Schema.decodeUnknownSync(SessionContract.SessionDto)(
          yield* Effect.promise(() => verified.json()),
        );
        const session = yield* Effect.promise(() =>
          probe.run(
            Effect.flatMap(Effect.service(Sessions.Sessions), (sessions) =>
              sessions.verify(Redacted.make(body.token ?? "")),
            ),
          ),
        );
        assert.deepStrictEqual(session.session.ipAddress, Option.some("198.51.100.17"));
        assert.deepStrictEqual(session.session.userAgent, Option.some("LinkProbe/1"));
        // `requestByIp` is 30 per window: one request above, 29 more, then refused; another address is not.
        const request = (app: typeof probe, i: number) =>
          Effect.promise(() =>
            app.request("POST", "/magic-link/request", { json: { email: `p${i}@example.com` } }),
          ).pipe(Effect.map((response) => response.status));
        for (let i = 0; i < 29; i++) assert.strictEqual(yield* request(probe, i), 202);
        assert.strictEqual(yield* request(probe, 29), 429);
        const other = appAt("198.51.100.18");
        assert.strictEqual(yield* request(other, 30), 202);
        yield* Effect.promise(() => Promise.all([probe.dispose(), other.dispose()]));
      }),
  );

  it.live(
    "a link is requested (202), never consumable by GET, and POST /magic-link/verify signs in once",
    () =>
      Effect.gen(function* () {
        const before = (yield* Effect.promise(sentMail)).length;
        const requested = yield* call("POST", "/magic-link/request", { email: "ada@example.com" });
        assert.strictEqual(requested.status, 202);
        yield* awaitMails(Effect.promise(sentMail), before + 1);
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
        const before = (yield* Effect.promise(sentMail)).length;
        const requested = yield* call("POST", "/email-otp/request", { email: "otp@example.com" });
        assert.strictEqual(requested.status, 202);
        yield* awaitMails(Effect.promise(sentMail), before + 1);
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
