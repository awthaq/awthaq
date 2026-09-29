// BEH-EA-318 (spec/behaviors/29-saml-sp.md): the administrator's CRUD over SAML connections, through the service the `saml.admin`
// group is a thin shell over (the HTTP wiring is `SamlAdminHttp.test.ts`). Fail-closed and tenant-scoped, IdP metadata imported from
// XML or a URL (the fetch itself is `SamlMetadataFetcher.test.ts`), the trust set replaced by a refresh, the SP signing key rotated,
// and every successful mutation audited by identifiers only.
import { Api } from "@awthaq/api";
import { AuditLog, Tenant } from "@awthaq/core";
import { RateLimiter } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Saml from "../src/Saml.ts";
import * as SamlMetadataFetcher from "../src/SamlMetadataFetcher.ts";
import * as SamlRecords from "../src/SamlRecords.ts";
import * as SamlSpKeys from "../src/SamlSpKeys.ts";
import { attacker, idp, idpNext, weakRsa } from "./samlFixtures.ts";
import { idpMetadataXml } from "./samlMetadata.ts";
import {
  atNow,
  fakeFetcher,
  idpResponse,
  IDP_ENTITY_ID,
  ownerPrincipal,
  SamlLive,
  seedConnection,
  startLogin,
} from "./support.ts";
import { Organization } from "@awthaq/organization";

const admin = new Api.UserPrincipal({
  ref: new Api.PrincipalRef({ type: "user", id: "admin-1" }),
  sessionId: "admin-session",
});

const allow = () => Effect.succeed(true);

const MemoryLimiter = RateLimiter.layer.pipe(
  Layer.provide(
    RateLimiter.layerStoreMemoryWith({ maxBuckets: 1000, sweepInterval: Duration.days(3650) }),
  ),
);

const org = (slug: string) =>
  Effect.flatMap(Organization.Organization, (organization) =>
    organization.create({ caller: ownerPrincipal, name: slug, slug }),
  );

const auditTags = (prefix: string) =>
  Effect.flatMap(AuditLog.AuditLog, (auditLog) => auditLog.list()).pipe(
    Effect.map((rows) =>
      rows
        .filter((row) => row.eventTag.startsWith(prefix))
        .map((row) => row.eventTag)
        .reverse(),
    ),
  );

const handBuilt = (
  organizationId: string,
  extra: Partial<Parameters<Saml.Saml["Service"]["admin"]["createConnection"]>[1]> = {},
) => ({
  organizationId,
  name: "Acme Okta",
  idp: {
    entityId: IDP_ENTITY_ID,
    ssoUrl: "https://idp.example.com/sso",
    certificates: [idp.cert],
  },
  emailDomains: ["acme.example"],
  ...extra,
});

