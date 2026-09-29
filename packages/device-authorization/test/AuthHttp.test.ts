// BEH-EA-310 to BEH-EA-315 on the wire: the real handlers behind the real CSRF and authentication middleware.
// A device speaks plain RFC 8628 (form-encoded, no cookie, no CSRF token); the person's browser speaks JSON with
// its session cookie and the double-submit CSRF token.
import { HookPoint, Sessions } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as DeviceAuthorization from "../src/DeviceAuthorization.ts";
import { CLI_CLIENT_ID, DEVICE_GRANT, makeApp, type HarnessOptions } from "./support/harness.ts";

const suites: ReadonlyArray<HarnessOptions> = [
  { store: "memory" },
  { store: "sql", suite: "device_authorization_http" },
];

interface CodeBody {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete: string;
  readonly expires_in: number;
  readonly interval: number;
}

const jsonOf = (response: Response): Promise<Record<string, unknown>> =>
  response
    .json()
    .then((body) =>
      typeof body === "object" && body !== null ? Object.fromEntries(Object.entries(body)) : {},
    );

const codeBody = (body: Record<string, unknown>): CodeBody => {
  const {
    device_code,
    user_code,
    verification_uri,
    verification_uri_complete,
    expires_in,
    interval,
  } = body;
  if (
    typeof device_code !== "string" ||
    typeof user_code !== "string" ||
    typeof verification_uri !== "string" ||
    typeof verification_uri_complete !== "string" ||
    typeof expires_in !== "number" ||
    typeof interval !== "number"
  ) {
    throw new Error(`not a device code response: ${JSON.stringify(body)}`);
  }
  return {
    device_code,
    user_code,
    verification_uri,
    verification_uri_complete,
    expires_in,
    interval,
  };
};

