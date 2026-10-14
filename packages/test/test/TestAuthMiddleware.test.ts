// BEH-EA-T1: `TestAuth.layer` derives the host middleware from the groups the composed api declares: a test
// never builds `Authentication`, `CsrfProtection` or their configuration, and `services` may still override one.
import { Api } from "@awthaq/api";
import { Auth, AuthPlugin } from "@awthaq/core";
import { Authentication } from "@awthaq/server";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as TestAuth from "../src/TestAuth.ts";

const who = Effect.map(
  Api.CurrentPrincipal,
  (principal) => `${principal._tag}:${principal.ref.id}`,
);

const MwApi = HttpApi.make("auth").add(
  HttpApiGroup.make("mw").add(
    HttpApiEndpoint.get("user", "/mw/user", { success: Schema.String }).middleware(
      Api.Authentication,
    ),
    HttpApiEndpoint.get("optional", "/mw/optional", { success: Schema.String }).middleware(
      Api.OptionalAuthentication,
    ),
    HttpApiEndpoint.get("machine", "/mw/machine", { success: Schema.String }).middleware(
      Api.MachineAuthentication,
    ),
    HttpApiEndpoint.post("write", "/mw/write", { success: Schema.String }).middleware(
      Api.CsrfProtection,
    ),
  ),
);

const MwAdminApi = HttpApi.make("auth").add(
  HttpApiGroup.make("mw.admin").add(
    HttpApiEndpoint.get("admin", "/mw/admin", { success: Schema.String }).middleware(
      Api.AdminAuthentication,
    ),
  ),
);

const MwHandlers = HttpApiBuilder.group(MwApi, "mw", (handlers) =>
  handlers
    .handle("user", () => who)
    .handle("optional", () => who)
    .handle("machine", () => who)
    .handle("write", () => Effect.succeed("written")),
);

const MwAdminHandlers = HttpApiBuilder.group(MwAdminApi, "mw.admin", (handlers) =>
  handlers.handle("admin", () => who),
);

class Mw extends AuthPlugin.Service<Mw, {}>()("mw", { apiVersion: 1, contract: MwApi }) {
  static readonly layer = AuthPlugin.layer(Mw, { make: Effect.succeed({}), handlers: MwHandlers });
}

class MwAdmin extends AuthPlugin.Service<MwAdmin, {}>()("mw", {
  apiVersion: 1,
  contract: MwAdminApi,
}) {
  static readonly layer = AuthPlugin.layer(MwAdmin, {
    make: Effect.succeed({}),
    handlers: MwAdminHandlers,
  });
}

const machineKey = Authentication.contribute("apiKey", {
  id: "test-key",
  claims: (raw) => raw.startsWith("tk_"),
  resolve: () =>
    Effect.succeed(
      new Api.ServicePrincipal({
        ref: new Api.PrincipalRef({ type: "service", id: "robot" }),
        scopes: [],
      }),
    ),
});

const withApp = async <A>(
  layer: Parameters<typeof TestAuth.app>[0],
  use: (app: ReturnType<typeof TestAuth.app>) => Promise<A>,
) => {
  const app = TestAuth.app(layer);
  try {
    return await use(app);
  } finally {
    await app.dispose();
  }
};

describe("TestAuth.layer derives the host middleware (BEH-EA-T1)", () => {
  it("Authentication: 401 without a credential, 200 with a minted session", async () => {
    await withApp(TestAuth.layer(Auth.make([Mw])), async (app) => {
      assert.strictEqual((await app.handler(new Request("http://localhost/mw/user"))).status, 401);
      const signedIn = await app.signIn("user@example.com");
      const response = await app.handler(
        new Request("http://localhost/mw/user", { headers: { cookie: signedIn.cookieHeader } }),
      );
      assert.strictEqual(response.status, 200);
      assert.include(await response.json(), signedIn.userId);
    });
  });

  it("OptionalAuthentication: anonymous is admitted", async () => {
    await withApp(TestAuth.layer(Auth.make([Mw])), async (app) => {
      const response = await app.handler(new Request("http://localhost/mw/optional"));
      assert.strictEqual(response.status, 200);
      assert.include(await response.json(), "Anonymous");
    });
  });

  it("AdminAuthentication alone (an admin-only composition) builds, delegating to Authentication", async () => {
    await withApp(TestAuth.layer(Auth.make([MwAdmin])), async (app) => {
      assert.strictEqual((await app.handler(new Request("http://localhost/mw/admin"))).status, 401);
      const signedIn = await app.signIn("admin@example.com");
      const response = await app.handler(
        new Request("http://localhost/mw/admin", { headers: { cookie: signedIn.cookieHeader } }),
      );
      assert.strictEqual(response.status, 200);
    });
  });

  it("MachineAuthentication admits a service principal from a test-contributed resolver", async () => {
    await withApp(TestAuth.layer(Auth.make([Mw]), { services: machineKey }), async (app) => {
      const response = await app.handler(
        new Request("http://localhost/mw/machine", { headers: { "x-api-key": "tk_anything" } }),
      );
      assert.strictEqual(response.status, 200);
      assert.include(await response.json(), "Service:robot");
    });
  });

  it("CsrfProtection: 403 without the double-submit pair, 2xx with `app.request`", async () => {
    await withApp(TestAuth.layer(Auth.make([Mw])), async (app) => {
      // A request that carries an ambient credential (any cookie) but no double-submit pair is refused.
      const bare = await app.handler(
        new Request("http://localhost/mw/write", { method: "POST", headers: { cookie: "a=b" } }),
      );
      assert.strictEqual(bare.status, 403);
      const response = await app.request("POST", "/mw/write");
      assert.strictEqual(response.status, 200);
    });
  });

  it("`csrf` overrides the default config for the derived CsrfProtection (a token minted for another secret is refused)", async () => {
    await withApp(
      TestAuth.layer(Auth.make([Mw]), {
        csrf: { secret: TestAuth.TestCsrfConfig.secret },
      }),
      async (app) => {
        const token = TestAuth.csrfToken("some-other-secret-padded-to-at-least-thirty-two-bytes");
        const response = await app.handler(
          new Request("http://localhost/mw/write", {
            method: "POST",
            headers: { cookie: `${Api.CSRF_COOKIE_NAME}=${token}`, [Api.CSRF_HEADER_NAME]: token },
          }),
        );
        assert.strictEqual(response.status, 403);
      },
    );
  });

  it("a `services` layer providing a middleware overrides the derived one", async () => {
    // A host-supplied admin scheme (a stand-in for mTLS): a fixed operator, whatever the request carries.
    const operator = Api.UserPrincipal.make({
      ref: Api.PrincipalRef.make({ type: "user", id: "operator-1" }),
      sessionId: "mtls",
    });
    const asOperator = (httpEffect: Parameters<Api.AdminAuthentication["Service"]["cookie"]>[0]) =>
      Effect.provideService(httpEffect, Api.CurrentPrincipal, operator);
    const fixedAdmin = Layer.succeed(Api.AdminAuthentication, {
      impersonation: asOperator,
      cookie: asOperator,
      bearer: asOperator,
    });
    await withApp(TestAuth.layer(Auth.make([MwAdmin]), { services: fixedAdmin }), async (app) => {
      // The derived `AdminAuthentication` answers 401 with no credential; the override lets the operator in.
      const response = await app.handler(new Request("http://localhost/mw/admin"));
      assert.strictEqual(response.status, 200);
      assert.include(await response.json(), "operator-1");
    });
  });
});
