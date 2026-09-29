// TS-007: the example composition, booted in-process and driven over its real HTTP surface. It
// proves the two seams an application uses for policy the library does not own:
//   - qadi's Path B `RequirePermission` guards `GET /roles/catalog`: a subject without
//     `roles:read` gets 403, one whose role carries it gets 200;
//   - a `BeforeSignUp` veto tap (an e-mail domain allow-list) refuses a disallowed address with
//     the typed `HookAborted` before any account exists, and lets an allowed one through.
import { Api } from "@awthaq/api";
import { Users } from "@awthaq/core";
import { Roles } from "@awthaq/roles";
import { assert, describe, it } from "@effect/vitest";
import { createHmac, randomBytes } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { buildApp, demoCsrfSecret } from "../app.ts";

const ORIGIN = "http://localhost:3001";
const PASSWORD = "Zx9-quartz-Lantern-7431-orbit";

// The breach-check transport, stubbed: an empty range response means "not breached", so the suite
// never touches the network.
const NoBreachHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
  ),
);

const { handler, run: withServices } = buildApp(NoBreachHttpClient);

// `<iat>.<random>.<hmac(iat.random)>` — the double-submit pair CSRF protection requires on a mutation.
const csrfToken = (() => {
  const signed = `${Math.floor(Date.now() / 1000)}.${randomBytes(32).toString("hex")}`;
  return `${signed}.${createHmac("sha256", demoCsrfSecret).update(signed).digest("hex")}`;
})();

const call = (method: string, path: string, options?: { cookie?: string; body?: unknown }) =>
  handler(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        cookie: [options?.cookie, `${Api.CSRF_COOKIE_NAME}=${csrfToken}`]
          .filter((part) => part !== undefined)
          .join("; "),
        [Api.CSRF_HEADER_NAME]: csrfToken,
      },
      ...(options?.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );

const signUp = (email: string) =>
  call("POST", "/password/sign-up", { body: { email, password: PASSWORD } });

/** The bare `name=value` of the session cookie a response set. */
const sessionCookie = (response: Response): string => {
  const header = response.headers.getSetCookie().find((c) => c.startsWith("__Host-session="));
  return header?.split(";")[0] ?? "";
};

describe("examples/memory-server (TS-007)", () => {
  it("the BeforeSignUp allow-list refuses a disallowed domain with HookAborted and creates nothing", async () => {
    const refused = await signUp("intruder@evil.test");
    assert.strictEqual(refused.status, 403);
    const body = (await refused.json()) as { readonly _tag: string; readonly code?: string };
    assert.strictEqual(body._tag, "HookAborted");
    assert.strictEqual(body.code, "EMAIL_DOMAIN_NOT_ALLOWED");
    const found = await withServices(
      Users.Users.use((users) => users.findByEmail("intruder@evil.test")),
    );
    assert.isTrue(Option.isNone(found));
  });

  it("an allowed domain signs up and gets a session cookie", async () => {
    const accepted = await signUp("ada@example.com");
    assert.strictEqual(accepted.status, 200);
    assert.notStrictEqual(sessionCookie(accepted), "");
  });

  it("Path B RequirePermission: 403 without roles:read (anonymous and signed in), 200 once the role is held", async () => {
    assert.strictEqual((await call("GET", "/roles/catalog")).status, 403);

    const signedUp = await signUp("grace@example.com");
    assert.strictEqual(signedUp.status, 200);
    const cookie = sessionCookie(signedUp);
    assert.strictEqual((await call("GET", "/roles/catalog", { cookie })).status, 403);

    // Bootstrap an admin the way the README says: `Roles.assign` is the trusted primitive.
    await withServices(
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const roles = yield* Roles.Roles;
        const grace = yield* users.findByEmail("grace@example.com");
        if (Option.isNone(grace)) return yield* Effect.die("the signed-up user is missing");
        yield* roles.assign(grace.value.id, "platform:admin");
      }),
    );

    const allowed = await call("GET", "/roles/catalog", { cookie });
    assert.strictEqual(allowed.status, 200);
    const catalog = (await allowed.json()) as ReadonlyArray<{ readonly name: string }>;
    assert.deepStrictEqual(
      catalog.map((role) => role.name),
      ["platform:admin"],
    );
  });
});
