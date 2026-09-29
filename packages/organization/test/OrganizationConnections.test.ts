// EP-004/CWM-001 (ADR-EA-018, BEH-EA-235): per-organization OAuth connections.
// The store validates and seals; `OrganizationConnections` (a `LayerMap`) turns
// an organization's rows into provider configs; `oauthConnections` installs the
// resolver `@awthaq/oauth` consults after its static registry — proven here end
// to end by completing a real callback through a stored connection.
import {
  AuditLog,
  AuthEvents,
  Accounts,
  Hooks,
  RateLimits,
  Sessions,
  Users,
  Verification,
} from "@awthaq/core";
import { OAuth, OAuthConnections } from "@awthaq/oauth";
import { ClientAddress, Encryption, KeyProvider, RateLimiter, SqlTransaction } from "@awthaq/ports";
import { Authentication } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { fakeHttpClient } from "../../oauth/test/FakeProvider.ts";
import * as ConnectionRecords from "../src/ConnectionRecords.ts";
import * as OrganizationConnections from "../src/OrganizationConnections.ts";
import * as OrganizationHooks from "../src/OrganizationHooks.ts";

const EncryptionLive = Encryption.layer.pipe(
  Layer.provide(
    KeyProvider.layerEnv.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { AWTHAQ_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") },
          }),
        ),
      ),
    ),
  ),
  Layer.provide(NodeCrypto.layer),
);

/** Connection storage, sealing and the LayerMap — everything but OAuth. */
const ConnectionsLive = Layer.mergeAll(
  OrganizationConnections.layerStore,
  OrganizationConnections.oauthConnections,
).pipe(
  Layer.provideMerge(OrganizationConnections.OrganizationConnections.layer),
  Layer.provideMerge(ConnectionRecords.layerMemory),
  Layer.provideMerge(EncryptionLive),
  Layer.provideMerge(NodeCrypto.layer),
);

const baseUrl = "https://app.example.com";

const oidcInput = (
  organizationId: string,
  overrides: Partial<OrganizationConnections.ConnectionCreateInput> = {},
): OrganizationConnections.ConnectionCreateInput => ({
  organizationId,
  kind: "oidc",
  name: "Acme SSO",
  issuer: "https://idp.acme.example",
  discoveryUrl: "https://idp.acme.example/.well-known/openid-configuration",
  clientId: "client-1",
  clientSecret: Redacted.make("super-secret"),
  emailDomains: ["acme.example"],
  ...overrides,
});

const oauth2Input = (organizationId: string): OrganizationConnections.ConnectionCreateInput => ({
  organizationId,
  kind: "oauth2",
  name: "Acme OAuth",
  authorizationEndpoint: "https://acme.example.com/authorize",
  tokenEndpoint: "https://acme.example.com/token",
  userinfoEndpoint: "https://acme.example.com/userinfo",
  clientId: "acme-client-id",
  clientSecret: Redacted.make("acme-secret"),
  scopes: ["read"],
});

