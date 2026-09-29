// BEH-EA-305 (spec/behaviors/29-saml-sp.md): signed AuthnRequests. A connection that signs sends a redirect-binding request
// whose query signature verifies under the SP certificate its metadata publishes, and under nothing else; the private key is
// stored sealed (Encryption, AAD naming the key), the newest unexpired key signs while every unexpired certificate is
// published, and a connection that says it signs NEVER sends an unsigned request, whatever happens to its key.
import { Encryption } from "@awthaq/ports";
import { X509Certificate } from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as Saml from "../src/Saml.ts";
import * as SamlConnections from "../src/SamlConnections.ts";
import * as SamlKeys from "../src/SamlKeys.ts";
import * as SamlRecords from "../src/SamlRecords.ts";
import * as SamlSpKeys from "../src/SamlSpKeys.ts";
import { ALGORITHM, attacker, idp } from "./samlFixtures.ts";
import { certificatesInSpMetadata, idpMetadataXml, redirectParts } from "./samlMetadata.ts";
import { atNow, SamlLive, seedConnection, startLogin } from "./support.ts";

const trustFromPem = (pem: string) => {
  const certificate = new X509Certificate(pem);
  return {
    fingerprint: certificate.fingerprint256.replaceAll(":", "").toLowerCase(),
    pem,
    notBefore: DateTime.makeUnsafe(certificate.validFromDate),
    notAfter: DateTime.makeUnsafe(certificate.validToDate),
  };
};

/** Does the signature in `location` verify under `pems`, judged at the current test time? */
const verifiesUnder = (location: string, pems: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const parts = redirectParts(location);
    if (parts.octets === undefined || parts.signature === undefined || parts.sigAlg === undefined)
      return false;
    return SamlKeys.verifyRedirect({
      octets: parts.octets,
      signature: parts.signature,
      sigAlg: parts.sigAlg,
      trust: { certificates: pems.map(trustFromPem) },
      now: yield* DateTime.now,
    });
  });

describe("a connection that does not sign", () => {
  it.effect("sends no signature, and its metadata says so and publishes no key", () =>
    Effect.gen(function* () {
      yield* atNow;
      const saml = yield* Saml.Saml;
      const { connection } = yield* seedConnection();
      const started = yield* startLogin(connection.id);
      const parts = redirectParts(started.location);
      assert.isUndefined(parts.sigAlg);
      assert.isUndefined(parts.signature);
      const metadata = yield* saml.metadata(connection.id);
      assert.include(metadata, 'AuthnRequestsSigned="false"');
      assert.deepStrictEqual(certificatesInSpMetadata(metadata), []);
    }).pipe(Effect.provide(SamlLive())),
  );
});

