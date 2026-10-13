// EP-004/CWM-001 (ADR-EA-018, BEH-EA-235): per-organization OAuth connections.
// The store validates and seals; `OrganizationConnections` (a `LayerMap`) turns
// an organization's rows into provider configs; `oauthConnections` installs the
// resolver `@awthaq/oauth` consults after its static registry — proven here end
// to end by completing a real callback through a stored connection.
import {
  Accounts,
  AuditLog,
  Persistence,
  RateLimits,
  Sessions,
  Users,
  Verification,
} from "@awthaq/core";
import { OAuth, OAuthConnections } from "@awthaq/oauth";
import {
  ClientAddress,
  Encryption,
  KeyProvider,
  Mailer,
  RateLimiter,
  SqlTransaction,
} from "@awthaq/ports";
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
import * as DateTime from "effect/DateTime";
import * as ConnectionRecords from "../src/ConnectionRecords.ts";
import * as DomainClaims from "../src/DomainClaims.ts";
import * as OrganizationConnections from "../src/OrganizationConnections.ts";
import * as OrganizationActor from "../src/OrganizationActor.ts";
import * as OrganizationDirectory from "../src/OrganizationDirectory.ts";
import * as OrganizationHooks from "../src/OrganizationHooks.ts";
import * as OrganizationMemory from "../src/OrganizationMemory.ts";
import * as OrganizationRecords from "../src/OrganizationRecords.ts";
import * as OrganizationSystem from "../src/OrganizationSystem.ts";
import * as Organization from "../src/Organization.ts";
import { TestAuth } from "@awthaq/test";
import { grant } from "./support.ts";

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

const actor = OrganizationActor.application("OrganizationConnections.test");

/**
 * The store only asks the Directory whether an organization is active. These suites name organizations by
 * string ("org-1") without creating them, so a stub answers: every organization is active except "ghost" and
 * "suspended". The real Directory (unknown and suspended organizations, the deletion contribution) is
 * exercised in the suites below.
 */
const aRecord = (id: string): OrganizationRecords.OrganizationRecord => ({
  id,
  name: id,
  slug: id,
  logo: Option.none(),
  metadata: Option.none(),
  homeRegion: Option.none(),
  suspendedAt: Option.none(),
  createdAt: DateTime.makeUnsafe(0),
});
const unused = () => Effect.die(new Error("not used by the connection store"));
const StubDirectoryLive = Layer.succeed(
  OrganizationDirectory.OrganizationDirectory,
  OrganizationDirectory.OrganizationDirectory.of({
    find: (id) => Effect.succeed(Option.some(aRecord(id))),
    findActive: (id) =>
      Effect.succeed(
        id === "ghost" || id === "suspended" ? Option.none() : Option.some(aRecord(id)),
      ),
    requireActive: unused,
    isSlugAvailable: unused,
    listForUser: unused,
    listPage: unused,
    create: unused,
    update: unused,
    delete: unused,
    suspend: unused,
    reinstate: unused,
  }),
);

