// BEH-EA-305: the SP's signing material and its two signature forms. A generated certificate must be a real, self-signed
// X.509 certificate the platform accepts; a redirect-binding signature must verify against the pinned certificate and against
// nothing else, and every tamper, downgrade and wrong-key case must fail; an XML signature must verify through the SAME
// `XmlSignature` port that verifies an IdP's.
import { XmlSignature } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import { X509Certificate } from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SamlKeys from "../src/SamlKeys.ts";
import * as XmlSignatureNode from "../src/XmlSignatureNode.ts";
import { attacker, idp, NOW, trustOf, ALGORITHM } from "./samlFixtures.ts";

const generate = SamlKeys.generateSigningKey({
  commonName: "sp.example.com",
  notBefore: DateTime.makeUnsafe(Date.UTC(2026, 0, 1)),
  validityDays: 3650,
});

const trustFor = (key: SamlKeys.SigningKey): XmlSignature.TrustSet => ({
  certificates: [
    {
      fingerprint: key.fingerprint,
      pem: key.certificatePem,
      notBefore: key.notBefore,
      notAfter: key.notAfter,
    },
  ],
});

describe("a generated signing key", () => {
  it.effect("is an RSA-2048 key with a valid self-signed X.509 certificate for it", () =>
    Effect.gen(function* () {
      const key = yield* generate;
      const certificate = new X509Certificate(key.certificatePem);
      assert.strictEqual(certificate.subject, "CN=sp.example.com");
      assert.strictEqual(certificate.issuer, "CN=sp.example.com");
      assert.isTrue(
        certificate.verify(certificate.publicKey),
        "self-signed: it verifies under its own key",
      );
      assert.strictEqual(certificate.publicKey.asymmetricKeyType, "rsa");
      assert.strictEqual(certificate.publicKey.asymmetricKeyDetails?.modulusLength, 2048);
      assert.isFalse(certificate.ca);
      assert.strictEqual(DateTime.toEpochMillis(key.notBefore), Date.UTC(2026, 0, 1));
      assert.strictEqual(
        DateTime.toEpochMillis(key.notAfter) - DateTime.toEpochMillis(key.notBefore),
        3650 * 86_400_000,
      );
      assert.match(key.fingerprint, /^[0-9a-f]{64}$/);
      assert.include(key.privateKeyPem, "BEGIN PRIVATE KEY");
    }),
  );

  it.effect("two generated keys are different keys with different certificates", () =>
    Effect.gen(function* () {
      const a = yield* generate;
      const b = yield* generate;
      assert.notStrictEqual(a.fingerprint, b.fingerprint);
      assert.notStrictEqual(a.privateKeyPem, b.privateKeyPem);
    }),
  );

  it.effect("a certificate with a notAfter past 2049 is a valid GeneralizedTime", () =>
    Effect.gen(function* () {
      const key = yield* SamlKeys.generateSigningKey({
        commonName: "far.example.com",
        notBefore: DateTime.makeUnsafe(Date.UTC(2040, 0, 1)),
        validityDays: 20_000,
      });
      assert.isAbove(DateTime.toEpochMillis(key.notAfter), Date.UTC(2050, 0, 1));
      assert.isTrue(
        new X509Certificate(key.certificatePem).verify(
          new X509Certificate(key.certificatePem).publicKey,
        ),
      );
    }),
  );
});