describe("a connection that signs its AuthnRequests", () => {
  it.effect(
    "sends a request whose signature verifies under the certificate in its own metadata",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const saml = yield* Saml.Saml;
        const { connection } = yield* seedConnection({ authnRequestsSigned: true });
        const started = yield* startLogin(connection.id, "/dashboard");
        const parts = redirectParts(started.location);
        assert.strictEqual(parts.sigAlg, SamlKeys.SIG_ALG_RSA_SHA256);
        assert.isDefined(parts.signature);
        // The octets are the raw encoded parameters in the mandated order.
        assert.match(
          parts.octets ?? "",
          /^SAMLRequest=[^&]+&SigAlg=http%3A%2F%2Fwww\.w3\.org%2F2001%2F04%2Fxmldsig-more%23rsa-sha256$/,
        );
        const metadata = yield* saml.metadata(connection.id);
        assert.include(metadata, 'AuthnRequestsSigned="true"');
        const published = certificatesInSpMetadata(metadata);
        assert.strictEqual(published.length, 1);
        assert.isTrue(yield* verifiesUnder(started.location, published));
        // The request body itself is unchanged by signing: it still names this SP and ACS.
        assert.include(started.authnRequest, "AssertionConsumerServiceURL=");
      }).pipe(Effect.provide(SamlLive())),
  );

  it.effect(
    "does not verify after any change, under another key, or under a downgraded algorithm",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const saml = yield* Saml.Saml;
        const { connection } = yield* seedConnection({ authnRequestsSigned: true });
        const started = yield* startLogin(connection.id);
        const published = certificatesInSpMetadata(yield* saml.metadata(connection.id));
        const parts = redirectParts(started.location);
        assert.isTrue(yield* verifiesUnder(started.location, published));
        // A changed message.
        const tampered = started.location.replace(parts.message.slice(0, 8), "AAAAAAAA");
        assert.isFalse(yield* verifiesUnder(tampered, published));
        // Another key: the IdP's own certificate, and an attacker's.
        assert.isFalse(yield* verifiesUnder(started.location, [idp.cert]));
        assert.isFalse(yield* verifiesUnder(started.location, [attacker.cert]));
        // The signature does not cover a different SigAlg: swapping to SHA-1 (or anything off the allow-list) is refused.
        const downgraded = started.location.replace(
          encodeURIComponent(SamlKeys.SIG_ALG_RSA_SHA256),
          encodeURIComponent(ALGORITHM.rsaSha1),
        );
        assert.isFalse(yield* verifiesUnder(downgraded, published));
      }).pipe(Effect.provide(SamlLive())),
  );

  it.effect(
    "has a signing key generated when signing is switched on, and only one however often it is updated",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const store = yield* SamlConnections.SamlConnectionStore;
        const keys = yield* SamlSpKeys.SamlSpKeys;
        const { connection } = yield* seedConnection();
        assert.deepStrictEqual(yield* keys.list(connection.id), []);
        yield* store.update(connection.id, { authnRequestsSigned: true });
        assert.strictEqual((yield* keys.list(connection.id)).length, 1);
        yield* store.update(connection.id, { authnRequestsSigned: true, name: "renamed" });
        assert.strictEqual((yield* keys.list(connection.id)).length, 1);
        // Switching it off keeps the key (a logout is still signed with it), and stops signing requests.
        yield* store.update(connection.id, { authnRequestsSigned: false });
        assert.strictEqual((yield* keys.list(connection.id)).length, 1);
      }).pipe(Effect.provide(SamlLive())),
  );

  it.effect("an IdP that asks for signed requests in its metadata gets them by default", () =>
    Effect.gen(function* () {
      yield* atNow;
      const store = yield* SamlConnections.SamlConnectionStore;
      const keys = yield* SamlSpKeys.SamlSpKeys;
      const { organizationId } = yield* seedConnection();
      const created = yield* store.create({
        organizationId,
        name: "Wants signed",
        idp: {
          metadataXml: idpMetadataXml({
            wantAuthnRequestsSigned: true,
            entityId: "https://strict.example.com/m",
          }),
        },
      });
      assert.isTrue(created.authnRequestsSigned);
      assert.strictEqual((yield* keys.list(created.id)).length, 1);
      const optedOut = yield* store.create({
        organizationId,
        name: "Opted out",
        idp: {
          metadataXml: idpMetadataXml({
            wantAuthnRequestsSigned: true,
            entityId: "https://strict2.example.com/m",
          }),
        },
        authnRequestsSigned: false,
      });
      assert.isFalse(optedOut.authnRequestsSigned);
    }).pipe(Effect.provide(SamlLive())),
  );
});