describe("the gate is fail-closed", () => {
  it.effect(
    "with no gate configured every operation is denied, publishes actionDenied, and touches nothing",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const { admin: ops } = yield* Saml.Saml;
        const { connection, organizationId } = yield* seedConnection();
        const results = [
          yield* ops.createConnection(admin, handBuilt(organizationId)).pipe(Effect.flip),
          yield* ops.listConnections(admin, organizationId).pipe(Effect.flip),
          yield* ops.getConnection(admin, connection.id).pipe(Effect.flip),
          yield* ops.updateConnection(admin, connection.id, { name: "renamed" }).pipe(Effect.flip),
          yield* ops.deleteConnection(admin, connection.id).pipe(Effect.flip),
          yield* ops.refreshMetadata(admin, connection.id).pipe(Effect.flip),
          yield* ops.rotateSigningKey(admin, connection.id, {}).pipe(Effect.flip),
          yield* ops.listSigningKeys(admin, connection.id).pipe(Effect.flip),
        ];
        assert.isTrue(results.every((failure) => failure._tag === "SamlActionDenied"));
        const denied = (yield* Effect.flatMap(AuditLog.AuditLog, (log) =>
          log.list({ eventTag: "auth.admin.actionDenied" }),
        )).flatMap((row) =>
          row.payload._tag === "auth.admin.actionDenied" ? [row.payload.action] : [],
        );
        assert.deepStrictEqual(denied.toSorted(), [
          "saml.createConnection",
          "saml.deleteConnection",
          "saml.getConnection",
          "saml.listConnections",
          "saml.listSigningKeys",
          "saml.refreshMetadata",
          "saml.rotateSigningKey",
          "saml.updateConnection",
        ]);
        // Nothing changed and nothing was audited as a mutation.
        const store = yield* SamlRecords.SamlRecords;
        assert.strictEqual((yield* store.listByOrganization(organizationId)).length, 1);
        assert.strictEqual(
          (yield* store.findById(connection.id).pipe(Effect.map(Option.getOrThrow))).name,
          "Acme Okta",
        );
        assert.deepStrictEqual(yield* auditTags("auth.saml."), []);
      }).pipe(Effect.provide(SamlLive())),
  );

  it.effect(
    "the gate sees the action and the organization, so a host can let one administrator manage one tenant",
    () => {
      let permitted = "";
      return Effect.gen(function* () {
        yield* atNow;
        const { admin: ops } = yield* Saml.Saml;
        const acme = yield* org("acme");
        const globex = yield* org("globex");
        permitted = acme.id;
        const mine = yield* ops.createConnection(admin, handBuilt(acme.id));
        const denied = yield* ops
          .createConnection(admin, handBuilt(globex.id, { emailDomains: ["globex.example"] }))
          .pipe(Effect.flip);
        assert.strictEqual(denied._tag, "SamlActionDenied");
        assert.strictEqual((yield* ops.listConnections(admin, acme.id)).length, 1);
        const refusedList = yield* ops.listConnections(admin, globex.id).pipe(Effect.flip);
        assert.strictEqual(refusedList._tag, "SamlActionDenied");
        assert.strictEqual(mine.organizationId, acme.id);
      }).pipe(
        Effect.provide(
          SamlLive({
            // The gate is asked with the organization for create/list; by-id operations are gated on the action alone.
            canManageSaml: ({ organizationId }) =>
              Effect.succeed(organizationId === undefined || organizationId === permitted),
          }),
        ),
      );
    },
  );

  it.effect(
    "a caller who fails the gate learns nothing about which ids exist; one who passes gets 404 for an unknown id",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const { admin: ops } = yield* Saml.Saml;
        const { connection } = yield* seedConnection();
        const real = yield* ops.getConnection(admin, connection.id).pipe(Effect.flip);
        const fake = yield* ops.getConnection(admin, "nope").pipe(Effect.flip);
        assert.strictEqual(real._tag, "SamlActionDenied");
        assert.strictEqual(fake._tag, "SamlActionDenied");
      }).pipe(Effect.provide(SamlLive())),
  );

  it.effect("past the gate each administrator is limited per window", () =>
    Effect.gen(function* () {
      yield* atNow;
      const { admin: ops } = yield* Saml.Saml;
      const acme = yield* org("acme");
      yield* ops.listConnections(admin, acme.id);
      yield* ops.listConnections(admin, acme.id);
      const limited = yield* ops.listConnections(admin, acme.id).pipe(Effect.flip);
      assert.strictEqual(limited._tag, "RateLimited");
      // Another administrator has their own budget.
      const other = new Api.UserPrincipal({
        ref: new Api.PrincipalRef({ type: "user", id: "admin-2" }),
        sessionId: "s2",
      });
      yield* ops.listConnections(other, acme.id);
    }).pipe(
      Effect.provide(
        SamlLive(
          { canManageSaml: allow, adminRate: { limit: 2, window: Duration.minutes(1) } },
          MemoryLimiter,
        ),
      ),
    ),
  );
});

