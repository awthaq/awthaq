// BEH-EA-241 (spec/models/10-saml.md): `SamlConnectionStore` — what an organization may tell this server about its
// IdP. The certificates are the trust set; the SSO URL is a redirect target; a domain routes to one connection.
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import { inflateRawSync } from "node:zlib";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SamlConnections from "../src/SamlConnections.ts";
import * as SamlProtocol from "../src/SamlProtocol.ts";
import { ecdsa, idp, idpNext, NS, weakRsa } from "./samlFixtures.ts";
import { atNow, IDP_ENTITY_ID, SamlLive, seedConnection } from "./support.ts";
import { Api } from "@awthaq/api";
import { Organization } from "@awthaq/organization";

const metadataXml = (options: { readonly certs?: ReadonlyArray<string>; readonly entityId?: string; readonly redirect?: boolean } = {}) => {
  const body = (pem: string) => pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  return (
    `<?xml version="1.0"?><md:EntityDescriptor xmlns:md="${NS.md}" xmlns:ds="${NS.ds}" entityID="${options.entityId ?? IDP_ENTITY_ID}">` +
    `<md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">` +
    (options.certs ?? [idp.cert])
      .map((pem) => `<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${body(pem)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`)
      .join("") +
    (options.redirect === false
      ? `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.com/post"/>`
      : `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/sso"/>`) +
    `</md:IDPSSODescriptor></md:EntityDescriptor>`
  );
};

const owner = new Api.UserPrincipal({
  ref: new Api.PrincipalRef({ type: "user", id: "owner-1" }),
  sessionId: "owner-session",
});

const store = Effect.flatMap(SamlConnections.SamlConnectionStore, Effect.succeed);

/** The rule an `InvalidSamlConnection` names, or the tag of any other failure. */
const failure = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => ("reason" in error && typeof error.reason === "string" ? error.reason : error._tag)),
  );

describe("creating a connection", () => {
  it.effect("stores the trust set with each certificate's fingerprint and its own validity window", () =>
    Effect.gen(function* () {
      yield* atNow;
      const { connection } = yield* seedConnection({ certificates: [idp.cert, idpNext.cert] });
      assert.deepStrictEqual(
        connection.idpCertificates.map((entry) => entry.fingerprint),
        [idp.fingerprint, idpNext.fingerprint],
      );
      for (const entry of connection.idpCertificates) {
        assert.isAbove(DateTime.toEpochMillis(entry.notAfter), DateTime.toEpochMillis(entry.notBefore));
      }
      assert.strictEqual(connection.idpEntityId, IDP_ENTITY_ID);
      assert.deepStrictEqual(connection.emailDomains, ["acme.example"]);
      assert.isFalse(connection.trustsEmail);
    }).pipe(Effect.provide(SamlLive())),
  );

  it.effect("imports IdP metadata: entity id, redirect SSO URL and signing certificates become the connection", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const connections = yield* store;
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      const created = yield* connections.create({
        organizationId: org.id,
        name: "Imported",
        idp: { metadataXml: metadataXml({ certs: [idp.cert, idpNext.cert] }) },
      });
      assert.strictEqual(created.idpEntityId, IDP_ENTITY_ID);
      assert.strictEqual(created.ssoUrl, "https://idp.example.com/sso");
      assert.deepStrictEqual(created.idpCertificates.map((entry) => entry.fingerprint), [idp.fingerprint, idpNext.fingerprint]);
    }).pipe(Effect.provide(SamlLive())),
  );

  it.effect("refuses what would corrupt the trust boundary", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const connections = yield* store;
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      const base = { organizationId: org.id, name: "X" };
      const good = { entityId: IDP_ENTITY_ID, ssoUrl: "https://idp.example.com/sso", certificates: [idp.cert] };
      const refuse = (overrides: Partial<typeof good>, extra: { organizationId?: string; name?: string; emailDomains?: ReadonlyArray<string> } = {}) =>
        failure(connections.create({ ...base, ...extra, idp: { ...good, ...overrides } }));

      assert.include(yield* refuse({ ssoUrl: "http://idp.example.com/sso" }), "https");
      assert.include(yield* refuse({ ssoUrl: "javascript:alert(1)" }), "https");
      assert.include(yield* refuse({ ssoUrl: "https://169.254.169.254/sso" }), "private");
      assert.include(yield* refuse({ certificates: [] }), "at least one");
      assert.include(yield* refuse({ certificates: ["not a certificate"] }), "X.509");
      assert.include(yield* refuse({ entityId: "  " }), "entity id");
      assert.include(yield* refuse({}, { name: "  " }), "name");
      assert.include(yield* refuse({}, { organizationId: "no-such-org" }), "organization");
      assert.include(yield* refuse({}, { emailDomains: ["not a domain"] }), "not a valid email domain");
      // An RSA key under 2048 bits is not accepted as a signing key, and a non-RSA key cannot be verified at all.
      assert.include(yield* refuse({ certificates: [weakRsa.cert] }), "2048");
      assert.include(yield* refuse({ certificates: [ecdsa.cert] }), "RSA");
    }).pipe(Effect.provide(SamlLive())),
  );

  it.effect("metadata problems are refused by name: not metadata, no redirect binding, no certificate", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const connections = yield* store;
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      const refuse = (xml: string) =>
        failure(connections.create({ organizationId: org.id, name: "M", idp: { metadataXml: xml } }));
      assert.include(yield* refuse("<not-metadata/>"), "not SAML metadata");
      assert.include(yield* refuse(metadataXml({ redirect: false })), "HTTP-Redirect");
      assert.include(yield* refuse(metadataXml({ certs: [] })), "no signing certificate");
      // A DOCTYPE is refused before parsing (no XXE through the metadata import).
      assert.strictEqual(
        yield* refuse(`<!DOCTYPE m [<!ENTITY x SYSTEM "file:///etc/passwd">]>` + metadataXml()),
        "the metadata could not be read",
      );
    }).pipe(Effect.provide(SamlLive())),
  );

  it.effect("an email domain routes to one connection; discover finds it by domain or by organization", () =>
    Effect.gen(function* () {
      yield* atNow;
      const connections = yield* store;
      const { connection, organizationId } = yield* seedConnection({ slug: "acme", emailDomains: ["Acme.Example"] });
      // Domains are normalized to lower case.
      assert.deepStrictEqual(connection.emailDomains, ["acme.example"]);
      assert.deepStrictEqual(yield* connections.discover({ email: "ada@ACME.example" }), Option.some(connection.id));
      assert.deepStrictEqual(yield* connections.discover({ organizationId }), Option.some(connection.id));
      assert.isTrue(Option.isNone(yield* connections.discover({ email: "ada@nobody.example" })));
      assert.isTrue(Option.isNone(yield* connections.discover({ email: "no-at-sign" })));
      assert.isTrue(Option.isNone(yield* connections.discover({})));
      const organization = yield* Organization.Organization;
      const other = yield* organization.create({ caller: owner, name: "Other", slug: "other" });
      const clash = yield* failure(
        connections.create({
          organizationId: other.id,
          name: "Other",
          idp: { entityId: "https://other.example.com", ssoUrl: "https://other.example.com/sso", certificates: [idp.cert] },
          emailDomains: ["acme.example"],
        }),
      );
      assert.strictEqual(clash, "SamlDomainTaken");
    }).pipe(Effect.provide(SamlLive())),
  );
});

