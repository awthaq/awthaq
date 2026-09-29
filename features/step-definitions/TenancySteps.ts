// P20a: step definitions for 28-tenancy.feature (BEH-EA-230..237). Every assertion reads the
// state the real services and repositories produced: the raw `"tenantId"` column, the response
// a router middleware wrote, the typed refusal an organization operation returned.
import { Accounts, AuditLog, Sessions, Users, Verification } from "@awthaq/core";
import { Encryption, Tenant } from "@awthaq/ports";
import { ConnectionRecords, Organization, OrganizationConnections, OrganizationRecords } from "@awthaq/organization";
import { AdminTenants } from "@awthaq/admin";
import { OAuthConnections } from "@awthaq/oauth";
import { Models, Repositories, TenantScope } from "@awthaq/sql";
import { defineSteps } from "@effect-cucumber/vitest";
import { makeResourceId, makeSubjectId, RelationshipResolver } from "@qadi/core";
import assert from "node:assert/strict";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  callerOf,
  identity,
  OAUTH_BASE_URL,
  organization,
  outcomeTag,
  PLATFORM_ADMIN,
  staticProvider,
  tenantLimits,
  TenantConfig,
  World,
  type GatewayVariant,
} from "./TenancyWorld.ts";

/** Reads a top-level property of a decoded JSON body without asserting its shape. */
const field = (body: unknown, key: string): unknown =>
  typeof body === "object" && body !== null ? Reflect.get(body, key) : undefined;

/** Narrows the tag a step names to the audit-event tags this feature reads. */
const auditTag = (tag: string) => {
  switch (tag) {
    case "auth.admin.organizationSuspended":
    case "auth.admin.organizationUnsuspended":
      return tag;
    default:
      return assert.fail(`this feature does not read audit events tagged "${tag}"`);
  }
};

const M = Models.makeModels("sqlite");

/** The tables `BEH-EA-231` names; the only identifiers ever spliced into a query. */
const STAMPED_TABLES = [
  "users",
  "accounts",
  "sessions",
  "verification_tokens",
  "verification_reservations",
  "auth_audit_log",
];

let sequence = 0;
const fresh = (label: string) => `${label}-${++sequence}`;

const createUser = Effect.fn("features.tenancy.createUser")(function* (
  email: string,
  tenant: Option.Option<string>,
) {
  const world = yield* World;
  const record = yield* identity(
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const create = users.create({ identity: { _tag: "Email", email }, name: email });
      // An explicit tenant wins over the ambient one `identity` already applies.
      return yield* Option.match(tenant, {
        onNone: () => create,
        onSome: (id) => Tenant.withTenant(id)(create),
      });
    }),
  );
  yield* Ref.update(world.userIds, (ids) => [...ids, record.id]);
  yield* Ref.set(world.userTenant, record.tenantId);
  return record;
});

const lastUserId = Effect.fn("features.tenancy.lastUserId")(function* () {
  const { userIds } = yield* World;
  const ids = yield* Ref.get(userIds);
  const last = ids[ids.length - 1];
  assert.ok(last !== undefined, "a step must create a user first");
  return last;
});

const userAt = Effect.fn("features.tenancy.userAt")(function* (index: number) {
  const { userIds } = yield* World;
  const id = (yield* Ref.get(userIds))[index];
  assert.ok(id !== undefined, `no user #${index + 1} has been created`);
  return id;
});

const readTenant = Effect.gen(function* () {
  return yield* Tenant.TenantContext;
});

const storedTenants = Effect.fn("features.tenancy.storedTenants")(function* (table: string) {
  assert.ok(STAMPED_TABLES.includes(table), `"${table}" is not a stamped table`);
  return yield* identity(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql.unsafe<{ readonly tenantId: string | null }>(
        `SELECT "tenantId" FROM ${table}`,
      );
      return rows.map((row) => row.tenantId);
    }),
  );
});

const linkAccount = Effect.fn("features.tenancy.linkAccount")(function* (
  userId: Users.UserId,
  provider: string,
  subject: string,
  tenant: string,
) {
  return yield* identity(
    outcomeTag(
      Tenant.withTenant(tenant)(
        Effect.gen(function* () {
          const accounts = yield* Accounts.Accounts;
          return yield* accounts.link({ userId, providerId: provider, subject, issuer: "" });
        }),
      ),
    ),
  );
});

const organizationNamed = Effect.fn("features.tenancy.organizationNamed")(function* (
  name: string,
) {
  const { organizationIds } = yield* World;
  return yield* organizationIds.get(name);
});

const createRecordOrganization = Effect.fn("features.tenancy.createRecordOrganization")(
  function* (name: string) {
    const { organizationIds } = yield* World;
    const record = yield* organization(
      Effect.gen(function* () {
        const records = yield* OrganizationRecords.OrganizationRecords;
        return yield* records.create({ name, slug: name });
      }),
    );
    yield* organizationIds.set(name, record.id);
    return record.id;
  },
);

const installGateway = (variant: GatewayVariant) =>
  Effect.gen(function* () {
    const { gatewayVariant } = yield* World;
    yield* Ref.set(gatewayVariant, variant);
  });

