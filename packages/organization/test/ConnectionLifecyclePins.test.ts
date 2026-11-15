// CONN-02/03/04 Wave 0 pins (architecture deepening batch 3, phase 4): the OIDC connection store's lifecycle
// behaviour as it is before the connection-lifecycle module, green before and after it. The file is never edited
// after this commit. It builds the store over `TestAuth.layer(Auth.make([Organization.Organization]), ...)` (the
// `RealLive` composition of `OrganizationConnections.test.ts`), so it names no claim store and no directory stub:
// the composition compiles unchanged when the store's requirements change. Every case runs on memory and on SQL
// records (SQLite `:memory:`, Postgres under `AWTHAQ_POSTGRES_URL`).
import { AuditLog, Auth, Users } from "@awthaq/core";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Organization from "../src/Organization.ts";
import * as OrganizationActor from "../src/OrganizationActor.ts";
import * as OrganizationConnections from "../src/OrganizationConnections.ts";
import * as OrganizationDirectory from "../src/OrganizationDirectory.ts";

const actor = OrganizationActor.application("ConnectionLifecyclePins.test");

const stores = Layer.mergeAll(
  OrganizationConnections.layerStore,
  OrganizationConnections.connectionsOnOrganizationDelete,
).pipe(Layer.provideMerge(OrganizationConnections.OrganizationConnections.layer));

const MemoryLive = stores.pipe(
  Layer.provideMerge(
    TestAuth.layer(Auth.make([Organization.Organization]), { services: Organization.config({}) }),
  ),
);

const SqlLive = stores.pipe(
  Layer.provideMerge(
    TestAuth.layer(Auth.make([Organization.Organization]), {
      records: "sql",
      suite: "organization_ConnectionLifecyclePins",
      services: Organization.config({}),
    }),
  ),
);

const oidcInput = (
  organizationId: string,
  emailDomains: ReadonlyArray<string>,
): OrganizationConnections.ConnectionCreateInput => ({
  organizationId,
  kind: "oidc",
  name: "Acme SSO",
  issuer: "https://idp.acme.example",
  discoveryUrl: "https://idp.acme.example/.well-known/openid-configuration",
  clientId: "client-1",
  clientSecret: Redacted.make("super-secret"),
  emailDomains,
});

const organization = (slug: string) =>
  Effect.flatMap(OrganizationDirectory.OrganizationDirectory, (directory) =>
    directory.create(actor, { owner: Users.UserId(`owner-${slug}`), name: slug, slug }),
  );

const suspend = (organizationId: string) =>
  Effect.flatMap(OrganizationDirectory.OrganizationDirectory, (directory) =>
    directory.suspend(OrganizationActor.platformAdmin(Users.UserId("admin")), { organizationId }),
  );

const create = (organizationId: string, emailDomains: ReadonlyArray<string>) =>
  Effect.flatMap(OrganizationConnections.OrganizationConnectionStore, (store) =>
    store.create(actor, oidcInput(organizationId, emailDomains)),
  );

const refused = (organizationId: string, emailDomains: ReadonlyArray<string>) =>
  Effect.flatMap(OrganizationConnections.OrganizationConnectionStore, (store) =>
    store.create(actor, oidcInput(organizationId, emailDomains)).pipe(Effect.flip),
  );

const eventCount = (eventTag: string) =>
  Effect.flatMap(AuditLog.AuditLog, (auditLog) => auditLog.list({ eventTag })).pipe(
    Effect.map((rows) => rows.length),
  );

/** The failing tag and the field the refusal carries (`reason` or `domain`), never its message. */
const shape = (error: { readonly _tag: string }) => ({
  _tag: error._tag,
  reason: "reason" in error ? error.reason : undefined,
  domain: "domain" in error ? error.domain : undefined,
});

const NO_ORGANIZATION = {
  _tag: "InvalidConnection",
  reason: "the organization does not exist",
  domain: undefined,
};