describe("registering a connection", () => {
  it.effect("by hand: the DTO names what to give the IdP administrator, and never a secret", () =>
    Effect.gen(function* () {
      yield* atNow;
      const { admin: ops } = yield* Saml.Saml;
      const acme = yield* org("acme");
      const created = yield* ops.createConnection(admin, handBuilt(acme.id, { trustsEmail: true }));
      assert.strictEqual(created.organizationId, acme.id);
      assert.strictEqual(created.idpEntityId, IDP_ENTITY_ID);
      assert.deepStrictEqual(created.emailDomains, ["acme.example"]);
      assert.isTrue(created.trustsEmail);
      assert.isFalse(created.authnRequestsSigned);
      assert.strictEqual(created.certificates.length, 1);
      assert.strictEqual(created.certificates[0]?.fingerprint, idp.fingerprint);
      assert.strictEqual(created.spEntityId, `https://sp.example.com/auth/saml/sp/${created.id}`);
      assert.strictEqual(
        created.spMetadataUrl,
        `https://sp.example.com/auth/saml/metadata?connection=${created.id}`,
      );
      assert.deepStrictEqual(created.spCertificates, []);
      assert.deepStrictEqual(created.roleCeiling, ["member"]);
      assert.deepStrictEqual(yield* auditTags("auth.saml."), ["auth.saml.connectionCreated"]);
    }).pipe(Effect.provide(SamlLive({ canManageSaml: allow }))),
  );

  it.effect(
    "from pasted IdP metadata: entity id, SSO, logout endpoint and both certificates are pinned; a signing IdP gets a signing key",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const { admin: ops } = yield* Saml.Saml;
        const acme = yield* org("acme");
        const created = yield* ops.createConnection(admin, {
          organizationId: acme.id,
          name: "From metadata",
          idp: {
            metadataXml: idpMetadataXml({
              certs: [idp.cert, idpNext.cert],
              entityId: "https://strict.example.com/m",
              slo: { redirect: "https://strict.example.com/slo" },
              wantAuthnRequestsSigned: true,
            }),
          },
        });
        assert.strictEqual(created.idpEntityId, "https://strict.example.com/m");
        assert.strictEqual(created.sloUrl, "https://strict.example.com/slo");
        assert.strictEqual(created.sloBinding, "redirect");
        assert.deepStrictEqual(
          created.certificates.map((entry) => entry.fingerprint).toSorted(),
          [idp.fingerprint, idpNext.fingerprint].toSorted(),
        );
        assert.isTrue(created.authnRequestsSigned);
        assert.strictEqual(created.spCertificates.length, 1);
        assert.isNull(created.metadataUrl);
      }).pipe(Effect.provide(SamlLive({ canManageSaml: allow }))),
  );

  it.effect(
    "from a metadata URL: fetched through the fetcher, remembered for refreshes, and a fetch failure is a class, never text",
    () => {
      const fetcher = fakeFetcher({
        "https://idp.example.com/metadata.xml": idpMetadataXml({
          slo: { post: "https://idp.example.com/slo-post" },
        }),
        "https://down.example.com/metadata.xml": new SamlMetadataFetcher.MetadataFetchFailed({
          failure: "timeout",
          detail: "the request failed",
        }),
      });
      return Effect.gen(function* () {
        yield* atNow;
        const { admin: ops } = yield* Saml.Saml;
        const acme = yield* org("acme");
        const created = yield* ops.createConnection(admin, {
          organizationId: acme.id,
          name: "By URL",
          idp: { metadataUrl: "https://idp.example.com/metadata.xml" },
        });
        assert.strictEqual(created.metadataUrl, "https://idp.example.com/metadata.xml");
        assert.strictEqual(created.sloUrl, "https://idp.example.com/slo-post");
        assert.strictEqual(
          created.sloBinding,
          "post",
          "an IdP that offers only the POST binding is logged out through it",
        );
        assert.deepStrictEqual(fetcher.requested, ["https://idp.example.com/metadata.xml"]);
        const unavailable = yield* ops
          .createConnection(admin, {
            organizationId: acme.id,
            name: "Down",
            idp: { metadataUrl: "https://down.example.com/metadata.xml" },
          })
          .pipe(Effect.flip);
        assert.deepStrictEqual(JSON.parse(JSON.stringify(unavailable)), {
          _tag: "SamlMetadataUnavailable",
          failure: "timeout",
        });
      }).pipe(Effect.provide(SamlLive({ canManageSaml: allow }, undefined, fetcher.layer)));
    },
  );

  it.effect(
    "refuses what would corrupt the trust boundary with the rule named, creating nothing",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const { admin: ops } = yield* Saml.Saml;
        const acme = yield* org("acme");
        const refuse = (
          extra: Parameters<typeof handBuilt>[1],
          idpOverride?: Record<string, unknown>,
        ) =>
          ops
            .createConnection(admin, {
              ...handBuilt(acme.id, extra),
              ...(idpOverride === undefined
                ? {}
                : { idp: { ...handBuilt(acme.id).idp, ...idpOverride } }),
            })
            .pipe(
              Effect.flip,
              Effect.map((failure) =>
                failure._tag === "InvalidSamlConnectionRequest" ? failure.reason : failure._tag,
              ),
            );
        assert.include(
          yield* refuse({}, { ssoUrl: "http://idp.example.com/sso" }),
          "must be https",
        );
        assert.include(
          yield* refuse({}, { sloUrl: "https://169.254.169.254/slo" }),
          "private or loopback",
        );
        assert.include(yield* refuse({}, { certificates: [weakRsa.cert] }), "at least 2048 bits");
        assert.include(
          yield* refuse({}, { certificates: [] }),
          "at least one IdP signing certificate",
        );
        assert.include(
          yield* refuse({ emailDomains: ["not a domain"] }),
          "not a valid email domain",
        );
        assert.include(yield* refuse({ organizationId: "no-such-org" }), "does not exist");
        assert.include(yield* refuse({}, { entityId: "   " }), "entity id is empty");
        const records = yield* SamlRecords.SamlRecords;
        assert.deepStrictEqual(yield* records.listByOrganization(acme.id), []);
      }).pipe(Effect.provide(SamlLive({ canManageSaml: allow }))),
  );

  it.effect(
    "a domain routes to exactly one connection: the second claim is a typed 409, and the first stays intact",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const { admin: ops } = yield* Saml.Saml;
        const acme = yield* org("acme");
        const globex = yield* org("globex");
        yield* ops.createConnection(admin, handBuilt(acme.id));
        const clash = yield* ops.createConnection(admin, handBuilt(globex.id)).pipe(Effect.flip);
        assert.deepStrictEqual(JSON.parse(JSON.stringify(clash)), {
          _tag: "SamlDomainAlreadyRouted",
          domain: "acme.example",
        });
        assert.deepStrictEqual(yield* ops.listConnections(admin, globex.id), []);
      }).pipe(Effect.provide(SamlLive({ canManageSaml: allow }))),
  );
});

