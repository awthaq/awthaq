// SFS-003, BEH-EA-238/239/240 (spec/behaviors/29-saml-sp.md): the `XmlSignature` port's Node adapter.
// The valid paths first (Assertion-, Response- and doubly-signed documents, SHA-256/512, rotation overlap),
// then the negative corpus: everything the SAML security literature does to a signed document, each refused
// by NAME — so a regression fails as "expected duplicateId, got invalidSignature", not as a vague false.
import { XmlSignature } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SafeXml from "../src/SafeXml.ts";
import * as XmlSignatureNode from "../src/XmlSignatureNode.ts";
import {
  ALGORITHM,
  ASSERTION,
  attacker,
  cloneOf,
  edit,
  elementsNamed,
  first,
  idp,
  idpNext,
  NOT_AFTER,
  NOT_BEFORE,
  NOW,
  NS,
  parseDom,
  RESPONSE,
  responseXml,
  samlPolicy,
  serialize,
  signedResponse,
  trustOf,
  verifyWith,
} from "./samlFixtures.ts";

/** The failure `reason` of a verification that must fail. */
const refusal = (xml: string, trust = trustOf(idp), policy = samlPolicy) =>
  verifyWith(xml, trust, policy).pipe(
    Effect.flip,
    Effect.map((failure) => failure.reason),
  );

const NAME_ID = "ada@acme.example";

describe("valid documents verify, and yield only the signed element", () => {
  it.effect("an Assertion-signed Response returns the Assertion's canonical bytes", () =>
    Effect.gen(function* () {
      const verified = yield* verifyWith(signedResponse(responseXml()), trustOf(idp));
      assert.strictEqual(verified.signedElement.localName, "Assertion");
      assert.strictEqual(verified.signedId, "_assert1");
      assert.strictEqual(verified.signatureAlgorithm, ALGORITHM.rsaSha256);
      assert.strictEqual(verified.digestAlgorithm, ALGORITHM.sha256);
      assert.strictEqual(verified.certificateFingerprint, idp.fingerprint);
      assert.include(verified.signedXml, NAME_ID);
      // Nothing from outside the Assertion: not the Response's attributes, not its Status.
      assert.notInclude(verified.signedXml, "samlp:Status");
      assert.notInclude(verified.signedXml, "Destination");
      // Canonical form has no XML declaration and no comments.
      assert.notInclude(verified.signedXml, "<?xml");
    }),
  );

  it.effect("a Response-signed document returns the whole Response, Assertion inside", () =>
    Effect.gen(function* () {
      const verified = yield* verifyWith(signedResponse(responseXml(), { target: "response" }), trustOf(idp));
      assert.strictEqual(verified.signedElement.localName, "Response");
      assert.strictEqual(verified.signedId, "_resp1");
      assert.include(verified.signedXml, "samlp:Status");
      assert.include(verified.signedXml, NAME_ID);
    }),
  );

  it.effect("a doubly-signed document is verified at both levels and reports the policy's first choice (the Assertion)", () =>
    Effect.gen(function* () {
      const verified = yield* verifyWith(signedResponse(responseXml(), { target: "both" }), trustOf(idp));
      assert.strictEqual(verified.signedElement.localName, "Assertion");
    }),
  );

  it.effect("RSA-SHA512 with a SHA-512 digest is accepted", () =>
    Effect.gen(function* () {
      const xml = signedResponse(responseXml(), {
        signatureAlgorithm: ALGORITHM.rsaSha512,
        digestAlgorithm: ALGORITHM.sha512,
      });
      const verified = yield* verifyWith(xml, trustOf(idp));
      assert.strictEqual(verified.signatureAlgorithm, ALGORITHM.rsaSha512);
    }),
  );

  it.effect("a document without KeyInfo verifies against the pinned certificate", () =>
    Effect.gen(function* () {
      yield* verifyWith(signedResponse(responseXml(), { keyInfo: false }), trustOf(idp));
    }),
  );

  it.effect("the port layer verifies too (the fused entry point an application provides)", () =>
    Effect.gen(function* () {
      const port = yield* XmlSignature.XmlSignature;
      const verified = yield* port.verify({
        xml: signedResponse(responseXml()),
        trust: trustOf(idp),
        policy: { ...samlPolicy },
      });
      assert.strictEqual(verified.signedId, "_assert1");
    }).pipe(Effect.provide(XmlSignatureNode.layer)),
  );
});