describe("OrganizationConnectionStore (BEH-EA-235)", () => {
  it.effect("the client secret is ciphertext at rest and never shown back", () =>
    Effect.gen(function* () {
      const store = yield* OrganizationConnections.OrganizationConnectionStore;
      const records = yield* ConnectionRecords.ConnectionRecords;
      const view = yield* store.create(oidcInput("org-1"));
      assert.isTrue(view.hasClientSecret);
      assert.strictEqual(view.providerId, `org:org-1:${view.id}`);
      const stored = yield* records.findById("org-1", view.id);
      assert.isTrue(Option.isSome(stored));
      if (Option.isSome(stored) && Option.isSome(stored.value.clientSecret)) {
        const envelope = stored.value.clientSecret.value;
        assert.notInclude(envelope, "super-secret");
        assert.isTrue(Encryption.looksLikeEnvelope(envelope));
      } else {
        assert.fail("the secret should have been stored");
      }
      assert.notProperty(view, "clientSecret");
    }).pipe(Effect.provide(ConnectionsLive)),
  );

  it.effect("a host NAME that merely starts like an IPv6 prefix is accepted; real IPv6 private literals are not", () =>
    Effect.gen(function* () {
      const store = yield* OrganizationConnections.OrganizationConnectionStore;
      const outcome = (url: string) =>
        store
          .create(oidcInput("org-1", { discoveryUrl: url, emailDomains: [] }))
          .pipe(Effect.match({ onFailure: (failure) => failure._tag, onSuccess: () => "created" }));
      // Regression: `host.startsWith("fc" | "fd" | "fe80")` refused these legitimate names.
      assert.strictEqual(yield* outcome("https://fcm.acme.example/.well-known/openid-configuration"), "created");
      assert.strictEqual(yield* outcome("https://fdic.acme.example/.well-known/openid-configuration"), "created");
      // The literals the prefix test existed for, plus an IPv4-mapped loopback it never caught.
      assert.strictEqual(yield* outcome("https://[fc00::1]/x"), "InvalidConnection");
      assert.strictEqual(yield* outcome("https://[fd12:3456::1]/x"), "InvalidConnection");
      assert.strictEqual(yield* outcome("https://[fe80::1]/x"), "InvalidConnection");
      assert.strictEqual(yield* outcome("https://[::ffff:127.0.0.1]/x"), "InvalidConnection");
    }).pipe(Effect.provide(ConnectionsLive)),
  );

  it.effect("rejects what an organization must not be able to point the server at", () =>
    Effect.gen(function* () {
      const store = yield* OrganizationConnections.OrganizationConnectionStore;
      const reject = (overrides: Partial<OrganizationConnections.ConnectionCreateInput>) =>
        store.create(oidcInput("org-1", overrides)).pipe(
          Effect.flip,
          Effect.map((failure) => failure._tag),
        );
      const discovery = (url: string) => ({ discoveryUrl: url, emailDomains: [] });
      assert.strictEqual(
        yield* reject(discovery("http://idp.acme.example/.well-known/openid-configuration")),
        "InvalidConnection",
      );
      assert.strictEqual(yield* reject(discovery("https://localhost/x")), "InvalidConnection");
      assert.strictEqual(yield* reject(discovery("https://10.0.0.5/x")), "InvalidConnection");
      assert.strictEqual(
        yield* reject(discovery("https://169.254.169.254/x")),
        "InvalidConnection",
      );
      assert.strictEqual(yield* reject(discovery("https://[::1]/x")), "InvalidConnection");
      assert.strictEqual(yield* reject(discovery("https://idp.internal/x")), "InvalidConnection");
      assert.strictEqual(
        yield* reject(discovery("https://user:pw@idp.acme.example/x")),
        "InvalidConnection",
      );
      assert.strictEqual(yield* reject({ issuer: undefined }), "InvalidConnection");
      assert.strictEqual(yield* reject({ scopes: ["email"] }), "InvalidConnection");
      assert.strictEqual(
        yield* reject({ discoveryUrl: undefined, emailDomains: [] }),
        "InvalidConnection",
      );
      assert.strictEqual(yield* reject({ emailDomains: ["not a domain"] }), "InvalidConnection");
      assert.strictEqual(yield* reject({ name: "  ", emailDomains: [] }), "InvalidConnection");
    }).pipe(Effect.provide(ConnectionsLive)),
  );

  it.effect("normalizes email domains and refuses one another connection already routes", () =>
    Effect.gen(function* () {
      const store = yield* OrganizationConnections.OrganizationConnectionStore;
      const first = yield* store.create(
        oidcInput("org-1", { emailDomains: [" Acme.Example ", "acme.example"] }),
      );
      assert.deepStrictEqual(first.emailDomains, ["acme.example"]);
      const clash = yield* store
        .create(oidcInput("org-2", { emailDomains: ["acme.example"] }))
        .pipe(Effect.flip);
      assert.strictEqual(clash._tag, "ConnectionDomainTaken");
    }).pipe(Effect.provide(ConnectionsLive)),
  );

  it.effect("discover routes by organization id, then by email domain", () =>
    Effect.gen(function* () {
      const store = yield* OrganizationConnections.OrganizationConnectionStore;
      const view = yield* store.create(oidcInput("org-1"));
      assert.deepStrictEqual(
        yield* store.discover({ organizationId: "org-1" }),
        Option.some(view.providerId),
      );
      assert.deepStrictEqual(
        yield* store.discover({ email: "Ada@ACME.example" }),
        Option.some(view.providerId),
      );
      assert.isTrue(Option.isNone(yield* store.discover({ email: "ada@other.example" })));
      assert.isTrue(Option.isNone(yield* store.discover({ organizationId: "org-9" })));
      assert.isTrue(Option.isNone(yield* store.discover({ email: "not-an-email" })));
    }).pipe(Effect.provide(ConnectionsLive)),
  );
});