/** Connection storage, sealing and the LayerMap — everything but OAuth. */
const ConnectionsLive = Layer.mergeAll(
  OrganizationConnections.layerStore,
  OrganizationConnections.oauthConnections,
).pipe(
  Layer.provideMerge(OrganizationConnections.OrganizationConnections.layer),
  Layer.provideMerge(ConnectionRecords.layerMemory),
  Layer.provideMerge(DomainClaims.layerMemory),
  Layer.provideMerge(SqlTransaction.layerNoop),
  Layer.provideMerge(StubDirectoryLive),
  Layer.provideMerge(EncryptionLive),
  Layer.provideMerge(
    Layer.mergeAll(Users.layer.pipe(Layer.provide(Persistence.memory)), Mailer.layerMemory),
  ),
  Layer.provideMerge(TestAuth.memoryFoundation),
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
  it.effect("the client secret is stored sealed and never shown back", () =>
    Effect.gen(function* () {
      const store = yield* OrganizationConnections.OrganizationConnectionStore;
      const records = yield* ConnectionRecords.ConnectionRecords;
      const view = yield* store.create(actor, oidcInput("org-1"));
      assert.isTrue(view.hasClientSecret);
      assert.strictEqual(view.providerId, `org:org-1:${view.id}`);
      const stored = yield* records.findById("org-1", view.id);
      assert.isTrue(Option.isSome(stored));
      // That it is an envelope at rest, bound to its row, is `runSealedColumnTests`' (ConnectionRecords.test.ts).
      assert.isTrue(Option.isSome(stored) && Option.isSome(stored.value.clientSecret));
      assert.notProperty(view, "clientSecret");
    }).pipe(Effect.provide(ConnectionsLive)),
  );

  it.effect(
    "a host NAME that merely starts like an IPv6 prefix is accepted; real IPv6 private literals are not",
    () =>
      Effect.gen(function* () {
        const store = yield* OrganizationConnections.OrganizationConnectionStore;
        const outcome = (url: string) =>
          store
            .create(actor, oidcInput("org-1", { discoveryUrl: url, emailDomains: [] }))
            .pipe(
              Effect.match({ onFailure: (failure) => failure._tag, onSuccess: () => "created" }),
            );
        // Regression: `host.startsWith("fc" | "fd" | "fe80")` refused these legitimate names.
        assert.strictEqual(
          yield* outcome("https://fcm.acme.example/.well-known/openid-configuration"),
          "created",
        );
        assert.strictEqual(
          yield* outcome("https://fdic.acme.example/.well-known/openid-configuration"),
          "created",
        );
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
        store.create(actor, oidcInput("org-1", overrides)).pipe(
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
        actor,
        oidcInput("org-1", { emailDomains: [" Acme.Example ", "acme.example"] }),
      );
      assert.deepStrictEqual(first.emailDomains, ["acme.example"]);
      const clash = yield* store
        .create(actor, oidcInput("org-2", { emailDomains: ["acme.example"] }))
        .pipe(Effect.flip);
      assert.strictEqual(clash._tag, "ConnectionDomainTaken");
    }).pipe(Effect.provide(ConnectionsLive)),
  );

  it.effect("discover routes by organization id, then by email domain", () =>
    Effect.gen(function* () {
      const store = yield* OrganizationConnections.OrganizationConnectionStore;
      const view = yield* store.create(actor, oidcInput("org-1"));
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
        const view = yield* store.create(actor, oidcInput("org-1"));
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
        yield* store.update(actor, "org-1", view.id, { clientId: "client-2" });
        const edited = Option.getOrThrow(yield* resolver.find(view.providerId));
        assert.strictEqual(edited.config.clientId, "client-2");
        assert.notStrictEqual(edited.revision, Option.getOrThrow(found).revision);
        // Removing it makes the id unknown again.
        yield* store.remove(actor, "org-1", view.id);
        assert.isTrue(Option.isNone(yield* resolver.find(view.providerId)));
      }).pipe(Effect.provide(ConnectionsLive)),
  );

  it.effect("static ids, other organizations' ids and malformed ids resolve to nothing", () =>
    Effect.gen(function* () {
      const store = yield* OrganizationConnections.OrganizationConnectionStore;
      const resolver = Option.getOrThrow(yield* OAuthConnections.OAuthConnectionResolver);
      const view = yield* store.create(actor, oidcInput("org-1"));
      assert.isTrue(Option.isNone(yield* resolver.find("google")));
      assert.isTrue(Option.isNone(yield* resolver.find("org:org-1")));
      assert.isTrue(Option.isNone(yield* resolver.find(`org:org-2:${view.id}`)));
      assert.isTrue(Option.isNone(yield* resolver.find(`org:org-1:no-such-connection`)));
    }).pipe(Effect.provide(ConnectionsLive)),
  );

  it.effect("a connection whose secret no longer decrypts is dropped alone", () =>
    Effect.gen(function* () {
      const store = yield* OrganizationConnections.OrganizationConnectionStore;
      const envelopes = yield* ConnectionRecords.MemoryEnvelopes;
      const resolver = Option.getOrThrow(yield* OAuthConnections.OAuthConnectionResolver);
      const good = yield* store.create(actor, oidcInput("org-1", { emailDomains: [] }));
      const bad = yield* store.create(actor, oidcInput("org-1", { emailDomains: ["bad.example"] }));
      yield* envelopes.plant(bad.id, "not-an-envelope");
      yield* OrganizationConnections.OrganizationConnections.invalidate("org-1");
      assert.isTrue(Option.isSome(yield* resolver.find(good.providerId)));
      assert.isTrue(Option.isNone(yield* resolver.find(bad.providerId)));
    }).pipe(Effect.provide(ConnectionsLive)),
  );
});

// ---- the store against the real Directory (BEH-EA-235, plan 04 phase 5) -------------------------------

const RealLive = Layer.mergeAll(
  OrganizationConnections.layerStore,
  OrganizationConnections.connectionsOnOrganizationDelete,
).pipe(
  Layer.provideMerge(OrganizationConnections.OrganizationConnections.layer),
  Layer.provideMerge(ConnectionRecords.layerMemory),
  Layer.provideMerge(DomainClaims.layerMemory),
  Layer.provideMerge(OrganizationSystem.layer.pipe(Layer.provide(Organization.config({})))),
  Layer.provideMerge(OrganizationMemory.layer),
  Layer.provideMerge(EncryptionLive),
  Layer.provideMerge(
    Layer.mergeAll(Users.layer.pipe(Layer.provide(Persistence.memory)), Mailer.layerMemory),
  ),
  Layer.provideMerge(TestAuth.memoryFoundation),
  Layer.provideMerge(SqlTransaction.layerNoop),
  Layer.provideMerge(OrganizationHooks.OrganizationHooksLive),
  Layer.provideMerge(NodeCrypto.layer),
);