describe("pinning and rotation", () => {
  it.effect("an unpinned signer is refused, whether or not the document names its certificate", () =>
    Effect.gen(function* () {
      const forged = signedResponse(responseXml(), { who: attacker });
      // The document carries the attacker's certificate in KeyInfo: not pinned, so refused by name ...
      assert.strictEqual(yield* refusal(forged), "untrustedKey");
      // ... and stripping KeyInfo cannot help: the pinned key simply does not verify it.
      const stripped = signedResponse(responseXml(), { who: attacker, keyInfo: false });
      assert.strictEqual(yield* refusal(stripped), "invalidSignature");
    }),
  );

  it.effect("the KeyInfo certificate is never a key source: a document naming the pinned cert but signed by another key fails", () =>
    Effect.gen(function* () {
      // Signed by the attacker's key, but KeyInfo claims the IdP's certificate.
      const signed = signedResponse(responseXml(), { who: attacker });
      const lying = signed
        .replace(/<ds:X509Certificate>[^<]*<\/ds:X509Certificate>/, () => {
          const body = idp.cert.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
          return `<ds:X509Certificate>${body}</ds:X509Certificate>`;
        });
      assert.strictEqual(yield* refusal(lying), "invalidSignature");
    }),
  );

  it.effect("a KeyInfo listing the attacker's certificate first and the pinned one second is refused (the first-certificate trick)", () =>
    Effect.gen(function* () {
      const body = (pem: string) => pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
      const signed = signedResponse(responseXml(), { who: attacker });
      const doctored = signed.replace(
        /<ds:X509Certificate>[^<]*<\/ds:X509Certificate>/,
        `<ds:X509Certificate>${body(attacker.cert)}</ds:X509Certificate></ds:X509Data><ds:X509Data><ds:X509Certificate>${body(idp.cert)}</ds:X509Certificate>`,
      );
      assert.notStrictEqual(doctored, signed);
      assert.strictEqual(yield* refusal(doctored), "untrustedKey");
    }),
  );

  it.effect("a rotation overlap trusts both certificates; each verifies its own signatures", () =>
    Effect.gen(function* () {
      const both = trustOf(idp, idpNext);
      yield* verifyWith(signedResponse(responseXml(), { who: idp }), both);
      const next = yield* verifyWith(signedResponse(responseXml(), { who: idpNext }), both);
      assert.strictEqual(next.certificateFingerprint, idpNext.fingerprint);
      // Retiring the old certificate from the trust set stops its signatures at once.
      assert.strictEqual(yield* refusal(signedResponse(responseXml(), { who: idp }), trustOf(idpNext)), "untrustedKey");
    }),
  );

  it.effect("a certificate outside its notBefore/notAfter window is not trusted, at either end", () =>
    Effect.gen(function* () {
      const early = {
        certificates: [{ fingerprint: idp.fingerprint, pem: idp.cert, notBefore: DateTime.addDuration(NOW, "1 day"), notAfter: NOT_AFTER }],
      };
      const expired = {
        certificates: [{ fingerprint: idp.fingerprint, pem: idp.cert, notBefore: NOT_BEFORE, notAfter: DateTime.subtractDuration(NOW, "1 day") }],
      };
      const xml = signedResponse(responseXml());
      assert.strictEqual(yield* refusal(xml, early), "noTrustedCertificate");
      assert.strictEqual(yield* refusal(xml, expired), "noTrustedCertificate");
      // notAfter is exclusive.
      const edge = {
        certificates: [{ fingerprint: idp.fingerprint, pem: idp.cert, notBefore: NOT_BEFORE, notAfter: NOW }],
      };
      assert.strictEqual(yield* refusal(xml, edge), "noTrustedCertificate");
    }),
  );

  it.effect("a trust entry whose declared fingerprint is not its certificate's is never trusted", () =>
    Effect.gen(function* () {
      const wrong = {
        certificates: [{ fingerprint: attacker.fingerprint, pem: idp.cert, notBefore: NOT_BEFORE, notAfter: NOT_AFTER }],
      };
      assert.strictEqual(yield* refusal(signedResponse(responseXml(), { keyInfo: false }), wrong), "noTrustedCertificate");
    }),
  );

  it.effect("an empty trust set trusts nothing", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* refusal(signedResponse(responseXml(), { keyInfo: false }), { certificates: [] }), "noTrustedCertificate");
    }),
  );
});