describe("changing and removing", () => {
  it.effect("update replaces the trust set whole (that is how a rotation retires a key) and revalidates", () =>
    Effect.gen(function* () {
      yield* atNow;
      const connections = yield* store;
      const { connection } = yield* seedConnection();
      const rotated = yield* connections.update(connection.id, { certificates: [idpNext.cert], trustsEmail: true, name: " Renamed " });
      assert.deepStrictEqual(rotated.idpCertificates.map((entry) => entry.fingerprint), [idpNext.fingerprint]);
      assert.strictEqual(rotated.name, "Renamed");
      assert.isTrue(rotated.trustsEmail);
      assert.include(yield* failure(connections.update(connection.id, { ssoUrl: "http://idp.example.com" })), "https");
      assert.include(yield* failure(connections.update(connection.id, { certificates: [] })), "at least one");
      assert.strictEqual(yield* failure(connections.update("nope", { name: "x" })), "SamlConnectionNotFound");
      // Nothing above changed what was stored.
      assert.deepStrictEqual((yield* connections.get(connection.id)).idpCertificates.map((entry) => entry.fingerprint), [idpNext.fingerprint]);
    }).pipe(Effect.provide(SamlLive())),
  );

  it.effect("remove deletes the connection; get and remove of an unknown id are typed not-found", () =>
    Effect.gen(function* () {
      yield* atNow;
      const connections = yield* store;
      const { connection, organizationId } = yield* seedConnection();
      yield* connections.remove(connection.id);
      assert.strictEqual(yield* failure(connections.get(connection.id)), "SamlConnectionNotFound");
      assert.strictEqual(yield* failure(connections.remove(connection.id)), "SamlConnectionNotFound");
      assert.deepStrictEqual(yield* connections.list(organizationId), []);
    }).pipe(Effect.provide(SamlLive())),
  );
});

describe("SamlProtocol", () => {
  it("escapes everything interpolated into the XML it produces", () => {
    const hostile = `"><script>alert(1)</script>&`;
    const xml = SamlProtocol.spMetadataXml({ entityId: hostile, acsUrl: hostile });
    assert.notInclude(xml, "<script>");
    assert.include(xml, "&quot;&gt;&lt;script&gt;");
    assert.strictEqual(SamlProtocol.escapeXml(`a&b<c>"d'`), "a&amp;b&lt;c&gt;&quot;d&apos;");
  });

  it("the redirect location carries a raw-DEFLATE, base64 SAMLRequest and an optional RelayState", () => {
    const location = SamlProtocol.redirectLocation("https://idp.example.com/sso?tenant=1", "<x/>", "state-1");
    const url = new URL(location);
    assert.strictEqual(url.searchParams.get("tenant"), "1");
    assert.strictEqual(url.searchParams.get("RelayState"), "state-1");
    const request = url.searchParams.get("SAMLRequest") ?? "";
    assert.strictEqual(inflateRawSync(Buffer.from(request, "base64")).toString("utf8"), "<x/>");
  });
});