for (const options of suites) {
  describe(`DeviceAuthorization over HTTP (${options.store})`, () => {
    it("POST /device/code answers the RFC 8628 §3.2 body from a form-encoded, cookie-less request", async () => {
      const app = makeApp(options);
      const response = await app.handler(
        new Request("http://localhost:3000/device/code", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            host: "auth.example.test",
          },
          body: new URLSearchParams({ client_id: CLI_CLIENT_ID }).toString(),
        }),
      );
      assert.strictEqual(response.status, 200);
      const body = codeBody(await jsonOf(response));
      assert.match(body.user_code, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
      assert.strictEqual(body.expires_in, 900);
      assert.strictEqual(body.interval, 5);
      // Unset `verificationUri`: derived from the request's own origin.
      assert.strictEqual(body.verification_uri, "http://auth.example.test/device");
      assert.strictEqual(
        body.verification_uri_complete,
        `http://auth.example.test/device?user_code=${encodeURIComponent(body.user_code)}`,
      );
    });

    it("uses the configured verificationUri, and refuses an unregistered client with the RFC error body", async () => {
      const app = makeApp({
        ...options,
        config: { verificationUri: "https://app.example.com/activate" },
      });
      const ok = await app.request("POST", "/device/code", { form: { client_id: CLI_CLIENT_ID } });
      assert.strictEqual(ok.status, 200);
      assert.strictEqual(
        codeBody(await jsonOf(ok)).verification_uri,
        "https://app.example.com/activate",
      );

      const refused = await app.request("POST", "/device/code", {
        form: { client_id: "stranger" },
      });
      assert.strictEqual(refused.status, 400);
      const body = await jsonOf(refused);
      assert.strictEqual(body["error"], "invalid_client");
    });

    it("walks the whole flow: code, verify, approve, then the poll answers a Bearer token that is a normal session", async () => {
      const app = makeApp(options);
      const user = await app.signedInUser("wire@example.com", ["pwd", "otp", "mfa"]);
      const requested = await app.request("POST", "/device/code", {
        form: { client_id: CLI_CLIENT_ID },
      });
      const issued = codeBody(await jsonOf(requested));

      // Pending: the RFC 8628 §3.5 answer is a 400 with `error`.
      const pending = await app.request("POST", "/device/token", {
        form: {
          grant_type: DEVICE_GRANT,
          device_code: issued.device_code,
          client_id: CLI_CLIENT_ID,
        },
      });
      assert.strictEqual(pending.status, 400);
      assert.strictEqual((await jsonOf(pending))["error"], "authorization_pending");

      const verified = await app.request("POST", "/device/verify", {
        cookie: user.cookie,
        json: { user_code: issued.user_code },
      });
      assert.strictEqual(verified.status, 200);
      const verification = await jsonOf(verified);
      assert.strictEqual(verification["status"], "pending");
      assert.deepStrictEqual(verification["client"], {
        client_id: CLI_CLIENT_ID,
        name: "awthaq CLI",
      });

      const approved = await app.request("POST", "/device/approve", {
        cookie: user.cookie,
        json: { user_code: issued.user_code },
      });
      assert.strictEqual(approved.status, 200);
      assert.deepStrictEqual(await jsonOf(approved), {
        user_code: issued.user_code,
        status: "approved",
      });

      // The device's clock: the advised interval has to pass before the next poll is anything but slow_down.
      const early = await app.request("POST", "/device/token", {
        form: {
          grant_type: DEVICE_GRANT,
          device_code: issued.device_code,
          client_id: CLI_CLIENT_ID,
        },
      });
      assert.strictEqual(early.status, 400);
      const slow = await jsonOf(early);
      assert.strictEqual(slow["error"], "slow_down");
      assert.strictEqual(slow["interval"], 10);
    });

    it("a redeemed poll answers 200 with an RFC 6749 §5.1 body, no-store, and no cookie", async () => {
      // A 1-second interval: the one wire test that lets real time pass (the service suite uses TestClock).
      const app = makeApp({ ...options, config: { interval: Duration.seconds(1) } });
      const user = await app.signedInUser("redeem@example.com", ["pwd"]);
      const issued = codeBody(
        await jsonOf(
          await app.request("POST", "/device/code", { form: { client_id: CLI_CLIENT_ID } }),
        ),
      );
      const poll = () =>
        app.request("POST", "/device/token", {
          form: {
            grant_type: DEVICE_GRANT,
            device_code: issued.device_code,
            client_id: CLI_CLIENT_ID,
          },
        });
      assert.strictEqual((await jsonOf(await poll()))["error"], "authorization_pending");
      await app.request("POST", "/device/verify", {
        cookie: user.cookie,
        json: { user_code: issued.user_code },
      });
      await app.request("POST", "/device/approve", {
        cookie: user.cookie,
        json: { user_code: issued.user_code },
      });
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const response = await poll();
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers.get("cache-control"), "no-store");
      assert.isNull(response.headers.get("set-cookie"));
      const body = await jsonOf(response);
      assert.strictEqual(body["token_type"], "Bearer");
      assert.isString(body["access_token"]);
      assert.isAbove(Number(body["expires_in"]), 0);
      assert.strictEqual(body["scope"], "");
      // A normal session: its bearer token authenticates the person on the very same app.
      const whoami = await app.request("POST", "/device/verify", {
        headers: { authorization: `Bearer ${String(body["access_token"])}` },
        json: { user_code: "BCDF-GHJK" },
      });
      assert.strictEqual(
        whoami.status,
        404,
        "the token resolved to a session (an anonymous caller would also 404, so check below)",
      );
      const sessions = await app.withContext(
        Effect.gen(function* () {
          const list = yield* (yield* Sessions.Sessions).list(user.userId);
          return list.length;
        }).pipe(Effect.orDie),
      );
      assert.strictEqual(sessions, 2, "the approving session plus the device's");
    });

    it("the token endpoint refuses another grant type and a missing device code", async () => {
      const app = makeApp(options);
      const grant = await app.request("POST", "/device/token", {
        form: { grant_type: "password", device_code: "x", client_id: CLI_CLIENT_ID },
      });
      assert.strictEqual(grant.status, 400);
      assert.strictEqual((await jsonOf(grant))["error"], "unsupported_grant_type");
      const empty = await app.request("POST", "/device/token", {
        form: { grant_type: DEVICE_GRANT, device_code: "", client_id: CLI_CLIENT_ID },
      });
      assert.strictEqual(empty.status, 400);
      assert.strictEqual((await jsonOf(empty))["error"], "invalid_request");
      const unknown = await app.request("POST", "/device/token", {
        form: { grant_type: DEVICE_GRANT, device_code: "never-issued", client_id: CLI_CLIENT_ID },
      });
      assert.strictEqual(unknown.status, 400);
      assert.strictEqual((await jsonOf(unknown))["error"], "invalid_grant");
    });

    it("approve and deny need a session (401), and a forged request is rejected by CSRF before any credential work", async () => {
      const app = makeApp(options);
      const anonymous = await app.request("POST", "/device/approve", {
        json: { user_code: "BCDF-GHJK" },
      });
      assert.strictEqual(anonymous.status, 401);
      const user = await app.signedInUser("csrf@example.com");
      const forged = await app.handler(
        new Request("http://localhost:3000/device/approve", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: user.cookie,
            "sec-fetch-site": "cross-site",
          },
          body: JSON.stringify({ user_code: "BCDF-GHJK" }),
        }),
      );
      assert.strictEqual(forged.status, 403);
      const forgedVerify = await app.handler(
        new Request("http://localhost:3000/device/verify", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: user.cookie,
            "sec-fetch-site": "cross-site",
          },
          body: JSON.stringify({ user_code: "BCDF-GHJK" }),
        }),
      );
      assert.strictEqual(forgedVerify.status, 403);
    });

    it("an anonymous verify shows only the code and its status, and never claims it", async () => {
      const app = makeApp(options);
      const issued = codeBody(
        await jsonOf(
          await app.request("POST", "/device/code", { form: { client_id: CLI_CLIENT_ID } }),
        ),
      );
      const response = await app.request("POST", "/device/verify", {
        json: { user_code: issued.user_code },
      });
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(await jsonOf(response), {
        user_code: issued.user_code,
        status: "pending",
      });
      const wrong = await app.request("POST", "/device/verify", {
        json: { user_code: "BCDF-GHJK" },
      });
      assert.strictEqual(wrong.status, 404);
      assert.strictEqual((await jsonOf(wrong))["_tag"], "InvalidUserCode");
    });

    it("approve before the claim is 409; a bearer session approves like a cookie one", async () => {
      const app = makeApp(options);
      const user = await app.signedInUser("bearer@example.com");
      const issued = codeBody(
        await jsonOf(
          await app.request("POST", "/device/code", { form: { client_id: CLI_CLIENT_ID } }),
        ),
      );
      const early = await app.request("POST", "/device/approve", {
        cookie: user.cookie,
        json: { user_code: issued.user_code },
      });
      assert.strictEqual(early.status, 409);
      await app.request("POST", "/device/verify", {
        headers: { authorization: `Bearer ${user.bearer}` },
        json: { user_code: issued.user_code },
      });
      const denied = await app.request("POST", "/device/deny", {
        headers: { authorization: `Bearer ${user.bearer}` },
        json: { user_code: issued.user_code },
      });
      assert.strictEqual(denied.status, 200);
      assert.deepStrictEqual(await jsonOf(denied), {
        user_code: issued.user_code,
        status: "denied",
      });
    });

    it("a BeforeDeviceApproval veto surfaces as the typed HookAborted (403)", async () => {
      const veto = DeviceAuthorization.BeforeDeviceApproval.tap(() =>
        Effect.fail(new HookPoint.HookAbort({ code: "NOT_THIS_CLIENT" })),
      );
      const app = makeApp(options, veto);
      const user = await app.signedInUser("vetoed@example.com");
      const issued = codeBody(
        await jsonOf(
          await app.request("POST", "/device/code", { form: { client_id: CLI_CLIENT_ID } }),
        ),
      );
      await app.request("POST", "/device/verify", {
        cookie: user.cookie,
        json: { user_code: issued.user_code },
      });
      const response = await app.request("POST", "/device/approve", {
        cookie: user.cookie,
        json: { user_code: issued.user_code },
      });
      assert.strictEqual(response.status, 403);
      const body = await jsonOf(response);
      assert.strictEqual(body["_tag"], "HookAborted");
      assert.strictEqual(body["code"], "NOT_THIS_CLIENT");
    });
  });
}