describe("tampering", () => {
  it.effect("changing a signed value after signing (the NameID, an attribute, a time) is refused", () =>
    Effect.gen(function* () {
      const signed = signedResponse(responseXml());
      for (const tampered of [
        signed.replace(NAME_ID + "</saml:NameID>", "admin@acme.example</saml:NameID>"),
        signed.replace("<saml:AttributeValue>eng</saml:AttributeValue>", "<saml:AttributeValue>root</saml:AttributeValue>"),
        signed.replace("2026-09-29T12:05:00Z", "2036-09-29T12:05:00Z"),
      ]) {
        assert.notStrictEqual(tampered, signed);
        assert.strictEqual(yield* refusal(tampered), "invalidSignature");
      }
    }),
  );

  it.effect("changing the digest or the signature value is refused", () =>
    Effect.gen(function* () {
      const signed = signedResponse(responseXml());
      const flip = (tag: string) =>
        signed.replace(new RegExp(`(<ds:${tag}>)([A-Za-z0-9+/])`), (_m, open: string, ch: string) =>
          `${open}${ch === "A" ? "B" : "A"}`,
        );
      assert.strictEqual(yield* refusal(flip("DigestValue")), "invalidSignature");
      assert.strictEqual(yield* refusal(flip("SignatureValue")), "invalidSignature");
    }),
  );

  it.effect("an unsigned document, or one whose signature was stripped, is refused", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* refusal(responseXml()), "noSignature");
      const stripped = edit(signedResponse(responseXml()), (document) => {
        for (const signature of elementsNamed(document, NS.ds, "Signature")) signature.parentNode?.removeChild(signature);
      });
      assert.strictEqual(yield* refusal(stripped), "noSignature");
    }),
  );
});

