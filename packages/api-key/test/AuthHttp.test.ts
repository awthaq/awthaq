// spec/models/07-api-keys.md, BEH-EA-140/141/065/072 (OCM-002, MAPS-003, OCM-001): the
// plugin over a real `HttpRouter` web handler — `x-api-key` and service bearer tokens on
// the machine tier, the user tier refusing both, the management endpoints behind a session
// and the RFC 6749 token endpoint.
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import { makeApp, type HarnessOptions } from "./harness.ts";

interface CreatedKey {
  readonly id: string;
  readonly key: string;
  readonly scopes: ReadonlyArray<string>;
  readonly start: string;
}

const json = async <A>(response: Response): Promise<A> => {
  const body: A = await response.json();
  return body;
};

const suite = (store: HarnessOptions["store"]) =>
  describe(`AuthHttp + ApiKey (real HTTP, ${store} records)`, () => {
    const newApp = (options: Partial<HarnessOptions> = {}) =>
      makeApp({ store, suite: "api_key_http", ...options });

    /** A signed-in user creating a key over the real management endpoint. */
    const createKey = async (
      app: ReturnType<typeof newApp>,
      cookie: string,
      scopes: ReadonlyArray<string> = ["reports:read"],
    ) => {
      const response = await app.request("POST", "/api-key", {
        cookie,
        json: { name: "ci", scopes },
      });
      assert.strictEqual(response.status, 200);
      return json<CreatedKey>(response);
    };

    it("x-api-key resolves CurrentPrincipal to an ApiKeyPrincipal carrying the key's scopes", async () => {
      const app = newApp();
      const cookie = await app.sessionCookie("user-1");
      const key = await createKey(app, cookie, ["scim:users:write", "reports:read"]);
      const response = await app.request("GET", "/probe/machine", {
        headers: { "x-api-key": key.key },
      });
      assert.strictEqual(response.status, 200);
      assert.strictEqual(
        await json<string>(response),
        `ApiKey:${key.id}:scim:users:write,reports:read`,
      );
    });

    it("the user tier never accepts an API key: 401 on an Authentication group", async () => {
      const app = newApp();
      const cookie = await app.sessionCookie("user-1");
      const key = await createKey(app, cookie);
      const response = await app.request("GET", "/probe/user", {
        headers: { "x-api-key": key.key },
      });
      assert.strictEqual(response.status, 401);
      // ...nor may a key call the management endpoints (only a session can mint credentials).
      const mint = await app.request("POST", "/api-key", {
        headers: { "x-api-key": key.key },
        json: { name: "escalate", scopes: ["admin:all"] },
      });
      assert.strictEqual(mint.status, 401);
    });

    it("cookie still wins when a session and an x-api-key are both present (BEH-EA-072)", async () => {
      const app = newApp();
      const cookie = await app.sessionCookie("user-1");
      const key = await createKey(app, cookie);
      const response = await app.request("GET", "/probe/machine", {
        cookie,
        headers: { "x-api-key": key.key },
      });
      assert.strictEqual(response.status, 200);
      assert.match(await json<string>(response), /^User:user-1:/);
    });

    it("a garbage, wrong-secret or missing key is 401", async () => {
      const app = newApp();
      const cookie = await app.sessionCookie("user-1");
      const key = await createKey(app, cookie);
      const forged = `${key.key.slice(0, key.key.indexOf(".") + 1)}${"0".repeat(64)}`;
      for (const headers of [{ "x-api-key": "not-a-key" }, { "x-api-key": forged }, {}]) {
        const response = await app.request("GET", "/probe/machine", { headers });
        assert.strictEqual(response.status, 401);
      }
    });

    it("revoking over HTTP kills the key on its very next request", async () => {
      const app = newApp();
      const cookie = await app.sessionCookie("user-1");
      const key = await createKey(app, cookie);
      const probe = () =>
        app.request("GET", "/probe/machine", { headers: { "x-api-key": key.key } });
      assert.strictEqual((await probe()).status, 200);
      const revoked = await app.request("DELETE", `/api-key/${key.id}`, { cookie });
      assert.strictEqual(revoked.status, 204);
      assert.strictEqual((await probe()).status, 401);
    });

    it("list never returns the key, and someone else's key is a 404", async () => {
      const app = newApp();
      const cookie = await app.sessionCookie("user-1");
      const key = await createKey(app, cookie);
      const listed = await app.request("GET", "/api-key", { cookie });
      assert.strictEqual(listed.status, 200);
      const body = await listed.text();
      assert.notInclude(body, key.key);
      assert.notInclude(body, key.key.slice(key.key.indexOf(".") + 1));
      assert.include(body, key.id);

      const other = await app.sessionCookie("user-2");
      const stolen = await app.request("DELETE", `/api-key/${key.id}`, { cookie: other });
      assert.strictEqual(stolen.status, 404);
      const empty = await app.request("GET", "/api-key", { cookie: other });
      assert.deepStrictEqual(await json<Array<unknown>>(empty), []);
    });

    it("rotate over HTTP: the old key survives the grace window, the successor works", async () => {
      const app = newApp();
      const cookie = await app.sessionCookie("user-1");
      const old = await createKey(app, cookie);
      const rotated = await app.request("POST", `/api-key/${old.id}/rotate`, {
        cookie,
        json: { gracePeriodSeconds: 3600 },
      });
      assert.strictEqual(rotated.status, 200);
      const successor = await json<CreatedKey>(rotated);
      assert.notStrictEqual(successor.id, old.id);
      for (const key of [old, successor]) {
        const response = await app.request("GET", "/probe/machine", {
          headers: { "x-api-key": key.key },
        });
        assert.strictEqual(response.status, 200);
      }
    });

    it("management errors are typed: bad scopes 422, unknown key 404, bad body 400", async () => {
      const app = newApp({ config: { grantableScopes: ["reports:read"] } });
      const cookie = await app.sessionCookie("user-1");
      const refused = await app.request("POST", "/api-key", {
        cookie,
        json: { name: "k", scopes: ["admin:all"] },
      });
      assert.strictEqual(refused.status, 422);
      const body = await json<{ _tag: string; scopes: ReadonlyArray<string> }>(refused);
      assert.strictEqual(body._tag, "ApiKeyScopeNotGrantable");
      assert.deepStrictEqual(body.scopes, ["admin:all"]);
      const missing = await app.request("DELETE", "/api-key/nope", { cookie });
      assert.strictEqual(missing.status, 404);
      const invalid = await app.request("POST", "/api-key", { cookie, json: { name: "" } });
      assert.strictEqual(invalid.status, 400);
    });

    it("a throttled address is refused even with a valid key (per-IP resolve limit)", async () => {
      const app = newApp({
        rateLimiter: "enforcing",
        config: { resolveRateLimit: { limit: 3, window: Duration.minutes(1) } },
      });
      const cookie = await app.sessionCookie("user-1");
      const key = await createKey(app, cookie);
      const statuses: Array<number> = [];
      for (let attempt = 0; attempt < 5; attempt++) {
        const response = await app.request("GET", "/probe/machine", {
          headers: { "x-api-key": key.key },
        });
        statuses.push(response.status);
      }
      assert.deepStrictEqual(statuses, [200, 200, 200, 401, 401]);
    });

    describe("client_credentials over the token endpoint (RFC 6749 §4.4)", () => {
      interface Registered {
        readonly clientId: string;
        readonly clientSecret: string;
      }
      const register = async (app: ReturnType<typeof newApp>, scopes: ReadonlyArray<string>) => {
        const cookie = await app.sessionCookie("user-1");
        const response = await app.request("POST", "/api-key/client", {
          cookie,
          json: { name: "billing", scopes },
        });
        assert.strictEqual(response.status, 200);
        return { cookie, client: await json<Registered>(response) };
      };
      const basic = (client: Registered) =>
        `Basic ${btoa(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`)}`;
      const tokenPost = (
        app: ReturnType<typeof newApp>,
        form: Record<string, string>,
        headers: Record<string, string> = {},
      ) => app.request("POST", "/api-key/token", { form, headers });

      it("client_secret_post mints an RFC 6749 §5.1 response whose token authenticates as a ServicePrincipal", async () => {
        const app = newApp();
        const { client } = await register(app, ["invoices:read", "invoices:write"]);
        const response = await tokenPost(app, {
          grant_type: "client_credentials",
          client_id: client.clientId,
          client_secret: client.clientSecret,
          scope: "invoices:read",
        });
        assert.strictEqual(response.status, 200);
        const token = await json<{
          access_token: string;
          token_type: string;
          expires_in: number;
          scope: string;
        }>(response);
        assert.strictEqual(token.token_type, "Bearer");
        assert.strictEqual(token.expires_in, 900);
        assert.strictEqual(token.scope, "invoices:read");

        const used = await app.request("GET", "/probe/machine", {
          headers: { authorization: `Bearer ${token.access_token}` },
        });
        assert.strictEqual(used.status, 200);
        assert.strictEqual(await json<string>(used), `Service:${client.clientId}:invoices:read`);
      });

      it("client_secret_basic works too, and the machine tier is the only tier that takes the token", async () => {
        const app = newApp();
        const { client } = await register(app, ["invoices:read"]);
        const response = await tokenPost(
          app,
          { grant_type: "client_credentials" },
          { authorization: basic(client) },
        );
        assert.strictEqual(response.status, 200);
        const { access_token } = await json<{ access_token: string }>(response);
        const user = await app.request("GET", "/probe/user", {
          headers: { authorization: `Bearer ${access_token}` },
        });
        assert.strictEqual(user.status, 401);
      });

      it("errors are RFC 6749 §5.2 shaped: invalid_client 401, unsupported_grant_type / invalid_scope / invalid_request 400", async () => {
        const app = newApp();
        const { client } = await register(app, ["invoices:read"]);
        const wrongSecret = await tokenPost(app, {
          grant_type: "client_credentials",
          client_id: client.clientId,
          client_secret: "cs_wrong",
        });
        assert.strictEqual(wrongSecret.status, 401);
        assert.strictEqual((await json<{ error: string }>(wrongSecret)).error, "invalid_client");

        const grant = await tokenPost(app, {
          grant_type: "password",
          client_id: client.clientId,
          client_secret: client.clientSecret,
        });
        assert.strictEqual(grant.status, 400);
        assert.strictEqual((await json<{ error: string }>(grant)).error, "unsupported_grant_type");

        const scope = await tokenPost(app, {
          grant_type: "client_credentials",
          client_id: client.clientId,
          client_secret: client.clientSecret,
          scope: "admin:all",
        });
        assert.strictEqual(scope.status, 400);
        assert.strictEqual((await json<{ error: string }>(scope)).error, "invalid_scope");

        const missing = await tokenPost(app, { grant_type: "client_credentials" });
        assert.strictEqual(missing.status, 400);
        assert.strictEqual((await json<{ error: string }>(missing)).error, "invalid_request");

        const malformedBasic = await tokenPost(
          app,
          { grant_type: "client_credentials" },
          { authorization: "Basic !!!not-base64!!!" },
        );
        assert.strictEqual(malformedBasic.status, 400);
      });

      it("revoking a client blocks new tokens over HTTP", async () => {
        const app = newApp();
        const { cookie, client } = await register(app, ["invoices:read"]);
        const form = {
          grant_type: "client_credentials",
          client_id: client.clientId,
          client_secret: client.clientSecret,
        };
        assert.strictEqual((await tokenPost(app, form)).status, 200);
        const revoked = await app.request("DELETE", `/api-key/client/${client.clientId}`, {
          cookie,
        });
        assert.strictEqual(revoked.status, 204);
        assert.strictEqual((await tokenPost(app, form)).status, 401);
      });

      it("rotate-secret over HTTP: both secrets mint until the grace ends", async () => {
        const app = newApp();
        const { cookie, client } = await register(app, ["invoices:read"]);
        const rotated = await app.request(
          "POST",
          `/api-key/client/${client.clientId}/rotate-secret`,
          { cookie, json: { gracePeriodSeconds: 3600 } },
        );
        assert.strictEqual(rotated.status, 200);
        const next = await json<Registered>(rotated);
        for (const secret of [client.clientSecret, next.clientSecret]) {
          const response = await tokenPost(app, {
            grant_type: "client_credentials",
            client_id: client.clientId,
            client_secret: secret,
          });
          assert.strictEqual(response.status, 200);
        }
      });

      it("an expired service token answers 401", async () => {
        const app = newApp({ config: { serviceTokenTtl: Duration.seconds(-60) } });
        const { client } = await register(app, ["invoices:read"]);
        const response = await tokenPost(app, {
          grant_type: "client_credentials",
          client_id: client.clientId,
          client_secret: client.clientSecret,
        });
        const { access_token } = await json<{ access_token: string }>(response);
        const used = await app.request("GET", "/probe/machine", {
          headers: { authorization: `Bearer ${access_token}` },
        });
        assert.strictEqual(used.status, 401);
      });

      it("the token endpoint is throttled per client id", async () => {
        const app = newApp({
          rateLimiter: "enforcing",
          config: {
            tokenRateLimit: {
              ip: { limit: 100, window: Duration.minutes(1) },
              client: { limit: 2, window: Duration.minutes(1) },
            },
          },
        });
        const { client } = await register(app, ["invoices:read"]);
        const statuses: Array<number> = [];
        for (let attempt = 0; attempt < 4; attempt++) {
          const response = await tokenPost(app, {
            grant_type: "client_credentials",
            client_id: client.clientId,
            client_secret: "cs_guess",
          });
          statuses.push(response.status);
        }
        assert.deepStrictEqual(statuses, [401, 401, 429, 429]);
      });

      it("only a session can register clients: a service token cannot", async () => {
        const app = newApp();
        const { client } = await register(app, ["invoices:read"]);
        const response = await tokenPost(app, {
          grant_type: "client_credentials",
          client_id: client.clientId,
          client_secret: client.clientSecret,
        });
        const { access_token } = await json<{ access_token: string }>(response);
        const escalate = await app.request("POST", "/api-key/client", {
          headers: { authorization: `Bearer ${access_token}` },
          json: { name: "x", scopes: ["admin:all"] },
        });
        assert.strictEqual(escalate.status, 401);
      });
    });
  });

suite("memory");
suite("sql");