describe("describeSigningKey (a key an operator brings)", () => {
  it.effect("accepts a matching RSA pair and re-exports it as PKCS#8", () =>
    Effect.gen(function* () {
      const described = yield* SamlKeys.describeSigningKey(idp.key, idp.cert);
      assert.strictEqual(described.fingerprint, idp.fingerprint);
      assert.include(described.privateKeyPem, "BEGIN PRIVATE KEY");
    }),
  );

  it.effect(
    "refuses a certificate that is not for this key, and unreadable input, with a constant sentence",
    () =>
      Effect.gen(function* () {
        const mismatch = yield* SamlKeys.describeSigningKey(idp.key, attacker.cert).pipe(
          Effect.flip,
        );
        assert.include(mismatch.reason, "not the one for this private key");
        const garbage = yield* SamlKeys.describeSigningKey("not a key", idp.cert).pipe(Effect.flip);
        assert.include(garbage.reason, "could not be read");
        assert.notInclude(garbage.reason, "not a key");
        const noCertificate = yield* SamlKeys.describeSigningKey(idp.key, "nope").pipe(Effect.flip);
        assert.include(noCertificate.reason, "could not be read");
      }),
  );
});

describe("redirect-binding signatures", () => {
  const sign = (key: SamlKeys.SigningKey, relayState?: string) =>
    SamlKeys.signRedirect({
      kind: "SAMLRequest",
      message: "fZHNTsMwEIT7SjlXcrO9KkWR6xJpoFJKaVoO4zbJ0shg81lW5PNNYo=+/==",
      relayState,
      privateKeyPem: key.privateKeyPem,
    });

  const partsOf = (query: string) => {
    const raw = Object.fromEntries(
      query.split("&").map((pair) => pair.split(/=(.*)/s).slice(0, 2)),
    );
    const octets = query.slice(0, query.lastIndexOf("&Signature="));
    return {
      octets,
      signature: decodeURIComponent(String(raw["Signature"])),
      sigAlg: decodeURIComponent(String(raw["SigAlg"])),
    };
  };

  it.effect("verifies against the pinned certificate over the exact signed octets", () =>
    Effect.gen(function* () {
      const key = yield* generate;
      const { octets, signature, sigAlg } = partsOf(sign(key, "state /1"));
      assert.strictEqual(sigAlg, SamlKeys.SIG_ALG_RSA_SHA256);
      assert.isTrue(
        SamlKeys.verifyRedirect({ octets, signature, sigAlg, trust: trustFor(key), now: NOW }),
      );
      // The octets are the raw encoded parameters in the mandated order, RelayState between the message and SigAlg.
      assert.match(
        octets,
        /^SAMLRequest=.+&RelayState=state%20%2F1&SigAlg=http%3A%2F%2Fwww\.w3\.org/,
      );
    }),
  );

  it.effect(
    "refuses any change to the signed octets, another key, an unpinned certificate and an expired one",
    () =>
      Effect.gen(function* () {
        const key = yield* generate;
        const other = yield* generate;
        const { octets, signature, sigAlg } = partsOf(sign(key));
        const trust = trustFor(key);
        const verify = (over: Partial<Parameters<typeof SamlKeys.verifyRedirect>[0]>) =>
          SamlKeys.verifyRedirect({ octets, signature, sigAlg, trust, now: NOW, ...over });
        assert.isTrue(verify({}));
        // A changed message, a dropped or added RelayState, a re-ordered parameter.
        assert.isFalse(verify({ octets: octets.replace("SAMLRequest=fZ", "SAMLRequest=fY") }));
        assert.isFalse(verify({ octets: octets.replace("&SigAlg", "&RelayState=x&SigAlg") }));
        assert.isFalse(verify({ octets: octets.split("&").toReversed().join("&") }));
        // Another key's signature, and a trust set that does not contain the signer.
        assert.isFalse(verify({ trust: trustFor(other) }));
        assert.isFalse(verify({ trust: trustOf(idp) }));
        assert.isFalse(verify({ trust: { certificates: [] } }));
        // The pinned certificate is outside its validity window.
        assert.isFalse(
          verify({ now: DateTime.makeUnsafe(DateTime.toEpochMillis(key.notAfter) + 1) }),
        );
        assert.isFalse(
          verify({ now: DateTime.makeUnsafe(DateTime.toEpochMillis(key.notBefore) - 1) }),
        );
        // A garbled signature.
        assert.isFalse(verify({ signature: "AAAA" }));
        assert.isFalse(verify({ signature: "" }));
      }),
  );

  it.effect(
    "refuses a downgraded or unknown SigAlg even when the octets and signature are otherwise right",
    () =>
      Effect.gen(function* () {
        const key = yield* generate;
        const { octets, signature } = partsOf(sign(key));
        for (const sigAlg of [
          ALGORITHM.rsaSha1,
          "http://www.w3.org/2001/04/xmldsig-more#hmac-sha256",
          "http://www.w3.org/2000/09/xmldsig#dsa-sha1",
          "",
          "RSA-SHA256",
        ]) {
          assert.isFalse(
            SamlKeys.verifyRedirect({ octets, signature, sigAlg, trust: trustFor(key), now: NOW }),
            sigAlg,
          );
        }
      }),
  );

  it.effect("an unsigned redirect has no Signature and no SigAlg", () =>
    Effect.sync(() => {
      const query = SamlKeys.plainRedirect({
        kind: "SAMLResponse",
        message: "abc+/=",
        relayState: "r",
      });
      assert.strictEqual(query, "SAMLResponse=abc%2B%2F%3D&RelayState=r");
    }),
  );
});