describe("signature wrapping (XSW): the Somorovsky et al. patterns, refused by structure and by construction", () => {
  /** A forged Assertion: the signed one, edited to name an administrator, with a new ID. */
  const forge = (original: Element, id: string): Element => {
    const forged = cloneOf(original);
    forged.setAttribute("ID", id);
    for (const child of Array.from(forged.childNodes)) {
      if (child.nodeType === 1 && (child as Element).localName === "Signature") forged.removeChild(child);
    }
    const nameId = first(Array.from(forged.getElementsByTagNameNS(NS.saml, "NameID")), "NameID");
    nameId.textContent = "admin@acme.example";
    return forged;
  };

  const withAssertion = (change: (document: Document, assertion: Element, response: Element) => void) =>
    edit(signedResponse(responseXml()), (document) => {
      const assertion = first(elementsNamed(document, NS.saml, "Assertion"), "Assertion");
      const response = first(elementsNamed(document, NS.samlp, "Response"), "Response");
      change(document, assertion, response);
    });

  it.effect("XSW-3: a forged assertion inserted before the signed one (two assertions)", () =>
    Effect.gen(function* () {
      const xml = withAssertion((_d, assertion, response) => {
        response.insertBefore(forge(assertion, "_evil"), assertion);
      });
      assert.strictEqual(yield* refusal(xml), "cardinality");
    }),
  );

  it.effect("defence in depth: with the cardinality rule OFF, a forged extra assertion is still never what comes back", () =>
    Effect.gen(function* () {
      const xml = withAssertion((_d, assertion, response) => {
        response.insertBefore(forge(assertion, "_evil"), assertion);
      });
      const lax = { ...samlPolicy, exactlyOne: [] };
      const verified = yield* verifyWith(xml, trustOf(idp), lax);
      // Only the bytes the signature covers: the genuine NameID, and not the forged one.
      assert.include(verified.signedXml, NAME_ID);
      assert.notInclude(verified.signedXml, "admin@acme.example");
      assert.notInclude(verified.signedXml, "_evil");
    }),
  );

  it.effect("XSW-4: the signed assertion nested inside a forged one", () =>
    Effect.gen(function* () {
      const xml = withAssertion((_d, assertion, response) => {
        const evil = forge(assertion, "_evil");
        response.replaceChild(evil, assertion);
        evil.appendChild(assertion);
      });
      assert.strictEqual(yield* refusal(xml), "cardinality");
    }),
  );

  it.effect("XSW-5/6: the original moved into Extensions/Advice while a forged one takes its place", () =>
    Effect.gen(function* () {
      for (const holder of ["Extensions", "Advice"]) {
        const xml = withAssertion((document, assertion, response) => {
          const wrapper = document.createElementNS(holder === "Extensions" ? NS.samlp : NS.saml, holder);
          const evil = forge(assertion, "_evil");
          response.replaceChild(evil, assertion);
          wrapper.appendChild(assertion);
          response.appendChild(wrapper);
        });
        assert.strictEqual(yield* refusal(xml), "cardinality", holder);
      }
    }),
  );

  it.effect("XSW-8: the original parked inside a ds:Object of the Signature", () =>
    Effect.gen(function* () {
      const xml = withAssertion((document, assertion, response) => {
        const signature = cloneOf(first(elementsNamed(document, NS.ds, "Signature"), "Signature"));
        const object = document.createElementNS(NS.ds, "ds:Object");
        const evil = forge(assertion, "_evil");
        response.replaceChild(evil, assertion);
        object.appendChild(assertion);
        signature.appendChild(object);
        evil.appendChild(signature);
      });
      // The forged assertion carries the signature, the original hides in its Object: two assertions, refused before crypto.
      assert.strictEqual(yield* refusal(xml), "cardinality");
    }),
  );

  it.effect("even with cardinality satisfied, the Signature must be a CHILD of the element it signs", () =>
    Effect.gen(function* () {
      // Response-signed document; the Signature is moved out of the Response into the (only) Assertion.
      const signed = signedResponse(responseXml(), { target: "response" });
      const moved = edit(signed, (document) => {
        const signature = first(elementsNamed(document, NS.ds, "Signature"), "Signature");
        const assertion = first(elementsNamed(document, NS.saml, "Assertion"), "Assertion");
        signature.parentNode?.removeChild(signature);
        assertion.appendChild(signature);
      });
      assert.strictEqual(yield* refusal(moved), "signatureNotEnveloped");
    }),
  );

  it.effect("XSW-1/2 shape: a forged Response wrapped around the signed one", () =>
    Effect.gen(function* () {
      const signed = signedResponse(responseXml(), { target: "response" });
      const wrapped = edit(signed, (document) => {
        const original = first(elementsNamed(document, NS.samlp, "Response"), "Response");
        const outer = document.createElementNS(NS.samlp, "samlp:Response");
        outer.setAttribute("ID", "_outer");
        document.replaceChild(outer, original);
        outer.appendChild(original);
      });
      // The inner signed Response holds the one Assertion, so cardinality passes; the signed bytes are the INNER
      // Response's, so what a consumer reads can only be what the IdP signed, never the wrapper.
      const verified = yield* verifyWith(wrapped, trustOf(idp));
      assert.strictEqual(verified.signedId, "_resp1");
      assert.notInclude(verified.signedXml, "_outer");
    }),
  );

  it.effect("the consumer reads from the signed bytes: a decoy value outside them never reaches it", () =>
    Effect.gen(function* () {
      const signed = signedResponse(responseXml());
      // An unsigned, attacker-added attribute statement outside the Assertion (inside the Response).
      const decorated = edit(signed, (document) => {
        const response = first(elementsNamed(document, NS.samlp, "Response"), "Response");
        const decoy = document.createElementNS(NS.saml, "saml:AttributeStatement");
        decoy.textContent = "role=root";
        response.appendChild(decoy);
      });
      const verified = yield* verifyWith(decorated, trustOf(idp));
      assert.notInclude(verified.signedXml, "role=root");
    }),
  );

  it.effect("duplicate IDs (the reference resolves to two elements) are refused before any signature work", () =>
    Effect.gen(function* () {
      // The Status element is given the signed assertion's ID: the Reference would be ambiguous.
      const xml = withAssertion((document) => {
        first(elementsNamed(document, NS.samlp, "Status"), "Status").setAttribute("ID", "_assert1");
      });
      assert.strictEqual(yield* refusal(xml), "duplicateId");
      // The same across attribute spellings (`ID` vs `Id` vs `id`).
      const spelled = edit(signedResponse(responseXml()), (document) => {
        first(elementsNamed(document, NS.samlp, "Status"), "Status").setAttribute("Id", "_assert1");
      });
      assert.strictEqual(yield* refusal(spelled), "duplicateId");
    }),
  );
});

