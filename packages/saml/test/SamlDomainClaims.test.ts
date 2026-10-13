// BEH-EA-317 (plan 10 item 7): an email domain belongs to one organization across protocols. The OIDC store and the
// SAML store claim through the one `DomainClaims` the organization's records bundle provides, so organization B cannot
// route `acme.com` over SAML while the real Acme routes it over OIDC (or the other way round), and the organization
// that owns a domain may route it over both.
import { DomainClaims, OrganizationActor, OrganizationConnections } from "@awthaq/organization";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SamlConnections from "../src/SamlConnections.ts";
import { idp } from "./samlFixtures.ts";
import { atNow, IDP_ENTITY_ID, SamlLive, seedConnection } from "./support.ts";

const actor = OrganizationActor.application("SamlDomainClaims.test");

/** `SamlLive` plus the organization's OIDC connection store, built over the very `DomainClaims` the SAML store uses. */
const Live = OrganizationConnections.layerStore.pipe(
  Layer.provide(OrganizationConnections.OrganizationConnections.layer),
  Layer.provideMerge(SamlLive()),
);

const oidc = (organizationId: string, emailDomains: ReadonlyArray<string>) =>
  Effect.flatMap(OrganizationConnections.OrganizationConnectionStore, (store) =>
    store.create(actor, {
      organizationId,
      kind: "oidc",
      name: "Acme OIDC",
      issuer: "https://oidc.acme.example",
      discoveryUrl: "https://oidc.acme.example/.well-known/openid-configuration",
      clientId: "client-1",
      clientSecret: Redacted.make("secret"),
      emailDomains,
    }),
  );

const samlIn = (
  organizationId: string,
  emailDomains: ReadonlyArray<string>,
  entityId = IDP_ENTITY_ID,
) =>
  Effect.flatMap(SamlConnections.SamlConnectionStore, (store) =>
    store.create({
      organizationId,
      name: "Acme SAML",
      idp: { entityId, ssoUrl: "https://idp.example.com/sso", certificates: [idp.cert] },
      emailDomains,
    }),
  );

describe("one organization per email domain, across protocols (BEH-EA-317)", () => {
  it.effect("an OIDC claim by one organization refuses a SAML claim by another", () =>
    Effect.gen(function* () {
      yield* atNow;
      const { organizationId: acme } = yield* seedConnection({ slug: "acme", emailDomains: [] });
      const { organizationId: mallory } = yield* seedConnection({
        slug: "mallory",
        emailDomains: [],
      });
      yield* oidc(acme, ["acme.example"]);
      const refused = yield* samlIn(mallory, ["acme.example"]).pipe(Effect.flip);
      assert.strictEqual(refused._tag, "SamlDomainTaken");
      // Nothing of the refused connection is left behind.
      const store = yield* SamlConnections.SamlConnectionStore;
      // Only the connection the organization was seeded with (no domains) exists.
      assert.deepStrictEqual(
        (yield* store.list(mallory)).map((row) => row.emailDomains),
        [[]],
      );
    }).pipe(Effect.provide(Live)),
  );

  it.effect("a SAML claim by one organization refuses an OIDC claim by another", () =>
    Effect.gen(function* () {
      yield* atNow;
      yield* seedConnection({ slug: "acme", emailDomains: ["acme.example"] });
      const { organizationId: another } = yield* seedConnection({
        slug: "another",
        emailDomains: [],
      });
      const refused = yield* oidc(another, ["acme.example"]).pipe(Effect.flip);
      assert.strictEqual(refused._tag, "ConnectionDomainTaken");
      const store = yield* OrganizationConnections.OrganizationConnectionStore;
      assert.deepStrictEqual(yield* store.list(another), []);
    }).pipe(Effect.provide(Live)),
  );

  it.effect("the organization that owns a domain may route it over both protocols", () =>
    Effect.gen(function* () {
      yield* atNow;
      const { organizationId } = yield* seedConnection({ emailDomains: ["acme.example"] });
      const view = yield* oidc(organizationId, ["acme.example"]);
      assert.deepStrictEqual(view.emailDomains, ["acme.example"]);
      // Both connections of the owner now route it (`Sso.preferred` picks among them).
      const store = yield* SamlConnections.SamlConnectionStore;
      assert.deepStrictEqual(
        (yield* store.list(organizationId)).map((row) => row.emailDomains),
        [["acme.example"]],
      );
    }).pipe(Effect.provide(Live)),
  );

  it.effect(
    "deleting the last connection that claims a domain frees it for another organization",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const saml = yield* SamlConnections.SamlConnectionStore;
        const oidcStore = yield* OrganizationConnections.OrganizationConnectionStore;
        const { organizationId: acme, connection } = yield* seedConnection({
          emailDomains: ["acme.example"],
        });
        const oidcView = yield* oidc(acme, ["acme.example"]);
        const { organizationId: other } = yield* seedConnection({
          slug: "other",
          emailDomains: [],
        });

        yield* saml.remove(connection.id);
        // The OIDC connection still claims it.
        assert.strictEqual(
          (yield* samlIn(other, ["acme.example"]).pipe(Effect.flip))._tag,
          "SamlDomainTaken",
        );
        yield* oidcStore.remove(actor, acme, oidcView.id);
        yield* samlIn(other, ["acme.example"]);
      }).pipe(Effect.provide(Live)),
  );

  it.effect("a refused domain on update leaves the connection's own claim as it was", () =>
    Effect.gen(function* () {
      yield* atNow;
      const saml = yield* SamlConnections.SamlConnectionStore;
      const claims = yield* DomainClaims.DomainClaims;
      const { organizationId: acme } = yield* seedConnection({ slug: "acme", emailDomains: [] });
      const { organizationId: rival, connection } = yield* seedConnection({
        slug: "rival",
        emailDomains: ["rival.example"],
        entityId: "https://rival-idp.example.com/metadata",
      });
      yield* oidc(acme, ["acme.example"]);

      const refused = yield* saml
        .update(connection.id, { emailDomains: ["rival.example", "acme.example"] })
        .pipe(Effect.flip);
      assert.strictEqual(refused._tag, "SamlDomainTaken");
      const after = yield* saml.get(connection.id);
      assert.deepStrictEqual(after.emailDomains, ["rival.example"]);
      // The connection still owns its old domain: no third organization can take it.
      const taken = yield* claims
        .claim({
          organizationId: "third",
          protocol: "saml",
          connectionId: "x",
          domains: ["rival.example"],
        })
        .pipe(Effect.flip);
      assert.strictEqual(taken._tag, "DomainClaimTaken");
      assert.isTrue(Option.isSome(Option.some(rival)));
    }).pipe(Effect.provide(Live)),
  );
});