describe("oauthConnections resolver (BEH-EA-235)", () => {
  it.effect(
    "resolves a stored connection to a provider config, cached per organization, revisioned by edits",
    () =>
      Effect.gen(function* () {
        const store = yield* OrganizationConnections.OrganizationConnectionStore;
        const resolver = Option.getOrThrow(yield* OAuthConnections.OAuthConnectionResolver);
        const view = yield* store.create(oidcInput("org-1"));
        const found = yield* resolver.find(view.providerId);
        assert.isTrue(Option.isSome(found));
        if (Option.isSome(found)) {
          assert.strictEqual(found.value.config.id, view.providerId);
          assert.strictEqual(found.value.config.kind, "oidc");
          assert.strictEqual(found.value.config.clientId, "client-1");
        }
        // A second lookup is served from the LayerMap entry (same revision).
        const again = yield* resolver.find(view.providerId);
        assert.strictEqual(Option.getOrThrow(again).revision, Option.getOrThrow(found).revision);
        // An edit invalidates the entry: the new revision and the new client id show up at once.
        yield* store.update("org-1", view.id, { clientId: "client-2" });
        const edited = Option.getOrThrow(yield* resolver.find(view.providerId));
        assert.strictEqual(edited.config.clientId, "client-2");
        assert.notStrictEqual(edited.revision, Option.getOrThrow(found).revision);
        // Removing it makes the id unknown again.
        yield* store.remove("org-1", view.id);
        assert.isTrue(Option.isNone(yield* resolver.find(view.providerId)));
      }).pipe(Effect.provide(ConnectionsLive)),
  );

  it.effect("static ids, other organizations' ids and malformed ids resolve to nothing", () =>
    Effect.gen(function* () {
      const store = yield* OrganizationConnections.OrganizationConnectionStore;
      const resolver = Option.getOrThrow(yield* OAuthConnections.OAuthConnectionResolver);
      const view = yield* store.create(oidcInput("org-1"));
      assert.isTrue(Option.isNone(yield* resolver.find("google")));
      assert.isTrue(Option.isNone(yield* resolver.find("org:org-1")));
      assert.isTrue(Option.isNone(yield* resolver.find(`org:org-2:${view.id}`)));
      assert.isTrue(Option.isNone(yield* resolver.find(`org:org-1:no-such-connection`)));
    }).pipe(Effect.provide(ConnectionsLive)),
  );

  it.effect("a connection whose secret no longer decrypts is dropped alone", () =>
    Effect.gen(function* () {
      const store = yield* OrganizationConnections.OrganizationConnectionStore;
      const records = yield* ConnectionRecords.ConnectionRecords;
      const resolver = Option.getOrThrow(yield* OAuthConnections.OAuthConnectionResolver);
      const good = yield* store.create(oidcInput("org-1", { emailDomains: [] }));
      const bad = yield* store.create(oidcInput("org-1", { emailDomains: ["bad.example"] }));
      yield* records.update("org-1", bad.id, { clientSecret: "not-an-envelope" });
      yield* OrganizationConnections.OrganizationConnections.invalidate("org-1");
      assert.isTrue(Option.isSome(yield* resolver.find(good.providerId)));
      assert.isTrue(Option.isNone(yield* resolver.find(bad.providerId)));
    }).pipe(Effect.provide(ConnectionsLive)),
  );
});