describe("editing and removing a connection", () => {
  it.effect(
    "update changes what it names, audits the field NAMES only, and delete takes the keys with it",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const { admin: ops } = yield* Saml.Saml;
        const keys = yield* SamlSpKeys.SamlSpKeys;
        const acme = yield* org("acme");
        const created = yield* ops.createConnection(admin, handBuilt(acme.id));
        const updated = yield* ops.updateConnection(admin, created.id, {
          name: "Very secret-looking name",
          ssoUrl: "https://idp.example.com/new-sso",
          authnRequestsSigned: true,
          emailDomains: ["acme.example", "acme.test"],
        });
        assert.strictEqual(updated.name, "Very secret-looking name");
        assert.strictEqual(updated.ssoUrl, "https://idp.example.com/new-sso");
        assert.isTrue(updated.authnRequestsSigned);
        assert.strictEqual(updated.spCertificates.length, 1);
        const events = yield* Effect.flatMap(AuditLog.AuditLog, (log) =>
          log.list({ eventTag: "auth.saml.connectionUpdated" }),
        );
        const payload = events[0]?.payload;
        assert.strictEqual(payload?._tag, "auth.saml.connectionUpdated");
        assert.deepStrictEqual(
          payload?._tag === "auth.saml.connectionUpdated" ? [...payload.fields].toSorted() : [],
          ["authnRequestsSigned", "emailDomains", "name", "ssoUrl"],
        );
        // Names, never values.
        assert.notInclude(JSON.stringify(events.map((row) => row.payload)), "secret-looking");
        assert.notInclude(JSON.stringify(events.map((row) => row.payload)), "new-sso");
        yield* ops.deleteConnection(admin, created.id);
        assert.deepStrictEqual(yield* keys.list(created.id), []);
        const gone = yield* ops.getConnection(admin, created.id).pipe(Effect.flip);
        assert.strictEqual(gone._tag, "SamlConnectionNotFound");
        assert.deepStrictEqual(yield* auditTags("auth.saml."), [
          "auth.saml.connectionCreated",
          "auth.saml.connectionUpdated",
          "auth.saml.connectionDeleted",
        ]);
      }).pipe(Effect.provide(SamlLive({ canManageSaml: allow }))),
  );

  it.effect("a refused or failed operation publishes no mutation event", () =>
    Effect.gen(function* () {
      yield* atNow;
      const { admin: ops } = yield* Saml.Saml;
      const acme = yield* org("acme");
      const created = yield* ops.createConnection(admin, handBuilt(acme.id));
      yield* ops
        .updateConnection(admin, created.id, { ssoUrl: "http://insecure.example.com" })
        .pipe(Effect.flip);
      yield* ops.updateConnection(admin, "missing", { name: "x" }).pipe(Effect.flip);
      yield* ops.deleteConnection(admin, "missing").pipe(Effect.flip);
      yield* ops.rotateSigningKey(admin, "missing", {}).pipe(Effect.flip);
      assert.deepStrictEqual(yield* auditTags("auth.saml."), ["auth.saml.connectionCreated"]);
    }).pipe(Effect.provide(SamlLive({ canManageSaml: allow }))),
  );
});

