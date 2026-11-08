// TS-007: the example composition, booted in-process and driven over its real HTTP surface. It
// proves the two seams an application uses for policy the library does not own:
//   - qadi's Path B `RequirePermission` guards `GET /roles/catalog`: a subject without
//     `roles:read` gets 403, one whose role carries it gets 200;
//   - a `BeforeSignUp` veto tap (an e-mail domain allow-list) refuses a disallowed address with
//     the typed `HookAborted` before any account exists, and lets an allowed one through;
//   - the README walkthrough ends in a real sign-in: the console mailer prints the verification
//     token (DESS-002), and the enforcing limiter answers 429 once the sign-in budget is spent
//     (CSD-010).
import { Api } from "@awthaq/api";
import { Users } from "@awthaq/core";
import { Roles } from "@awthaq/roles";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { makeAppLayer } from "../app.ts";

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

// Every message the console mailer prints, read back from the log the way a person running the
// example reads it from the terminal.
const printedMail: Array<Record<string, unknown>> = [];
const CaptureMail = Logger.layer([
  Logger.make<unknown, void>((options) => {
    const annotations = options.fiber.getRef(References.CurrentLogAnnotations);
    if (annotations["template"] !== undefined) printedMail.push({ ...annotations });
  }),
]);

// The production composition, served in-process by the harness's handle: the handler and `run` share every
// instance, so a role assigned through `run` is the one a request sees.
const app = TestAuth.app(makeAppLayer(NoBreachHttpClient).pipe(Layer.provideMerge(CaptureMail)), {
  baseUrl: ORIGIN,
});
const withServices = app.run;

// Each visitor is a user agent over the composition: it keeps its own cookies (the CSRF cookie the harness
// seeds from the example's own config, the session a sign-up or sign-in sets) and echoes the CSRF token.
type Visitor = TestAuth.SignedInAgent | Awaited<ReturnType<typeof app.agent>>;

const signUp = (visitor: Visitor, email: string) =>
  visitor.request("POST", "/password/sign-up", { json: { email, password: PASSWORD } });

const signIn = (visitor: Visitor, email: string, password: string) =>
  visitor.request("POST", "/password/sign-in", { json: { email, password } });

/** Whether the visitor now holds a session cookie. */
const holdsSession = (visitor: Visitor) =>
  visitor.cookies.get(Api.SESSION_COOKIE_NAME) !== undefined;

describe("examples/memory-server (TS-007)", () => {
  it("the BeforeSignUp allow-list refuses a disallowed domain with HookAborted and creates nothing", async () => {
    const refused = await signUp(await app.agent(), "intruder@evil.test");
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
    const ada = await app.agent();
    const accepted = await signUp(ada, "ada@example.com");
    assert.strictEqual(accepted.status, 200);
    assert.isTrue(holdsSession(ada));
  });

  it("Path B RequirePermission: 403 without roles:read (anonymous and signed in), 200 once the role is held", async () => {
    assert.strictEqual((await app.request("GET", "/roles/catalog")).status, 403);

    const grace = await app.agent();
    const signedUp = await signUp(grace, "grace@example.com");
    assert.strictEqual(signedUp.status, 200);
    assert.strictEqual((await grace.request("GET", "/roles/catalog")).status, 403);

    // Bootstrap an admin the way the README says: `Roles.assign` is the trusted primitive.
    await withServices(
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const roles = yield* Roles.Roles;
        const user = yield* users.findByEmail("grace@example.com");
        if (Option.isNone(user)) return yield* Effect.die("the signed-up user is missing");
        yield* roles.assign(user.value.id, "platform:admin");
      }),
    );

    const allowed = await grace.request("GET", "/roles/catalog");
    assert.strictEqual(allowed.status, 200);
    const catalog = (await allowed.json()) as ReadonlyArray<{ readonly name: string }>;
    assert.deepStrictEqual(
      catalog.map((role) => role.name),
      ["platform:admin"],
    );
  });

  it("the README walkthrough: sign-up, read the token from the console mail, verify, then sign in", async () => {
    const email = "walkthrough@example.com";
    assert.strictEqual((await signUp(await app.agent(), email)).status, 200);

    const reader = await app.agent();
    const blocked = await signIn(reader, email, PASSWORD);
    assert.strictEqual(blocked.status, 403);
    assert.strictEqual(
      ((await blocked.json()) as { readonly _tag: string })._tag,
      "EmailNotVerified",
    );

    const mail = printedMail.find(
      (line) => line["to"] === email && line["template"] === "verify-email",
    );
    assert.isString(mail?.["token"]);
    assert.strictEqual(
      (await reader.request("POST", "/verify-email", { json: { token: mail?.["token"] } })).status,
      204,
    );

    const signedIn = await signIn(reader, email, PASSWORD);
    assert.strictEqual(signedIn.status, 200);
    assert.isTrue(holdsSession(reader));
  });

  it("the sign-in budget is enforced: the sixth wrong password in a row is a 429, not a 401", async () => {
    const email = "brute@example.com";
    assert.strictEqual((await signUp(await app.agent(), email)).status, 200);
    const attacker = await app.agent();
    const statuses: Array<number> = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      statuses.push((await signIn(attacker, email, "definitely-not-the-password")).status);
    }
    assert.notStrictEqual(statuses[4], 429);
    assert.strictEqual(statuses[5], 429);
  });
});
