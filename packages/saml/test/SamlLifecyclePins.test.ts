// CONN-04 Wave 0 pins (architecture deepening batch 3, phase 4): the SAML connection store's lifecycle behaviour as
// it is before the connection-lifecycle module, green before and after it. The file is never edited after this commit.
// The suspended-organization create/update/refresh refusals are deliberately absent: they flip with the module and are
// the failing-first BDD rows of plan 04-02.
import { Api } from "@awthaq/api";
import { AuditLog, CurrentUser } from "@awthaq/core";
import { Organization } from "@awthaq/organization";
import { OrganizationRecords } from "@awthaq/organization/records";
import { TestAuth } from "@awthaq/test";
import { TenantScoped } from "@awthaq/sql";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Saml from "../src/Saml.ts";
import * as SamlConnections from "../src/SamlConnections.ts";
import { idp } from "./samlFixtures.ts";
import { atNow, IDP_ENTITY_ID, ownerPrincipal, SamlLive, seedConnection } from "./support.ts";

const grant = TenantScoped.crossTenant("saml lifecycle pins: suspending an organization by id");

const admin = CurrentUser.of(
  new Api.UserPrincipal({
    ref: new Api.PrincipalRef({ type: "user", id: "admin-1" }),
    sessionId: "admin-session",
  }),
);

const live = SamlLive({ canManageSaml: () => Effect.succeed(true) });

const input = (
  organizationId: string,
  emailDomains: ReadonlyArray<string>,
  entityId = IDP_ENTITY_ID,
) => ({
  organizationId,
  name: "Acme SAML",
  idp: { entityId, ssoUrl: "https://idp.example.com/sso", certificates: [idp.cert] },
  emailDomains,
});

const organization = (slug: string) =>
  Effect.flatMap(Organization.Organization, (service) =>
    service.create({ caller: ownerPrincipal, name: slug, slug }),
  );

const suspend = (organizationId: string) =>
  Effect.gen(function* () {
    const records = yield* OrganizationRecords.OrganizationRecords;
    yield* records.setSuspended(grant, organizationId, Option.some(yield* DateTime.now));
  });

/** The failing tag and the field the refusal carries (`reason` or `domain`), never its message. */
const shape = (error: { readonly _tag: string }) => ({
  _tag: error._tag,
  reason: "reason" in error ? error.reason : undefined,
  domain: "domain" in error ? error.domain : undefined,
});

const createdEvents = Effect.flatMap(AuditLog.AuditLog, (auditLog) =>
  auditLog.list({ eventTag: "auth.saml.connectionCreated" }),
).pipe(Effect.map((rows) => rows.length));

describe("SAML connection lifecycle pins", () => {
  it.effect(
    "a taken domain names the first foreign domain in input order, at the store and the admin surface",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const store = yield* SamlConnections.SamlConnectionStore;
        const { admin: ops } = yield* Saml.Saml;
        yield* seedConnection({ slug: "a", emailDomains: ["y.example", "z.example"] });
        const { organizationId: rival } = yield* seedConnection({ slug: "b", emailDomains: [] });
        const domains = ["x.example", "z.example", "y.example"];
        const atStore = yield* store.create(input(rival, domains)).pipe(Effect.flip);
        assert.deepStrictEqual(shape(atStore), {
          _tag: "SamlDomainTaken",
          reason: undefined,
          domain: "z.example",
        });
        const atAdmin = yield* ops
          .createConnection(admin, { ...input(rival, domains) })
          .pipe(Effect.flip);
        assert.deepStrictEqual(shape(atAdmin), {
          _tag: "SamlDomainAlreadyRouted",
          reason: undefined,
          domain: "z.example",
        });
        assert.strictEqual(yield* createdEvents, 0);
      }).pipe(TestAuth.withoutRequest, Effect.provide(live)),
  );

  it.effect(
    "an unknown organization is refused with the same reason at the store and the admin surface",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const store = yield* SamlConnections.SamlConnectionStore;
        const { admin: ops } = yield* Saml.Saml;
        const atStore = yield* store
          .create(input("no-such-organization", ["acme.example"]))
          .pipe(Effect.flip);
        assert.deepStrictEqual(shape(atStore), {
          _tag: "InvalidSamlConnection",
          reason: "the organization does not exist",
          domain: undefined,
        });
        const atAdmin = yield* ops
          .createConnection(admin, input("no-such-organization", ["acme.example"]))
          .pipe(Effect.flip);
        assert.deepStrictEqual(shape(atAdmin), {
          _tag: "InvalidSamlConnectionRequest",
          reason: "the organization does not exist",
          domain: undefined,
        });
        assert.strictEqual(yield* createdEvents, 0);
      }).pipe(TestAuth.withoutRequest, Effect.provide(live)),
  );

  it.effect("an unknown connection id is NotFound for update, refreshMetadata and remove", () =>
    Effect.gen(function* () {
      const store = yield* SamlConnections.SamlConnectionStore;
      const failures = [
        yield* store.update("no-such-connection", { name: "renamed" }).pipe(Effect.flip),
        yield* store.refreshMetadata("no-such-connection", "<EntityDescriptor/>").pipe(Effect.flip),
        yield* store.remove("no-such-connection").pipe(Effect.flip),
      ];
      assert.deepStrictEqual(
        failures.map((failure) => failure._tag),
        ["SamlConnections/NotFound", "SamlConnections/NotFound", "SamlConnections/NotFound"],
      );
    }).pipe(TestAuth.withoutRequest, Effect.provide(live)),
  );

  it.effect(
    "a suspended organization's connection can be removed, and its domain is then free",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const store = yield* SamlConnections.SamlConnectionStore;
        const { organizationId, connection } = yield* seedConnection({
          slug: "a",
          emailDomains: ["acme.example"],
        });
        const rival = yield* organization("b");
        yield* suspend(organizationId);
        yield* store.remove(connection.id);
        assert.deepStrictEqual(yield* store.list(organizationId), []);
        const taken = yield* store.create(input(rival.id, ["acme.example"]));
        assert.deepStrictEqual(taken.emailDomains, ["acme.example"]);
      }).pipe(TestAuth.withoutRequest, Effect.provide(live)),
  );

  it.effect("a failed create holds no claim", () =>
    Effect.gen(function* () {
      yield* atNow;
      const store = yield* SamlConnections.SamlConnectionStore;
      const { organizationId, connection } = yield* seedConnection({
        slug: "a",
        emailDomains: ["acme.example"],
      });
      const rival = yield* organization("b");
      // The owner may claim its own domain again; the connection write is what refuses it.
      const error = yield* store
        .create(input(organizationId, ["acme.example"], "https://idp.other.example/metadata"))
        .pipe(Effect.flip);
      assert.deepStrictEqual(shape(error), {
        _tag: "SamlDomainTaken",
        reason: undefined,
        domain: "acme.example",
      });
      assert.strictEqual((yield* store.list(organizationId)).length, 1);
      yield* store.remove(connection.id);
      // Nothing the failed create claimed is left: the domain is free for another organization.
      const taken = yield* store.create(input(rival.id, ["acme.example"]));
      assert.deepStrictEqual(taken.emailDomains, ["acme.example"]);
    }).pipe(TestAuth.withoutRequest, Effect.provide(live)),
  );
});