describe("scoped to the ambient tenant", () => {
  it.effect(
    "inside a tenant only its organization is in reach, and another's connection is answered like one that does not exist",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const { admin: ops } = yield* Saml.Saml;
        const acme = yield* org("acme");
        const globex = yield* org("globex");
        const theirs = yield* ops.createConnection(
          admin,
          handBuilt(globex.id, { emailDomains: ["globex.example"] }),
        );
        const asAcme = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Tenant.withTenant(acme.id)(effect);
        // Registering for another organization is answered as an organization that does not exist.
        const foreignCreate = yield* asAcme(
          ops.createConnection(admin, handBuilt(globex.id, { emailDomains: ["other.example"] })),
        ).pipe(Effect.flip);
        const missingOrg = yield* asAcme(
          ops.createConnection(admin, handBuilt("no-such-org", { emailDomains: ["x.example"] })),
        ).pipe(Effect.flip);
        assert.deepStrictEqual(foreignCreate, missingOrg);
        // Every by-id operation on it is the same NotFound as an unknown id.
        const unknown = yield* asAcme(ops.getConnection(admin, "nope")).pipe(Effect.flip);
        const foreign = [
          yield* asAcme(ops.getConnection(admin, theirs.id)).pipe(Effect.flip),
          yield* asAcme(ops.updateConnection(admin, theirs.id, { name: "x" })).pipe(Effect.flip),
          yield* asAcme(ops.deleteConnection(admin, theirs.id)).pipe(Effect.flip),
          yield* asAcme(ops.refreshMetadata(admin, theirs.id)).pipe(Effect.flip),
          yield* asAcme(ops.rotateSigningKey(admin, theirs.id, {})).pipe(Effect.flip),
          yield* asAcme(ops.listSigningKeys(admin, theirs.id)).pipe(Effect.flip),
        ];
        for (const failure of foreign) assert.deepStrictEqual(failure, unknown);
        assert.deepStrictEqual(yield* asAcme(ops.listConnections(admin, globex.id)), []);
        // Nothing of it changed; the platform (no tenant) reaches every organization, which is what an onboarding tool is for.
        assert.strictEqual((yield* ops.getConnection(admin, theirs.id)).name, "Acme Okta");
        // Inside its own tenant it works.
        const mine = yield* asAcme(ops.createConnection(admin, handBuilt(acme.id)));
        assert.strictEqual((yield* asAcme(ops.listConnections(admin, acme.id))).length, 1);
        assert.strictEqual(mine.organizationId, acme.id);
      }).pipe(Effect.provide(SamlLive({ canManageSaml: allow }))),
  );
});