const serveRequest = Effect.fn("features.tenancy.serveRequest")(function* (
  path: string,
  tenantHeader: string | undefined,
) {
  const world = yield* World;
  const response = yield* Effect.promise(async () => {
    const reply = await world.serve(
      new Request(`http://localhost${path}`, {
        method: "GET",
        headers: tenantHeader === undefined ? {} : { "x-tenant": tenantHeader },
      }),
    );
    return { status: reply.status, body: await reply.json() };
  });
  yield* world.responses.set("last", response);
});

const lastResponse = Effect.fn("features.tenancy.lastResponse")(function* () {
  const { responses } = yield* World;
  return yield* responses.get("last");
});

const registerCaller = Effect.fn("features.tenancy.registerCaller")(function* (name: string) {
  const { people } = yield* World;
  const caller = callerOf(name);
  yield* people.set(name, caller);
  return caller;
});

const ownsOrganization = Effect.fn("features.tenancy.ownsOrganization")(function* (
  name: string,
  slug: string,
) {
  const { organizationIds } = yield* World;
  const caller = yield* registerCaller(name);
  const record = yield* organization(
    Effect.gen(function* () {
      const plugin = yield* Organization.Organization;
      return yield* plugin.create({ caller, name: slug, slug });
    }),
  );
  yield* organizationIds.set(slug, record.id);
});

const callerNamed = Effect.fn("features.tenancy.callerNamed")(function* (name: string) {
  const { people } = yield* World;
  yield* people.use(name);
  return yield* people.get(name);
});

const storeConnection = Effect.fn("features.tenancy.storeConnection")(function* (
  organizationName: string,
  secret: string,
) {
  const world = yield* World;
  const view = yield* Effect.provide(
    Effect.gen(function* () {
      const store = yield* OrganizationConnections.OrganizationConnectionStore;
      return yield* store.create({
        organizationId: organizationName,
        kind: "oauth2",
        name: "Acme OAuth",
        authorizationEndpoint: "https://acme.example.com/authorize",
        tokenEndpoint: "https://acme.example.com/token",
        userinfoEndpoint: "https://acme.example.com/userinfo",
        clientId: "acme-client-id",
        clientSecret: Redacted.make(secret),
        scopes: ["read"],
      });
    }),
    world.connections,
  ).pipe(Effect.orDie);
  yield* world.connectionIds.set(organizationName, {
    organizationId: organizationName,
    connectionId: view.id,
    providerId: view.providerId,
    viewKeys: Object.keys(view),
    hasClientSecret: view.hasClientSecret,
  });
});

const composeOAuth = Effect.fn("features.tenancy.composeOAuth")(function* (options: {
  readonly staticIds: ReadonlyArray<string>;
  readonly resolver: "none" | "stored" | "counting";
}) {
  const world = yield* World;
  const inner = Context.get(world.connections, OAuthConnections.OAuthConnectionResolver);
  const consulted = Ref.makeUnsafe<ReadonlyArray<string>>([]);
  const resolver =
    options.resolver === "none"
      ? undefined
      : Option.getOrThrowWith(inner, () => new Error("the connection stack installs a resolver"));
  const observed: OAuthConnections.OAuthConnectionResolverShape | undefined =
    options.resolver === "counting" && resolver !== undefined
      ? {
          find: (providerId) =>
            Ref.update(consulted, (seen) => [...seen, providerId]).pipe(
              Effect.andThen(resolver.find(providerId)),
            ),
        }
      : resolver;
  const oauth = yield* world.buildOAuth(options.staticIds.map(staticProvider), observed);
  yield* Ref.set(world.oauthCompositions, Option.some({ oauth, consulted }));
});

const authorize = Effect.fn("features.tenancy.authorize")(function* (providerId: string) {
  const world = yield* World;
  const composition = Option.getOrThrowWith(
    yield* Ref.get(world.oauthCompositions),
    () => new Error("a Given must compose OAuth first"),
  );
  const outcome = yield* composition.oauth
    .authorize(providerId, { callbackURL: undefined, link: undefined })
    .pipe(
      Effect.match({
        onFailure: (failure) => ({ tag: failure._tag, location: undefined }),
        onSuccess: (started) => ({ tag: "success", location: started.location }),
      }),
      Effect.orDie,
    );
  yield* world.outcomes.set("authorize", outcome.tag);
  if (outcome.location !== undefined) yield* world.redirects.set("last", outcome.location);
});

const addMemberTo = (organizationId: string, userId: string) =>
  Effect.gen(function* () {
    const plugin = yield* Organization.Organization;
    return yield* plugin.addMember({
      organizationId,
      userId: Users.UserId(userId),
      role: ["member"],
    });
  });

const suspend = Effect.fn("features.tenancy.suspend")(function* (
  adminName: string,
  organizationName: string,
) {
  const admin = yield* callerNamed(adminName);
  const id = yield* organizationNamed(organizationName);
  const record = yield* organization(
    Effect.gen(function* () {
      const tenants = yield* AdminTenants.AdminTenants;
      return yield* tenants.suspendOrganization(admin, id, {});
    }),
  );
  return Option.match(record.suspendedAt, { onNone: () => "none", onSome: DateTime.formatIso });
});