describe("cleanupOnOrganizationDelete (BEH-EA-235)", () => {
  it.effect("deleting an organization removes its connections and frees their domains", () =>
    Effect.gen(function* () {
      const store = yield* OrganizationConnections.OrganizationConnectionStore;
      const records = yield* ConnectionRecords.ConnectionRecords;
      yield* store.create(oidcInput("org-1"));
      yield* store.create(oidcInput("org-2", { emailDomains: ["other.example"] }));
      const afterDelete = yield* OrganizationHooks.AfterDeleteOrganization;
      yield* afterDelete.run({ organizationId: "org-1" });
      assert.strictEqual((yield* records.listByOrganization("org-1")).length, 0);
      assert.isTrue(Option.isNone(yield* records.findByEmailDomain("acme.example")));
      assert.strictEqual((yield* records.listByOrganization("org-2")).length, 1);
    }).pipe(
      Effect.provide(
        // A tap's layer requires its point (ELC-001), so the point is provided to it.
        OrganizationConnections.cleanupOnOrganizationDelete.pipe(
          Layer.provideMerge(OrganizationHooks.OrganizationHooksLive),
          Layer.provideMerge(ConnectionsLive),
        ),
      ),
    ),
  );
});

// ---- end to end: a stored connection completes a real OAuth callback ------------------

const CoreLive = Layer.mergeAll(
  Users.layerMemory,
  Accounts.layerMemory,
  Sessions.layerMemory,
  Verification.layerMemory,
).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(NodeCrypto.layer),
);

const OAuthLive = OAuth.OAuth.layer.pipe(
  Layer.provide(OrganizationConnections.oauthConnections),
  Layer.provide(Authentication.OptionalAuthenticationLive),
  Layer.provide(Authentication.PrincipalResolverLive),
  Layer.provideMerge(CoreLive),
  Layer.provideMerge(RateLimiter.layerPermissive),
  Layer.provideMerge(RateLimits.layer),
  Layer.provideMerge(SqlTransaction.layerNoop),
  Layer.provideMerge(ClientAddress.layerDirect),
  Layer.provideMerge(EncryptionLive),
  Layer.provide(
    fakeHttpClient({
      "/token": { access_token: "at-1" },
      "/userinfo": { id: "acme-user-1", email: "ada@acme.example", email_verified: true },
    }),
  ),
  Layer.provide(OAuth.config({ providers: [], baseUrl, retry: { base: Duration.zero, times: 0 } })),
  Layer.provideMerge(ConnectionsLive),
);

describe("a stored connection completes a full OAuth flow (EP-004)", () => {
  it.effect("an organization adds a connection at runtime and its users sign in through it", () =>
    Effect.gen(function* () {
      const store = yield* OrganizationConnections.OrganizationConnectionStore;
      const oauth = yield* OAuth.OAuth;
      const accounts = yield* Accounts.Accounts;
      const users = yield* Users.Users;

      // Before the connection exists, the id is simply unknown.
      const unknown = yield* oauth
        .authorize("org:org-1:nope", { callbackURL: undefined, link: undefined })
        .pipe(Effect.flip);
      assert.strictEqual(unknown._tag, "ProviderNotFound");

      // Home-realm discovery: the email domain names the connection to redirect to.
      const view = yield* store.create({ ...oauth2Input("org-1"), emailDomains: ["acme.example"] });
      const routed = yield* store.discover({ email: "ada@acme.example" });
      assert.deepStrictEqual(routed, Option.some(view.providerId));

      const { location, state } = yield* oauth.authorize(view.providerId, {
        callbackURL: undefined,
        link: undefined,
      });
      assert.strictEqual(new URL(location).searchParams.get("client_id"), "acme-client-id");
      const outcome = yield* oauth.callback(view.providerId, {
        code: "auth-code",
        state,
        iss: undefined,
        cookieState: state,
      });
      assert.isDefined(outcome.session);
      const linked = yield* accounts.findByProviderSubject(view.providerId, "acme-user-1", "");
      assert.isTrue(Option.isSome(linked));
      const user = yield* users.findByEmail("ada@acme.example");
      assert.isTrue(Option.isSome(user));
    }).pipe(Effect.provide(OAuthLive)),
  );
});