for (const [leg, Live] of [
  ["memory", MemoryLive],
  ["sql", SqlLive],
] as const) {
  describe(`connection lifecycle pins, OIDC store on ${leg} records`, () => {
    it.effect("create refuses an unknown and a suspended organization alike", () =>
      Effect.gen(function* () {
        const unknown = yield* refused("no-such-organization", ["acme.example"]);
        assert.deepStrictEqual(shape(unknown), NO_ORGANIZATION);
        const org = yield* organization("a");
        yield* suspend(org.id);
        const suspended = yield* refused(org.id, ["acme.example"]);
        assert.deepStrictEqual(shape(suspended), NO_ORGANIZATION);
      }).pipe(TestAuth.withoutRequest, Effect.provide(Live)),
    );

    it.effect("update refuses a suspended organization with the same reason", () =>
      Effect.gen(function* () {
        const store = yield* OrganizationConnections.OrganizationConnectionStore;
        const org = yield* organization("a");
        const view = yield* create(org.id, ["acme.example"]);
        yield* suspend(org.id);
        const error = yield* store
          .update(actor, org.id, view.id, { clientId: "client-2" })
          .pipe(Effect.flip);
        assert.deepStrictEqual(shape(error), NO_ORGANIZATION);
      }).pipe(TestAuth.withoutRequest, Effect.provide(Live)),
    );

    it.effect("remove still works while suspended, and frees the domain", () =>
      Effect.gen(function* () {
        const store = yield* OrganizationConnections.OrganizationConnectionStore;
        const first = yield* organization("a");
        const second = yield* organization("b");
        const view = yield* create(first.id, ["acme.example"]);
        yield* suspend(first.id);
        yield* store.remove(actor, first.id, view.id);
        assert.deepStrictEqual(yield* store.list(first.id), []);
        const taken = yield* create(second.id, ["acme.example"]);
        assert.deepStrictEqual(taken.emailDomains, ["acme.example"]);
      }).pipe(TestAuth.withoutRequest, Effect.provide(Live)),
    );

    it.effect("a taken domain names the first foreign domain in input order, with no event", () =>
      Effect.gen(function* () {
        const owner = yield* organization("a");
        const rival = yield* organization("b");
        const third = yield* organization("c");
        yield* create(owner.id, ["y.example", "z.example"]);
        const created = yield* eventCount("auth.organization.connectionCreated");
        const error = yield* refused(rival.id, ["x.example", "z.example", "y.example"]);
        assert.deepStrictEqual(shape(error), {
          _tag: "ConnectionDomainTaken",
          reason: undefined,
          domain: "z.example",
        });
        assert.strictEqual(yield* eventCount("auth.organization.connectionCreated"), created);
        // The refused claim took nothing, not even the domain listed before the clash.
        const view = yield* create(third.id, ["x.example"]);
        assert.deepStrictEqual(view.emailDomains, ["x.example"]);
      }).pipe(TestAuth.withoutRequest, Effect.provide(Live)),
    );

    it.effect("a failed create holds no claim", () =>
      Effect.gen(function* () {
        const store = yield* OrganizationConnections.OrganizationConnectionStore;
        const owner = yield* organization("a");
        const rival = yield* organization("b");
        const first = yield* create(owner.id, ["acme.example"]);
        // The owner may claim its own domain again; the connection write is what refuses it.
        const error = yield* refused(owner.id, ["acme.example"]);
        assert.deepStrictEqual(shape(error), {
          _tag: "ConnectionDomainTaken",
          reason: undefined,
          domain: "acme.example",
        });
        assert.strictEqual((yield* store.list(owner.id)).length, 1);
        yield* store.remove(actor, owner.id, first.id);
        // Nothing the failed create claimed is left: the domain is free for another organization.
        const view = yield* create(rival.id, ["acme.example"]);
        assert.deepStrictEqual(view.emailDomains, ["acme.example"]);
      }).pipe(TestAuth.withoutRequest, Effect.provide(Live)),
    );

    it.effect("a failed update keeps the previous domains", () =>
      Effect.gen(function* () {
        const store = yield* OrganizationConnections.OrganizationConnectionStore;
        const owner = yield* organization("a");
        const rival = yield* organization("b");
        const first = yield* create(owner.id, ["one.example"]);
        const second = yield* create(owner.id, ["two.example"]);
        const error = yield* store
          .update(actor, owner.id, second.id, { emailDomains: ["one.example"] })
          .pipe(Effect.flip);
        assert.deepStrictEqual(shape(error), {
          _tag: "ConnectionDomainTaken",
          reason: undefined,
          domain: "one.example",
        });
        assert.strictEqual(yield* eventCount("auth.organization.connectionUpdated"), 0);
        // The connection still holds what it held, and nothing more.
        const held = yield* refused(rival.id, ["two.example"]);
        assert.strictEqual(shape(held).domain, "two.example");
        yield* store.remove(actor, owner.id, first.id);
        const view = yield* create(rival.id, ["one.example"]);
        assert.deepStrictEqual(view.emailDomains, ["one.example"]);
      }).pipe(TestAuth.withoutRequest, Effect.provide(Live)),
    );

    it.effect("deleting an organization frees its domains and leaves no connection rows", () =>
      Effect.gen(function* () {
        const store = yield* OrganizationConnections.OrganizationConnectionStore;
        const directory = yield* OrganizationDirectory.OrganizationDirectory;
        const doomed = yield* organization("a");
        const other = yield* organization("b");
        yield* create(doomed.id, ["acme.example"]);
        yield* directory.delete(actor, { organizationId: doomed.id });
        assert.deepStrictEqual(yield* store.list(doomed.id), []);
        const view = yield* create(other.id, ["acme.example"]);
        assert.deepStrictEqual(view.emailDomains, ["acme.example"]);
      }).pipe(TestAuth.withoutRequest, Effect.provide(Live)),
    );
  });
}