export const tenancySteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- BEH-EA-230: the ambient tenant ----

  Given("no tenant is provided", function* () {
    const { ambient } = yield* World;
    yield* Ref.set(ambient, Option.none());
  });

  Given("the ambient tenant is {string}", function* (tenant: string) {
    const { ambient } = yield* World;
    yield* Ref.set(ambient, Option.some(tenant));
  });

  Given("no organization exists", function* () {
    // The stamping composition carries no Organization plugin at all: there is no table a
    // tenant id could be resolved against, which is the point — core only stores the string.
    const tables = yield* identity(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.unsafe<{ readonly name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'organization%'",
        );
      }),
    );
    assert.deepEqual(tables, []);
  });

  When("the ambient tenant is read", function* () {
    const { readOutside } = yield* World;
    yield* Ref.set(readOutside, Option.some(yield* readTenant));
  });

  Then("the ambient tenant is none", function* () {
    const { readOutside } = yield* World;
    const read = Option.getOrThrowWith(yield* Ref.get(readOutside), () => new Error("nothing was read"));
    assert.ok(Option.isNone(read));
  });

  When('the ambient tenant is read inside "withTenant" for {string}', function* (tenant: string) {
    const world = yield* World;
    yield* Ref.set(world.readInside, Option.some(yield* Tenant.withTenant(tenant)(readTenant)));
    yield* Ref.set(world.readAfter, Option.some(yield* readTenant));
  });

  When(
    'the ambient tenant is read inside "withTenant" for {string} and then inside "withoutTenant"',
    function* (tenant: string) {
      const world = yield* World;
      yield* Ref.set(
        world.readInside,
        Option.some(yield* Tenant.withTenant(tenant)(Tenant.withoutTenant(readTenant))),
      );
    },
  );

  Then("the ambient tenant read inside is {string}", function* (tenant: string) {
    const { readInside } = yield* World;
    const read = Option.getOrThrowWith(yield* Ref.get(readInside), () => new Error("nothing was read"));
    assert.deepEqual(read, Option.some(tenant));
  });

  Then("the ambient tenant read inside is none", function* () {
    const { readInside } = yield* World;
    const read = Option.getOrThrowWith(yield* Ref.get(readInside), () => new Error("nothing was read"));
    assert.ok(Option.isNone(read));
  });

  Then("the ambient tenant read afterwards is none", function* () {
    const { readAfter } = yield* World;
    const read = Option.getOrThrowWith(yield* Ref.get(readAfter), () => new Error("nothing was read"));
    assert.ok(Option.isNone(read));
  });

  When("a user {string} is created", function* (email: string) {
    yield* createUser(email, Option.none());
  });

  When("a user {string} is created under the tenant {string}", function* (email: string, tenant: string) {
    yield* createUser(email, Option.some(tenant));
  });

  Then("that user has no tenant", function* () {
    const { userTenant } = yield* World;
    assert.ok(Option.isNone(yield* Ref.get(userTenant)));
  });

  Then("that user's tenant is {string}", function* (tenant: string) {
    const { userTenant } = yield* World;
    assert.deepEqual(yield* Ref.get(userTenant), Option.some(tenant));
  });

  // ---- BEH-EA-231: stamping ----

  When("one row is inserted into {string}", function* (table: string) {
    const world = yield* World;
    const label = fresh(table);
    switch (table) {
      case "users":
        yield* createUser(`${label}@example.com`, Option.none());
        break;
      case "accounts": {
        const user = yield* createUser(`${label}@example.com`, Option.none());
        yield* identity(
          Effect.gen(function* () {
              const accounts = yield* Accounts.Accounts;
              return yield* accounts.link({ userId: user.id, providerId: "github", subject: label, issuer: "" });
            }),
        );
        break;
      }
      // Issuing a session publishes `auth.session.issued`; `AuthEvents.publish` writes the durable audit row inline.
      case "auth_audit_log":
      case "sessions": {
        const user = yield* createUser(`${label}@example.com`, Option.none());
        yield* identity(
          Effect.gen(function* () {
              const sessions = yield* Sessions.Sessions;
              return yield* sessions.issue({ userId: user.id });
            }),
        );
        break;
      }
      case "verification_tokens":
        yield* identity(
          Effect.gen(function* () {
              const verification = yield* Verification.Verification;
              return yield* verification.issue({ identifier: `verify-email:${label}`, ttl: Duration.hours(1) });
            }),
        );
        break;
      case "verification_reservations":
        yield* identity(
          Effect.gen(function* () {
              const verification = yield* Verification.Verification;
              return yield* verification.reserve({ identifier: `signup:${label}`, ttl: Duration.hours(1) });
            }),
        );
        break;
      default:
        assert.fail(`"${table}" is not a table BEH-EA-231 stamps`);
    }
    yield* Ref.set(world.storedTenants, yield* storedTenants(table));
  });

  Then('the stored "tenantId" of that row is {string}', function* (tenant: string) {
    const { storedTenants: cell } = yield* World;
    const stored = yield* Ref.get(cell);
    assert.ok(stored.length > 0, "the insert must have left a row to inspect");
    assert.deepEqual(new Set(stored), new Set([tenant]));
  });

  Then('the stored "tenantId" of that row is NULL', function* () {
    const { storedTenants: cell } = yield* World;
    const stored = yield* Ref.get(cell);
    assert.ok(stored.length > 0, "the insert must have left a row to inspect");
    assert.deepEqual(new Set(stored), new Set([null]));
  });

  When(
    "a user {string} is inserted with the explicit tenant {string}",
    function* (email: string, tenant: string) {
      const world = yield* World;
      const row = yield* identity(
        Effect.gen(function* () {
            const users = yield* Repositories.UsersRepository;
            return yield* users.insert(
              yield* M.User.insert.makeEffect({ email, name: email, tenantId: tenant }),
            );
          }),
      );
      yield* Ref.set(world.userTenant, Option.fromNullishOr(row.tenantId));
    },
  );

  When("that user's profile is updated under the tenant {string}", function* (tenant: string) {
    const world = yield* World;
    const id = yield* lastUserId();
    const reread = yield* identity(
      Tenant.withTenant(tenant)(
        Effect.gen(function* () {
          const users = yield* Users.Users;
          yield* users.updateProfile(id, { name: "Renamed" });
          return yield* users.findById(id);
        }),
      ),
    );
    yield* Ref.set(world.userTenant, reread.tenantId);
  });

  When(
    'a create payload for "users" naming the tenant {string} is decoded',
    function* (tenant: string) {
      const { decodedCreate } = yield* World;
      const decoded = Schema.decodeUnknownSync(M.User.jsonCreate)({
        email: "payload@example.com",
        phone: null,
        name: "Payload",
        metadata: null,
        image: null,
        status: "active",
        statusReason: null,
        emailVerified: false,
        phoneVerified: false,
        suspendedUntil: null,
        tenantId: tenant,
      });
      yield* Ref.set(decodedCreate, Option.some(decoded));
    },
  );

  Then('the decoded payload carries no "tenantId"', function* () {
    const { decodedCreate } = yield* World;
    const decoded = Option.getOrThrowWith(yield* Ref.get(decodedCreate), () => new Error("nothing was decoded"));
    assert.equal(Object.hasOwn(decoded, "tenantId"), false);
    // Non-vacuity: the payload did decode, so the field was dropped rather than the decode skipped.
    assert.equal(Reflect.get(decoded, "email"), "payload@example.com");
  });

  Then('the "users" update variant has no "tenantId" field', function* () {
    // A pure schema-shape assertion: the model is static data, nothing to run.
    yield* Effect.void;
    assert.equal(Object.hasOwn(M.User.update.fields, "tenantId"), false);
    assert.equal(Object.hasOwn(M.User.jsonUpdate.fields, "tenantId"), false);
    // Non-vacuity: the same variants do carry the fields that may change.
    assert.equal(Object.hasOwn(M.User.update.fields, "name"), true);
    // The insert variant is the only one that names a tenant: stamped by the repository, never by a caller's body.
    assert.equal(Object.hasOwn(M.User.insert.fields, "tenantId"), true);
  });

  When("a session is issued for that user", function* () {
    const world = yield* World;
    const userId = yield* lastUserId();
    const issued = yield* identity(
      Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          return yield* sessions.issue({ userId });
        }),
    );
    yield* Ref.set(world.sessionTenant, issued.session.tenantId);
    yield* Ref.set(world.sessionToken, Option.some(issued.token));
  });

  When("a session is issued for that user under the tenant {string}", function* (tenant: string) {
    const world = yield* World;
    const userId = yield* lastUserId();
    const issued = yield* identity(
      Tenant.withTenant(tenant)(
        Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          return yield* sessions.issue({ userId });
        }),
      ),
    );
    yield* Ref.set(world.sessionTenant, issued.session.tenantId);
    yield* Ref.set(world.sessionToken, Option.some(issued.token));
  });

  Then("the session view has no tenant", function* () {
    const { sessionTenant } = yield* World;
    assert.ok(Option.isNone(yield* Ref.get(sessionTenant)));
  });

  Then("the session view's tenant is {string}", function* (tenant: string) {
    const { sessionTenant } = yield* World;
    assert.deepEqual(yield* Ref.get(sessionTenant), Option.some(tenant));
  });

  // ---- BEH-EA-232: the global identity directory ----

  When("{string} is looked up by email under the tenant {string}", function* (email: string, tenant: string) {
    const { outcomes } = yield* World;
    const found = yield* identity(
      Tenant.withTenant(tenant)(
        Effect.gen(function* () {
          const users = yield* Users.Users;
          return yield* users.findByEmail(email);
        }),
      ),
    );
    yield* outcomes.set("user-lookup", Option.match(found, { onNone: () => "none", onSome: (user) => user.id }));
  });

  Then("the lookup finds that user", function* () {
    const { outcomes } = yield* World;
    assert.equal(yield* outcomes.get("user-lookup"), yield* lastUserId());
  });

  Given(
    "that user is linked to the provider {string} with the subject {string} under the tenant {string}",
    function* (provider: string, subject: string, tenant: string) {
      assert.equal(yield* linkAccount(yield* lastUserId(), provider, subject, tenant), "success");
    },
  );

  Given(
    "the first user is linked to the provider {string} with the subject {string} under the tenant {string}",
    function* (provider: string, subject: string, tenant: string) {
      assert.equal(yield* linkAccount(yield* userAt(0), provider, subject, tenant), "success");
    },
  );

  When(
    "the second user is linked to the provider {string} with the subject {string} under the tenant {string}",
    function* (provider: string, subject: string, tenant: string) {
      const { outcomes } = yield* World;
      yield* outcomes.set("link", yield* linkAccount(yield* userAt(1), provider, subject, tenant));
    },
  );

  Then("the link is refused because the account is already linked", function* () {
    const { outcomes } = yield* World;
    assert.equal(yield* outcomes.get("link"), "AccountAlreadyLinked");
  });

  When(
    "the provider {string} subject {string} is looked up under the tenant {string}",
    function* (provider: string, subject: string, tenant: string) {
      const { outcomes } = yield* World;
      const found = yield* identity(
        Tenant.withTenant(tenant)(
          Effect.gen(function* () {
            const accounts = yield* Accounts.Accounts;
            return yield* accounts.findByProviderSubject(provider, subject, "");
          }),
        ),
      );
      yield* outcomes.set("account-lookup", Option.match(found, { onNone: () => "none", onSome: (account) => account.userId }));
    },
  );

  Then("the lookup finds that account", function* () {
    const { outcomes } = yield* World;
    assert.equal(yield* outcomes.get("account-lookup"), yield* lastUserId());
  });

  When("a user {string} is registered under the tenant {string}", function* (email: string, tenant: string) {
    const { outcomes } = yield* World;
    const tag = yield* identity(
      outcomeTag(
        Tenant.withTenant(tenant)(
          Effect.gen(function* () {
            const users = yield* Users.Users;
            return yield* users.create({ identity: { _tag: "Email", email }, name: email });
          }),
        ),
      ),
    );
    yield* outcomes.set("registration", tag);
  });

  Then("the registration is refused because the email already exists", function* () {
    const { outcomes } = yield* World;
    assert.equal(yield* outcomes.get("registration"), "Users/EmailAlreadyExists");
  });

  When("that session is verified under the tenant {string}", function* (tenant: string) {
    const world = yield* World;
    const token = Option.getOrThrowWith(yield* Ref.get(world.sessionToken), () => new Error("no session was issued"));
    const verified = yield* identity(
      Tenant.withTenant(tenant)(
        Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          return yield* sessions.verify(token);
        }),
      ),
    );
    yield* Ref.set(world.sessionTenant, verified.session.tenantId);
  });

  // ---- BEH-EA-233: row-level security (the Postgres half is pruned in the feature) ----

  When("row-level security is enabled twice", function* () {
    const { outcomes } = yield* World;
    const exits = yield* Effect.provide(
      Effect.gen(function* () {
        const first = yield* Effect.exit(TenantScope.enableRls());
        const second = yield* Effect.exit(TenantScope.enableRls());
        return [first, second] as const;
      }),
      (yield* World).identity,
    );
    yield* outcomes.set("rls", exits.every(Exit.isSuccess) ? "ok" : "error");
  });

  Then("no error is raised", function* () {
    const { outcomes } = yield* World;
    assert.equal(yield* outcomes.get("rls"), "ok");
  });

  Then("{string} is still found by email", function* (email: string) {
    const found = yield* identity(
      Effect.gen(function* () {
        const users = yield* Users.Users;
        return yield* users.findByEmail(email);
      }),
    );
    assert.ok(Option.isSome(found));
  });

  When(
    'a user {string} is created inside a "TenantScope" for {string}',
    function* (email: string, tenant: string) {
      const world = yield* World;
      const record = yield* identity(
        TenantScope.withTenant(tenant)(
          Effect.gen(function* () {
            const users = yield* Users.Users;
            return yield* users.create({ identity: { _tag: "Email", email }, name: email });
          }),
        ),
      );
      yield* Ref.update(world.userIds, (ids) => [...ids, record.id]);
      yield* Ref.set(world.userTenant, record.tenantId);
    },
  );

  // ---- BEH-EA-234/236: the tenant middleware ----

  Given("the organization {string} exists", function* (name: string) {
    yield* createRecordOrganization(name);
  });

  Given("the organization {string} exists with a membership limit of {int}", function* (name: string, limit: number) {
    tenantLimits.set(yield* createRecordOrganization(name), limit);
  });

  Given("the organization {string} is suspended", function* (name: string) {
    const id = yield* organizationNamed(name);
    yield* organization(
      Effect.gen(function* () {
        const records = yield* OrganizationRecords.OrganizationRecords;
        return yield* records.setSuspended(id, Option.some(yield* DateTime.now));
      }),
    );
  });

  Given("the tenant middleware is installed", function* () {
    yield* installGateway("plain");
  });

  Given("no tenant middleware is installed", function* () {
    yield* installGateway("none");
  });

  Given("the tenant middleware with row-level security is installed", function* () {
    yield* installGateway("rls");
  });

  Given("the tenant middleware with per-tenant configuration is installed", function* () {
    yield* installGateway("config");
  });

  When("a request naming the organization {string} is served", function* (name: string) {
    yield* serveRequest("/whoami", yield* organizationNamed(name));
  });

  When("a request naming the organization id {string} is served", function* (id: string) {
    yield* serveRequest("/whoami", id);
  });

  When("a request naming no organization is served", function* () {
    yield* serveRequest("/whoami", undefined);
  });

  When("a request naming the organization {string} reads the limit in force", function* (name: string) {
    yield* serveRequest("/limit", yield* organizationNamed(name));
  });

  When("a request naming no organization reads the limit in force", function* () {
    yield* serveRequest("/limit", undefined);
  });

  Then("the handler saw the tenant {string}", function* (name: string) {
    const { body } = yield* lastResponse();
    assert.equal(field(body, "tenant"), yield* organizationNamed(name));
  });

  Then("the handler saw no tenant", function* () {
    const { body } = yield* lastResponse();
    assert.equal(field(body, "tenant"), null);
  });

  Then("the response status is {int}", function* (status: number) {
    assert.equal((yield* lastResponse()).status, status);
  });

  Then("the response body names {string}", function* (tag: string) {
    assert.equal(field((yield* lastResponse()).body, "_tag"), tag);
  });

  Then("the handler never ran", function* () {
    const { gatewayProbe } = yield* World;
    assert.equal(yield* Ref.get(gatewayProbe.handlerRuns), 0);
  });

  Then("the resolver was called {int} time", function* (calls: number) {
    const { gatewayProbe } = yield* World;
    assert.equal(yield* Ref.get(gatewayProbe.resolverCalls), calls);
  });

  Then(
    "the limit in force is {int} and the configuration is applied for {string}",
    function* (limit: number, name: string) {
      const { body } = yield* lastResponse();
      assert.equal(field(body, "membershipLimit"), limit);
      assert.equal(field(body, "appliedTenant"), yield* organizationNamed(name));
    },
  );

  Then(
    "the limit in force is {int}, the configuration reference's default, and no configuration is applied for any tenant",
    function* (limit: number) {
      const { body } = yield* lastResponse();
      assert.equal(field(body, "membershipLimit"), limit);
      assert.equal(field(body, "appliedTenant"), null);
    },
  );

  // ---- BEH-EA-235: organization OAuth connections ----

  Given("the organization {string} has stored an OAuth2 connection", function* (name: string) {
    yield* storeConnection(name, "connection-secret");
  });

  Given(
    "the organization {string} has stored an OAuth2 connection with the client secret {string}",
    function* (name: string, secret: string) {
      yield* storeConnection(name, secret);
    },
  );

  Then("the connection's provider id is namespaced by the organization and the connection", function* () {
    const { connectionIds } = yield* World;
    const stored = yield* connectionIds.get(yield* connectionIds.current);
    assert.equal(stored.providerId, `org:${stored.organizationId}:${stored.connectionId}`);
  });

  Given("OAuth is composed with the stored connections and no static provider", function* () {
    yield* composeOAuth({ staticIds: [], resolver: "stored" });
  });

  Given(
    "OAuth is composed with a static provider {string} and a counting connection resolver",
    function* (id: string) {
      yield* composeOAuth({ staticIds: [id], resolver: "counting" });
    },
  );

  Given(
    "OAuth is composed with a static provider {string} and no connection resolver",
    function* (id: string) {
      yield* composeOAuth({ staticIds: [id], resolver: "none" });
    },
  );

  When("the connection's provider is authorized", function* () {
    const { connectionIds } = yield* World;
    yield* authorize((yield* connectionIds.get(yield* connectionIds.current)).providerId);
  });

  When("the provider {string} is authorized", function* (providerId: string) {
    yield* authorize(providerId);
  });

  When("another organization's id for the connection is authorized", function* () {
    const { connectionIds } = yield* World;
    const stored = yield* connectionIds.get(yield* connectionIds.current);
    yield* authorize(`org:other-org:${stored.connectionId}`);
  });

  When("an unknown connection id of the organization {string} is authorized", function* (name: string) {
    yield* authorize(`org:${name}:no-such-connection`);
  });

  Then("the redirect names the connection's own callback path", function* () {
    const world = yield* World;
    const stored = yield* world.connectionIds.get(yield* world.connectionIds.current);
    const location = yield* world.redirects.get("last");
    assert.equal(
      new URL(location).searchParams.get("redirect_uri"),
      `${OAUTH_BASE_URL}/oauth/${stored.providerId}/callback`,
    );
  });

  Then("the redirect names the client id of the static provider", function* () {
    const { redirects } = yield* World;
    assert.equal(new URL(yield* redirects.get("last")).searchParams.get("client_id"), "acme-client-id");
  });

  Then("the connection resolver was never consulted", function* () {
    const { oauthCompositions } = yield* World;
    const composition = Option.getOrThrowWith(yield* Ref.get(oauthCompositions), () => new Error("OAuth was not composed"));
    assert.deepEqual(yield* Ref.get(composition.consulted), []);
  });

  Then("the outcome is {string}", function* (tag: string) {
    const { outcomes } = yield* World;
    assert.equal(yield* outcomes.get("authorize"), tag);
  });

  Then(
    "the stored secret is an encryption envelope that does not contain {string}",
    function* (secret: string) {
      const world = yield* World;
      const stored = yield* world.connectionIds.get(yield* world.connectionIds.current);
      const row = yield* Effect.provide(
        Effect.gen(function* () {
          const records = yield* ConnectionRecords.ConnectionRecords;
          return yield* records.findById(stored.organizationId, stored.connectionId);
        }),
        world.connections,
      ).pipe(Effect.orDie);
      assert.ok(Option.isSome(row), "the connection row must exist");
      const envelope = Option.getOrThrowWith(row.value.clientSecret, () => new Error("the secret was not stored"));
      assert.ok(Encryption.looksLikeEnvelope(envelope));
      assert.equal(envelope.includes(secret), false);
    },
  );

  Then("the connection view carries no client secret", function* () {
    const world = yield* World;
    const stored = yield* world.connectionIds.get(yield* world.connectionIds.current);
    assert.equal(stored.hasClientSecret, true);
    assert.equal(stored.viewKeys.includes("clientSecret"), false);
  });

  // ---- BEH-EA-236 (Organization per operation) and BEH-EA-237 (suspension) ----

  Given(
    "a signed-in user {string} who owns the organization {string}",
    function* (name: string, slug: string) {
      yield* ownsOrganization(name, slug);
    },
  );

  Given(
    "a signed-in user {string} who owns the organization {string} and the organization {string}",
    function* (name: string, first: string, second: string) {
      yield* ownsOrganization(name, first);
      yield* ownsOrganization(name, second);
    },
  );

  Given("a signed-in user {string} who owns no organization", function* (name: string) {
    yield* registerCaller(name);
  });

  Given("a platform administrator {string}", function* (name: string) {
    assert.equal(name, PLATFORM_ADMIN, "the composition recognises exactly one platform administrator");
    yield* registerCaller(name);
  });

  Given(
    'the tenant {string} configures a membership limit of {int} and the tenant {string} one of {int}',
    function* (first: string, firstLimit: number, second: string, secondLimit: number) {
      tenantLimits.set(yield* organizationNamed(first), firstLimit);
      tenantLimits.set(yield* organizationNamed(second), secondLimit);
    },
  );

  When(
    `one member is added to {string} and two members are added to {string}, each under its own tenant's configuration`,
    function* (small: string, big: string) {
      const { outcomes } = yield* World;
      const attempt = (name: string, member: string) =>
        Effect.gen(function* () {
          const id = yield* organizationNamed(name);
          return yield* organization(
            outcomeTag(addMemberTo(id, member).pipe(Effect.provide(TenantConfig.get(id)))),
          );
        });
      yield* outcomes.set(`${small}:first`, yield* attempt(small, "m-1"));
      yield* outcomes.set(`${big}:first`, yield* attempt(big, "m-1"));
      yield* outcomes.set(`${big}:second`, yield* attempt(big, "m-2"));
    },
  );

  Then("the addition to {string} is refused with {string}", function* (name: string, tag: string) {
    const { outcomes } = yield* World;
    assert.equal(yield* outcomes.get(`${name}:first`), tag);
  });

  Then(
    "the first addition to {string} succeeds and the second is refused with {string}",
    function* (name: string, tag: string) {
      const { outcomes } = yield* World;
      assert.equal(yield* outcomes.get(`${name}:first`), "success");
      assert.equal(yield* outcomes.get(`${name}:second`), tag);
    },
  );

  When("three members are added in turn with no per-request configuration", function* () {
    const { outcomes, organizationIds } = yield* World;
    const id = yield* organizationIds.get(yield* organizationIds.current);
    for (const member of ["m-1", "m-2", "m-3"]) {
      yield* outcomes.set(member, yield* organization(outcomeTag(addMemberTo(id, member))));
    }
  });

  Then(
    "the first two additions succeed and the third is refused with {string}",
    function* (tag: string) {
      const { outcomes } = yield* World;
      assert.equal(yield* outcomes.get("m-1"), "success");
      assert.equal(yield* outcomes.get("m-2"), "success");
      assert.equal(yield* outcomes.get("m-3"), tag);
    },
  );

  When("{string} suspends the organization {string}", function* (admin: string, name: string) {
    const { suspensions } = yield* World;
    yield* suspensions.set("first", yield* suspend(admin, name));
  });

  Given("{string} has suspended the organization {string}", function* (admin: string, name: string) {
    const { suspensions } = yield* World;
    yield* suspensions.set("first", yield* suspend(admin, name));
  });

  When("{string} suspends the organization {string} twice", function* (admin: string, name: string) {
    const { suspensions } = yield* World;
    yield* suspensions.set("first", yield* suspend(admin, name));
    yield* suspensions.set("second", yield* suspend(admin, name));
  });

  Then("the second suspension reports the first suspension's time", function* () {
    const { suspensions } = yield* World;
    const first = yield* suspensions.get("first");
    assert.notEqual(first, "none");
    assert.equal(yield* suspensions.get("second"), first);
  });

  When("{string} reinstates the organization {string}", function* (adminName: string, name: string) {
    const admin = yield* callerNamed(adminName);
    const id = yield* organizationNamed(name);
    const record = yield* organization(
      Effect.gen(function* () {
        const tenants = yield* AdminTenants.AdminTenants;
        return yield* tenants.unsuspendOrganization(admin, id);
      }),
    );
    assert.ok(Option.isNone(record.suspendedAt));
  });

  Then(
    "{string} reading the organization {string} is refused with {string}",
    function* (who: string, name: string, tag: string) {
      const caller = yield* callerNamed(who);
      const id = yield* organizationNamed(name);
      const outcome = yield* organization(
        Effect.gen(function* () {
          const plugin = yield* Organization.Organization;
          return yield* outcomeTag(plugin.get(caller, id));
        }),
      );
      assert.equal(outcome, tag);
    },
  );

  Then(
    "{string} updating the organization {string} is refused with {string}",
    function* (who: string, name: string, tag: string) {
      const caller = yield* callerNamed(who);
      const id = yield* organizationNamed(name);
      const outcome = yield* organization(
        Effect.gen(function* () {
          const plugin = yield* Organization.Organization;
          return yield* outcomeTag(plugin.update(caller, id, { name: "Renamed" }));
        }),
      );
      assert.equal(outcome, tag);
    },
  );

  Then(
    "{string} reading an organization that does not exist is refused with {string}",
    function* (who: string, tag: string) {
      const caller = yield* callerNamed(who);
      const outcome = yield* organization(
        Effect.gen(function* () {
          const plugin = yield* Organization.Organization;
          return yield* outcomeTag(plugin.get(caller, "no-such-organization"));
        }),
      );
      assert.equal(outcome, tag);
    },
  );

  Then("{string} can read the organization {string}", function* (who: string, name: string) {
    const caller = yield* callerNamed(who);
    const id = yield* organizationNamed(name);
    const record = yield* organization(
      Effect.gen(function* () {
        const plugin = yield* Organization.Organization;
        return yield* plugin.get(caller, id);
      }),
    );
    assert.equal(record.id, id);
  });

  Then(
    "{string} lists exactly the organization {string} flagged as suspended",
    function* (who: string, name: string) {
      const caller = yield* callerNamed(who);
      const id = yield* organizationNamed(name);
      const listed = yield* organization(
        Effect.gen(function* () {
          const plugin = yield* Organization.Organization;
          return yield* plugin.list(caller);
        }),
      );
      assert.deepEqual(listed.map((record) => record.id), [id]);
      assert.ok(Option.isSome(listed[0]?.suspendedAt ?? Option.none()));
    },
  );

  Given(
    "{string} has made the organization {string} her active organization",
    function* (who: string, name: string) {
      const caller = yield* callerNamed(who);
      const id = yield* organizationNamed(name);
      yield* organization(
        Effect.gen(function* () {
          const plugin = yield* Organization.Organization;
          return yield* plugin.setActive(caller, id);
        }),
      );
    },
  );

  Then("{string} has no active member", function* (who: string) {
    const caller = yield* callerNamed(who);
    const outcome = yield* organization(
      Effect.gen(function* () {
        const plugin = yield* Organization.Organization;
        return yield* outcomeTag(plugin.getActiveMember(caller));
      }),
    );
    assert.equal(outcome, "NoActiveOrganization");
  });

  Then(
    "{string} making the organization {string} her active organization is refused with {string}",
    function* (who: string, name: string, tag: string) {
      const caller = yield* callerNamed(who);
      const id = yield* organizationNamed(name);
      const outcome = yield* organization(
        Effect.gen(function* () {
          const plugin = yield* Organization.Organization;
          return yield* outcomeTag(plugin.setActive(caller, id));
        }),
      );
      assert.equal(outcome, tag);
    },
  );

  Then(
    "the audit log holds one {string} event by {string}",
    function* (eventTag: string, admin: string) {
      const events = yield* organization(
        Effect.gen(function* () {
          const auditLog = yield* AuditLog.AuditLog;
          return yield* auditLog.list({ eventTag: auditTag(eventTag) });
        }),
      );
      assert.equal(events.length, 1);
      assert.deepEqual(events[0]?.actorUserId, Option.some(admin));
    },
  );

  When(
    "{string} tries to suspend the organization {string}",
    function* (who: string, name: string) {
      const { outcomes } = yield* World;
      const caller = yield* callerNamed(who);
      const id = yield* organizationNamed(name);
      yield* outcomes.set(
        "attempt-existing",
        yield* organization(
          Effect.gen(function* () {
            const tenants = yield* AdminTenants.AdminTenants;
            return yield* outcomeTag(tenants.suspendOrganization(caller, id, {}));
          }),
        ),
      );
    },
  );

  When("{string} tries to suspend an organization that does not exist", function* (who: string) {
    const { outcomes } = yield* World;
    const caller = yield* callerNamed(who);
    yield* outcomes.set(
      "attempt-unknown",
      yield* organization(
        Effect.gen(function* () {
          const tenants = yield* AdminTenants.AdminTenants;
          return yield* outcomeTag(tenants.suspendOrganization(caller, "no-such-organization", {}));
        }),
      ),
    );
  });

  Then("both attempts are refused with {string}", function* (tag: string) {
    const { outcomes } = yield* World;
    assert.equal(yield* outcomes.get("attempt-existing"), tag);
    assert.equal(yield* outcomes.get("attempt-unknown"), tag);
  });

  const relation = (who: string, name: string, as: string) =>
    Effect.gen(function* () {
      const caller = yield* callerNamed(who);
      const id = yield* organizationNamed(name);
      return yield* organization(
        Effect.gen(function* () {
          const resolver = yield* RelationshipResolver;
          return yield* resolver.check({
            subjectId: makeSubjectId(`user:${caller.ref.id}`),
            relation: as,
            resourceId: makeResourceId(id),
            depth: undefined,
          });
        }),
      );
    });

  Given(
    "qadi finds {string} related to the organization {string} as {string}",
    function* (who: string, name: string, as: string) {
      assert.equal(yield* relation(who, name, as), "Related");
    },
  );

  Then(
    "qadi finds {string} unrelated to the organization {string} as {string}",
    function* (who: string, name: string, as: string) {
      assert.equal(yield* relation(who, name, as), "Unrelated");
    },
  );
});