describe("the SP signing key at rest", () => {
  it.effect(
    "is stored only sealed, under an AAD that names the key: it opens there and nowhere else",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const records = yield* SamlRecords.SamlRecords;
        const encryption = yield* Encryption.Encryption;
        const { connection } = yield* seedConnection({ authnRequestsSigned: true });
        const [row] = yield* records.listSpKeys(connection.id);
        if (row === undefined) return assert.fail("no key");
        assert.notInclude(row.privateKey, "PRIVATE KEY");
        assert.notInclude(JSON.stringify(row), "PRIVATE KEY");
        const opened = yield* encryption.decrypt(row.privateKey, SamlSpKeys.aad(row.id));
        assert.include(Redacted.value(opened.plaintext), "BEGIN PRIVATE KEY");
        // Copied into another key's row, or under another field, it does not decrypt.
        const elsewhere = yield* encryption
          .decrypt(row.privateKey, SamlSpKeys.aad("some-other-key"))
          .pipe(Effect.flip);
        assert.isDefined(elsewhere);
        // The public API of the key service never returns the private half.
        const keys = yield* SamlSpKeys.SamlSpKeys;
        assert.notInclude(JSON.stringify(yield* keys.list(connection.id)), "PRIVATE KEY");
      }).pipe(Effect.provide(SamlLive())),
  );

  it.effect(
    "a key that no longer opens makes the login fail closed: never an unsigned request",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const saml = yield* Saml.Saml;
        const records = yield* SamlRecords.SamlRecords;
        const { connection } = yield* seedConnection({ authnRequestsSigned: true });
        const [row] = yield* records.listSpKeys(connection.id);
        if (row === undefined) return assert.fail("no key");
        // A newer row whose sealed key belongs to another key: it is the one that would sign, and it cannot be opened.
        yield* records.saveSpKey({
          id: "swapped",
          connectionId: connection.id,
          certificate: row.certificate,
          privateKey: row.privateKey,
          fingerprint: row.fingerprint,
          notBefore: row.notBefore,
          notAfter: row.notAfter,
        });
        yield* TestClock.adjust(Duration.seconds(1));
        const exit = yield* Effect.exit(saml.authnRequest(connection.id, {}));
        assert.isTrue(Exit.isFailure(exit));
        assert.isTrue(
          Exit.isFailure(exit) && Exit.hasDies(exit),
          "a defect, not a typed error a caller could shrug off",
        );
      }).pipe(Effect.provide(SamlLive())),
  );

  it.effect("when every key has expired a signing connection fails closed too", () =>
    Effect.gen(function* () {
      yield* atNow;
      const saml = yield* Saml.Saml;
      const { connection } = yield* seedConnection({ authnRequestsSigned: true });
      assert.isTrue(Exit.isSuccess(yield* Effect.exit(saml.authnRequest(connection.id, {}))));
      yield* TestClock.adjust(Duration.days(3));
      const exit = yield* Effect.exit(saml.authnRequest(connection.id, {}));
      assert.isTrue(Exit.isFailure(exit) && Exit.hasDies(exit));
    }).pipe(Effect.provide(SamlLive({ signingKeyValidityDays: 2 }))),
  );
});

describe("rotating the SP signing key", () => {
  it.effect(
    "the new key signs from then on, and the previous certificate stays published until it expires",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const saml = yield* Saml.Saml;
        const keys = yield* SamlSpKeys.SamlSpKeys;
        const { connection } = yield* seedConnection({ authnRequestsSigned: true });
        const before = certificatesInSpMetadata(yield* saml.metadata(connection.id));
        const first = yield* startLogin(connection.id);
        assert.isTrue(yield* verifiesUnder(first.location, before));
        yield* TestClock.adjust(Duration.seconds(5));
        yield* keys.generate(connection.id);
        const after = certificatesInSpMetadata(yield* saml.metadata(connection.id));
        assert.strictEqual(
          after.length,
          2,
          "both certificates are published: an IdP that has not refreshed still trusts the old one",
        );
        const second = yield* startLogin(connection.id);
        const newest = after.filter((pem) => !before.includes(pem));
        assert.isTrue(yield* verifiesUnder(second.location, newest));
        assert.isFalse(
          yield* verifiesUnder(second.location, before),
          "the newest key signs, not the old one",
        );
      }).pipe(Effect.provide(SamlLive())),
  );

  it.effect(
    "an operator's own key pair is used when it matches, and refused with a constant sentence when it does not",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const keys = yield* SamlSpKeys.SamlSpKeys;
        const saml = yield* Saml.Saml;
        const { connection } = yield* seedConnection({ authnRequestsSigned: true });
        yield* TestClock.adjust(Duration.seconds(5));
        yield* keys.importKey(connection.id, {
          privateKeyPem: Redacted.make(idp.key),
          certificatePem: idp.cert,
        });
        const started = yield* startLogin(connection.id);
        // The fixture certificate is valid at the fixtures' NOW: the imported key is the newest one and signs.
        assert.isTrue(yield* verifiesUnder(started.location, [idp.cert]));
        const mismatch = yield* keys
          .importKey(connection.id, {
            privateKeyPem: Redacted.make(idp.key),
            certificatePem: attacker.cert,
          })
          .pipe(Effect.flip);
        assert.include(mismatch.reason, "not the one for this private key");
        assert.isTrue((yield* saml.metadata(connection.id)).includes("X509Certificate"));
        // Nothing about the key material leaks into the refusal.
        assert.notInclude(JSON.stringify(mismatch), "PRIVATE");
      }).pipe(Effect.provide(SamlLive())),
  );
});