describe("algorithm and transform allow-list", () => {
  it.effect("SHA-1 signatures and SHA-1 digests are refused", () =>
    Effect.gen(function* () {
      const sha1Signature = signedResponse(responseXml(), { signatureAlgorithm: ALGORITHM.rsaSha1 });
      assert.strictEqual(yield* refusal(sha1Signature), "unsupportedAlgorithm");
      const sha1Digest = signedResponse(responseXml(), { digestAlgorithm: ALGORITHM.sha1 });
      assert.strictEqual(yield* refusal(sha1Digest), "unsupportedAlgorithm");
    }),
  );

  it.effect("a downgrade edited into a signed document (SignatureMethod rewritten to SHA-1) is refused by the allow-list, not left to the digest", () =>
    Effect.gen(function* () {
      const downgraded = signedResponse(responseXml()).replace(ALGORITHM.rsaSha256, ALGORITHM.rsaSha1);
      assert.strictEqual(yield* refusal(downgraded), "unsupportedAlgorithm");
    }),
  );

  it.effect("HMAC methods (key confusion with the public certificate) are refused", () =>
    Effect.gen(function* () {
      const hmac = signedResponse(responseXml()).replace(
        ALGORITHM.rsaSha256,
        "http://www.w3.org/2000/09/xmldsig#hmac-sha1",
      );
      assert.strictEqual(yield* refusal(hmac), "unsupportedAlgorithm");
    }),
  );

  it.effect("inclusive canonicalization and canonicalization with comments are refused", () =>
    Effect.gen(function* () {
      for (const algorithm of [
        ALGORITHM.inclusive,
        "http://www.w3.org/2001/10/xml-exc-c14n#WithComments",
      ]) {
        const xml = signedResponse(responseXml()).replace(
          /(<ds:CanonicalizationMethod Algorithm=")[^"]+/,
          `$1${algorithm}`,
        );
        assert.strictEqual(yield* refusal(xml), "unsupportedAlgorithm", algorithm);
      }
    }),
  );

  it.effect("XSLT and XPath transforms are refused by name (the transform attacks that execute or rewrite)", () =>
    Effect.gen(function* () {
      const signed = signedResponse(responseXml());
      const xslt = signed.replace(
        "</ds:Transforms>",
        `<ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xslt-19991116"><xsl:stylesheet xmlns:xsl="http://www.w3.org/1999/XSL/Transform" version="1.0"/></ds:Transform></ds:Transforms>`,
      );
      assert.strictEqual(yield* refusal(xslt), "unsupportedTransform");
      const xpath = signed.replace(
        "</ds:Transforms>",
        `<ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116"><ds:XPath>not(ancestor-or-self::saml:Assertion)</ds:XPath></ds:Transform></ds:Transforms>`,
      );
      assert.strictEqual(yield* refusal(xpath), "unsupportedTransform");
    }),
  );

  it.effect("a Reference without the enveloped-signature transform, or with none, is refused", () =>
    Effect.gen(function* () {
      const signed = signedResponse(responseXml());
      const noEnveloped = signed.replace(
        /<ds:Transform Algorithm="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#enveloped-signature"\/>/,
        "",
      );
      assert.strictEqual(yield* refusal(noEnveloped), "unsupportedTransform");
      const none = signed.replace(/<ds:Transforms>.*<\/ds:Transforms>/s, "");
      assert.strictEqual(yield* refusal(none), "unsupportedTransform");
    }),
  );

  it.effect("References that are empty, external or XPointer are refused; so are two References", () =>
    Effect.gen(function* () {
      const signed = signedResponse(responseXml());
      for (const uri of ["", "http://evil.example/x.xml", "file:///etc/passwd", "_assert1"]) {
        const xml = signed.replace('URI="#_assert1"', `URI="${uri}"`);
        assert.strictEqual(yield* refusal(xml), "signatureStructure", uri);
      }
      // An XPointer is a same-document fragment in form but names no element: refused as unresolved.
      assert.strictEqual(
        yield* refusal(signed.replace('URI="#_assert1"', 'URI="#xpointer(/)"')),
        "unsignedElement",
      );
      const two = signed.replace(/(<ds:Reference [\s\S]*?<\/ds:Reference>)/, "$1$1");
      assert.strictEqual(yield* refusal(two), "signatureStructure");
    }),
  );

  it.effect("a Reference that resolves to no element, or to an element the consumer does not accept, is refused", () =>
    Effect.gen(function* () {
      const signed = signedResponse(responseXml());
      assert.strictEqual(yield* refusal(signed.replace('URI="#_assert1"', 'URI="#_nope"')), "unsignedElement");
      // A signature over the Issuer (a real element, a valid signature elsewhere) is not a signature over an Assertion or Response.
      const policy = { ...samlPolicy, signedElements: [RESPONSE] };
      assert.strictEqual(yield* refusal(signed, trustOf(idp), policy), "unsignedElement");
    }),
  );

  it.effect("more than four signatures, or a signature that does not verify next to one that does, refuses the document", () =>
    Effect.gen(function* () {
      const both = signedResponse(responseXml(), { target: "both" });
      // Corrupt the OUTER (Response-level) signature only: the Assertion's own still verifies, but the document is refused.
      const corrupted = both.replace(/(<\/ds:Signature>)(?![\s\S]*<\/ds:Signature>)/, "$1").replace(
        /(<ds:SignatureValue>)([A-Za-z0-9+/])(?![\s\S]*<ds:SignatureValue>)/,
        (_m, open: string, ch: string) => `${open}${ch === "A" ? "B" : "A"}`,
      );
      assert.notStrictEqual(corrupted, both);
      assert.strictEqual(yield* refusal(corrupted), "invalidSignature");
      const flood = edit(signedResponse(responseXml()), (document) => {
        const signature = first(elementsNamed(document, NS.ds, "Signature"), "Signature");
        for (let i = 0; i < 5; i++) signature.parentNode?.appendChild(cloneOf(signature));
      });
      assert.strictEqual(yield* refusal(flood), "tooManySignatures");
    }),
  );
});