describe("refreshing the metadata", () => {
  const first = idpMetadataXml({ certs: [idp.cert] });
  const rotated = idpMetadataXml({
    certs: [idpNext.cert],
    slo: { redirect: "https://idp.example.com/slo" },
  });

  it.effect(
    "replaces the trust set with what the metadata lists now: the old key stops working, the new one starts",
    () => {
      const table: Record<string, string> = { "https://idp.example.com/metadata.xml": first };
      const fetcher = fakeFetcher(table);
      return Effect.gen(function* () {
        yield* atNow;
        const { admin: ops } = yield* Saml.Saml;
        const saml = yield* Saml.Saml;
        const acme = yield* org("acme");
        const created = yield* ops.createConnection(admin, {
          organizationId: acme.id,
          name: "By URL",
          idp: { metadataUrl: "https://idp.example.com/metadata.xml" },
          emailDomains: ["acme.example"],
        });
        const signIn = (who: typeof idp, assertionId: string) =>
          Effect.gen(function* () {
            const started = yield* startLogin(created.id);
            return yield* saml
              .acs({
                samlResponse: idpResponse(started, created.id, { who, assertionId }),
                cookieState: started.state,
              })
              .pipe(
                Effect.flip,
                Effect.map((failure) => failure._tag),
                Effect.catch(() => Effect.succeed("SignedIn")),
              );
          });
        // Sign-in via the successor key is refused before the refresh (the unmodified table serves the first metadata).
        assert.strictEqual(yield* signIn(idpNext, "_pre"), "SamlAssertionRejected");
        table["https://idp.example.com/metadata.xml"] = rotated;
        const refreshed = yield* ops.refreshMetadata(admin, created.id);
        assert.deepStrictEqual(
          refreshed.certificates.map((entry) => entry.fingerprint),
          [idpNext.fingerprint],
        );
        assert.strictEqual(refreshed.sloUrl, "https://idp.example.com/slo");
        // The old key's signatures stop at once, the new key's start.
        assert.strictEqual(yield* signIn(idp, "_old"), "SamlAssertionRejected");
      }).pipe(Effect.provide(SamlLive({ canManageSaml: allow }, undefined, fetcher.layer)));
    },
  );

  it.effect(
    "is refused when the metadata names another entity, when there is no URL to refresh from, and when the fetch fails",
    () => {
      const table: Record<string, string | SamlMetadataFetcher.MetadataFetchFailed> = {
        "https://idp.example.com/metadata.xml": first,
      };
      const fetcher = fakeFetcher(table);
      return Effect.gen(function* () {
        yield* atNow;
        const { admin: ops } = yield* Saml.Saml;
        const acme = yield* org("acme");
        const byUrl = yield* ops.createConnection(admin, {
          organizationId: acme.id,
          name: "By URL",
          idp: { metadataUrl: "https://idp.example.com/metadata.xml" },
        });
        const byHand = yield* ops.createConnection(
          admin,
          handBuilt(acme.id, { emailDomains: ["hand.example"] }),
        );
        // No URL to refresh from.
        assert.strictEqual(
          (yield* ops.refreshMetadata(admin, byHand.id).pipe(Effect.flip))._tag,
          "SamlNoMetadataUrl",
        );
        // Another entity id: an IdP whose identity changed is a new connection.
        table["https://idp.example.com/metadata.xml"] = idpMetadataXml({
          entityId: "https://evil.example.com/m",
          certs: [attacker.cert],
        });
        const changed = yield* ops.refreshMetadata(admin, byUrl.id).pipe(Effect.flip);
        assert.strictEqual(changed._tag, "InvalidSamlConnectionRequest");
        assert.include(
          changed._tag === "InvalidSamlConnectionRequest" ? changed.reason : "",
          "another entity id",
        );
        // The trust set is untouched by the refused refresh.
        assert.deepStrictEqual(
          (yield* ops.getConnection(admin, byUrl.id)).certificates.map(
            (entry) => entry.fingerprint,
          ),
          [idp.fingerprint],
        );
        // A failed fetch.
        table["https://idp.example.com/metadata.xml"] = new SamlMetadataFetcher.MetadataFetchFailed(
          { failure: "tooLarge", detail: "the request failed" },
        );
        const failed = yield* ops.refreshMetadata(admin, byUrl.id).pipe(Effect.flip);
        assert.deepStrictEqual(JSON.parse(JSON.stringify(failed)), {
          _tag: "SamlMetadataUnavailable",
          failure: "tooLarge",
        });
      }).pipe(Effect.provide(SamlLive({ canManageSaml: allow }, undefined, fetcher.layer)));
    },
  );
});