describe("connections belong to an active organization, and go with it (BEH-EA-235)", () => {
  it.effect("create and update refuse an unknown or suspended organization", () =>
    Effect.gen(function* () {
      const store = yield* OrganizationConnections.OrganizationConnectionStore;
      const directory = yield* OrganizationDirectory.OrganizationDirectory;
      const unknown = yield* store.create(actor, oidcInput("no-such-org")).pipe(Effect.flip);
      assert.strictEqual(unknown._tag, "InvalidConnection");
      const org = yield* directory.create(actor, {
        owner: Users.UserId("o"),
        name: "A",
        slug: "a",
      });
      const view = yield* store.create(actor, oidcInput(org.id));
      yield* directory.suspend(OrganizationActor.platformAdmin(Users.UserId("admin")), {
        organizationId: org.id,
      });
      const suspended = yield* store
        .update(actor, org.id, view.id, { clientId: "client-2" })
        .pipe(Effect.flip);
      assert.strictEqual(suspended._tag, "InvalidConnection");
      const second = yield* store.create(actor, oidcInput(org.id)).pipe(Effect.flip);
      assert.strictEqual(second._tag, "InvalidConnection");
    }).pipe(Effect.provide(RealLive)),
  );

  it.effect("each write is published with the acting user, identifiers only", () =>
    Effect.gen(function* () {
      const store = yield* OrganizationConnections.OrganizationConnectionStore;
      const directory = yield* OrganizationDirectory.OrganizationDirectory;
      const auditLog = yield* AuditLog.AuditLog;
      const org = yield* directory.create(actor, {
        owner: Users.UserId("o"),
        name: "A",
        slug: "a",
      });
      const admin = OrganizationActor.platformAdmin(Users.UserId("admin-1"));
      const view = yield* store.create(admin, oidcInput(org.id));
      yield* store.update(admin, org.id, view.id, { clientId: "client-2" });
      yield* store.remove(actor, org.id, view.id);
      const created = yield* auditLog.list({ eventTag: "auth.organization.connectionCreated" });
      assert.strictEqual(created.length, 1);
      assert.deepStrictEqual(created[0]?.actorUserId, Option.some("admin-1"));
      const updated = yield* auditLog.list({ eventTag: "auth.organization.connectionUpdated" });
      assert.strictEqual(updated.length, 1);
      assert.deepStrictEqual(updated[0]?.actorUserId, Option.some("admin-1"));
      const deleted = yield* auditLog.list({ eventTag: "auth.organization.connectionDeleted" });
      assert.deepStrictEqual(deleted[0]?.actorUserId, Option.none());
    }).pipe(Effect.provide(RealLive)),
  );

  it.effect("deleting an organization removes its connections and frees their domains", () =>
    Effect.gen(function* () {
      const store = yield* OrganizationConnections.OrganizationConnectionStore;
      const directory = yield* OrganizationDirectory.OrganizationDirectory;
      const records = yield* ConnectionRecords.ConnectionRecords;
      const first = yield* directory.create(actor, {
        owner: Users.UserId("o1"),
        name: "A",
        slug: "a",
      });
      const second = yield* directory.create(actor, {
        owner: Users.UserId("o2"),
        name: "B",
        slug: "b",
      });
      yield* store.create(actor, oidcInput(first.id));
      yield* store.create(actor, oidcInput(second.id, { emailDomains: ["other.example"] }));
      yield* directory.delete(actor, { organizationId: first.id });
      assert.strictEqual((yield* records.listByOrganization(first.id)).length, 0);
      assert.isTrue(Option.isNone(yield* records.findByEmailDomain(grant, "acme.example")));
      assert.strictEqual((yield* records.listByOrganization(second.id)).length, 1);
    }).pipe(Effect.provide(RealLive)),
  );
});

// ---- end to end: a stored connection completes a real OAuth callback ------------------

const CoreLive = Layer.mergeAll(
  Users.layer.pipe(Layer.provide(Persistence.memory)),
  Accounts.layer.pipe(Layer.provide(Persistence.memory)),
  Sessions.layer.pipe(Layer.provide(Persistence.memory)),
  Verification.layer.pipe(Layer.provide(Persistence.memory)),
).pipe(Layer.provideMerge(TestAuth.memoryFoundation));

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
      const view = yield* store.create(actor, {
        ...oauth2Input("org-1"),
        emailDomains: ["acme.example"],
      });
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