describe("XML signatures over the POST binding", () => {
  const message =
    `<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ` +
    `ID="_logout1" Version="2.0" IssueInstant="2026-09-29T12:00:00Z">` +
    `<saml:Issuer>https://sp.example.com/auth/saml/sp/c1</saml:Issuer>` +
    `<saml:NameID>ada@acme.example</saml:NameID></samlp:LogoutRequest>`;
  const policy: XmlSignature.VerifyPolicy = {
    signedElements: [
      { namespace: "urn:oasis:names:tc:SAML:2.0:protocol", localName: "LogoutRequest" },
    ],
    exactlyOne: [{ namespace: "urn:oasis:names:tc:SAML:2.0:protocol", localName: "LogoutRequest" }],
    now: NOW,
  };

  it.effect(
    "verifies through the same XmlSignature port that verifies an IdP's, under the SP certificate",
    () =>
      Effect.gen(function* () {
        const key = yield* generate;
        const signed = SamlKeys.signXml({
          xml: message,
          referenceId: "_logout1",
          privateKeyPem: key.privateKeyPem,
        });
        const verified = yield* XmlSignatureNode.verifyAt(
          { xml: signed, trust: trustFor(key), policy },
          NOW,
        );
        assert.strictEqual(verified.signedId, "_logout1");
        assert.strictEqual(verified.signatureAlgorithm, SamlKeys.SIG_ALG_RSA_SHA256);
        assert.strictEqual(verified.certificateFingerprint, key.fingerprint);
        // The signature is placed right after the Issuer, as the schema wants, and carries no KeyInfo.
        assert.match(signed, /<\/saml:Issuer><ds:Signature/);
        assert.notInclude(signed, "KeyInfo");
      }),
  );

  it.effect("does not verify under another key, and a tampered body no longer verifies", () =>
    Effect.gen(function* () {
      const key = yield* generate;
      const signed = SamlKeys.signXml({
        xml: message,
        referenceId: "_logout1",
        privateKeyPem: key.privateKeyPem,
      });
      const wrongKey = yield* XmlSignatureNode.verifyAt(
        { xml: signed, trust: trustOf(idp), policy },
        NOW,
      ).pipe(Effect.flip);
      assert.include(["untrustedKey", "noTrustedCertificate", "invalidSignature"], wrongKey.reason);
      const tampered = signed.replace("ada@acme.example", "root@acme.example");
      const failure = yield* XmlSignatureNode.verifyAt(
        { xml: tampered, trust: trustFor(key), policy },
        NOW,
      ).pipe(Effect.flip);
      assert.strictEqual(failure.reason, "invalidSignature");
    }),
  );
});