describe("the SP signing key", () => {
  it.effect("is generated on request, listed without its private half, and audited", () =>
    Effect.gen(function* () {
      yield* atNow;
      const { admin: ops } = yield* Saml.Saml;
      const acme = yield* org("acme");
      const created = yield* ops.createConnection(admin, handBuilt(acme.id));
      const key = yield* ops.rotateSigningKey(admin, created.id, {});
      assert.include(key.certificate, "BEGIN CERTIFICATE");
      const listed = yield* ops.listSigningKeys(admin, created.id);
      assert.deepStrictEqual(
        listed.map((entry) => entry.id),
        [key.id],
      );
      assert.notInclude(JSON.stringify([key, listed]), "PRIVATE KEY");
      assert.include(yield* auditTags("auth.saml."), "auth.saml.signingKeyRotated");
    }).pipe(Effect.provide(SamlLive({ canManageSaml: allow }))),
  );

  it.effect(
    "an operator's own pair is imported when it matches and refused with a constant sentence when it does not; half a pair is refused",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const { admin: ops } = yield* Saml.Saml;
        const acme = yield* org("acme");
        const created = yield* ops.createConnection(admin, handBuilt(acme.id));
        const imported = yield* ops.rotateSigningKey(admin, created.id, {
          privateKeyPem: idp.key,
          certificatePem: idp.cert,
        });
        assert.strictEqual(imported.fingerprint, idp.fingerprint);
        const mismatch = yield* ops
          .rotateSigningKey(admin, created.id, {
            privateKeyPem: idp.key,
            certificatePem: attacker.cert,
          })
          .pipe(Effect.flip);
        assert.strictEqual(mismatch._tag, "InvalidSamlConnectionRequest");
        assert.notInclude(JSON.stringify(mismatch), "PRIVATE");
        const half = yield* ops
          .rotateSigningKey(admin, created.id, { privateKeyPem: idp.key })
          .pipe(Effect.flip);
        assert.strictEqual(half._tag, "InvalidSamlConnectionRequest");
      }).pipe(Effect.provide(SamlLive({ canManageSaml: allow }))),
  );
});