describe("parsing: nothing the parser could act on reaches it", () => {
  it.effect("a DOCTYPE (XXE, billion laughs) is refused before parsing", () =>
    Effect.gen(function* () {
      const xxe = `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>` + signedResponse(responseXml());
      assert.strictEqual(yield* refusal(xxe), "doctype");
      const laughs =
        `<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]>` + signedResponse(responseXml());
      assert.strictEqual(yield* refusal(laughs), "doctype");
      // Case and spacing variants.
      assert.strictEqual(yield* refusal("<!doctype x>" + signedResponse(responseXml())), "doctype");
      assert.strictEqual(yield* refusal("<!ENTITY a 'b'>" + signedResponse(responseXml())), "doctype");
    }),
  );

  it.effect("comments are refused, including the NameID-truncation injection (a comment splitting a signed value)", () =>
    Effect.gen(function* () {
      const signed = signedResponse(responseXml({ nameId: "ada@acme.example.evil.example" }));
      const injected = signed.replace("ada@acme.example.evil.example", "ada@acme.example<!---->.evil.example");
      assert.notStrictEqual(injected, signed);
      assert.strictEqual(yield* refusal(injected), "comment");
      // Comments in the DigestValue (GHSA-x3m8-899r-f7c3's shape) are refused the same way.
      const digest = signed.replace(/(<ds:DigestValue>)/, "$1<!---->");
      assert.strictEqual(yield* refusal(digest), "comment");
    }),
  );

  it.effect("processing instructions (stylesheet), other than the XML declaration, are refused", () =>
    Effect.gen(function* () {
      const signed = signedResponse(responseXml());
      assert.strictEqual(yield* refusal(`<?xml-stylesheet href="x.xsl"?>${signed}`), "processingInstruction");
      assert.strictEqual(yield* refusal(signed.replace("<saml:Issuer>", "<?php echo 1 ?><saml:Issuer>")), "processingInstruction");
      // The XML declaration itself is fine.
      yield* verifyWith(`<?xml version="1.0" encoding="UTF-8"?>${signed}`, trustOf(idp));
    }),
  );

  it.effect("malformed XML, an empty document and pathological nesting are refused", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* refusal("<a><b></a>"), "malformed");
      assert.strictEqual(yield* refusal(""), "malformed");
      assert.strictEqual(yield* refusal("not xml at all"), "malformed");
      const deep = "<a>".repeat(200) + "</a>".repeat(200);
      assert.strictEqual(yield* refusal(deep), "malformed");
    }),
  );

  it.effect("the size cap applies before the parser (default 256 KiB; a policy may lower it)", () =>
    Effect.gen(function* () {
      const signed = signedResponse(responseXml());
      assert.strictEqual(yield* refusal(signed, trustOf(idp), { ...samlPolicy, maxBytes: 100 }), "tooLarge");
      const huge = signedResponse(responseXml({ attributes: { blob: ["x".repeat(300 * 1024)] } }));
      assert.strictEqual(yield* refusal(huge), "tooLarge");
      // Multi-byte input is measured in bytes, not characters.
      const wide = "é".repeat(150 * 1024);
      assert.strictEqual(yield* refusal(`<a>${wide}</a>`), "tooLarge");
    }),
  );

  it.effect("encrypted assertions (this build cannot read them) are refused by the policy's forbidden list", () =>
    Effect.gen(function* () {
      const signed = signedResponse(responseXml());
      const encrypted = edit(signed, (document) => {
        const response = first(elementsNamed(document, NS.samlp, "Response"), "Response");
        response.appendChild(document.createElementNS(NS.saml, "saml:EncryptedAssertion"));
      });
      assert.strictEqual(yield* refusal(encrypted), "forbiddenElement");
    }),
  );

  it.effect("cardinality: zero assertions is refused just like two", () =>
    Effect.gen(function* () {
      const none = edit(signedResponse(responseXml(), { target: "response" }), (document) => {
        const assertion = first(elementsNamed(document, NS.saml, "Assertion"), "Assertion");
        assertion.parentNode?.removeChild(assertion);
      });
      assert.strictEqual(yield* refusal(none), "cardinality");
    }),
  );
});

describe("the reference implementation of the policy: every refusal is a typed failure with a constant detail", () => {
  it.effect("failures never echo input", () =>
    Effect.gen(function* () {
      const failure = yield* verifyWith(`<!DOCTYPE x [<!ENTITY secret "TOPSECRET">]><a/>`, trustOf(idp)).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "XmlSignatureError");
      assert.notInclude(failure.detail, "TOPSECRET");
      assert.notInclude(failure.message ?? "", "TOPSECRET");
    }),
  );

  it("SafeXml's vocabulary agrees with the parser about what an element is", () => {
    const document = parseDom(signedResponse(responseXml()));
    const root = document.documentElement;
    assert.isNotNull(root);
    const assertions = SafeXml.named(root, ASSERTION);
    assert.strictEqual(assertions.length, 1);
    assert.include(serialize(document), "_assert1");
  });
});
