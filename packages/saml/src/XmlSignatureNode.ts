// @awthaq/saml — XmlSignatureNode
//
// SFS-003 (ADR-EA-023 Decision 3, BEH-EA-239/240): the Node adapter for the `XmlSignature` port, over the
// maintained `xml-crypto` library (node-saml; ~5 M downloads a week; MIT). No signature or canonicalization
// code here is home-grown; what this module adds is the *policy* around the library, because the library's
// own API leaves the dangerous choices to the caller and has had three critical signature-bypass advisories
// (GHSA-x3m8-899r-f7c3, GHSA-9p8x-f768-wp2g, GHSA-2xp3-57p7-qf4v; all fixed at or before 6.0.1, pinned above them).
//
// What the adapter does, in order (each step refuses by a named reason; nothing here reaches the wire):
//
//   1. `SafeXml.parse`: size cap, no DOCTYPE/ENTITY/comments/processing instructions, strict parse, depth cap.
//   2. The caller's structural policy: forbidden elements absent, `exactlyOne` elements present exactly once
//      (for SAML: one Assertion, which is what makes wrapping have nothing to wrap *to*).
//   3. Every ID-like attribute (`ID`, `Id`, `id`) is unique in the document — a duplicated ID is how a signature
//      is made to resolve to one element while the application reads another.
//   4. Every `ds:Signature` (at most four) is checked structurally: one `SignedInfo`, exclusive C14N, RSA-SHA256/512
//      only (no SHA-1, no HMAC), exactly one `Reference` whose URI is `#<id>` (never empty, never external),
//      transforms limited to enveloped-signature and exclusive C14N (XSLT and XPath refused by name), digest
//      SHA-256/512 only; the referenced element is one the policy allows and the Signature is its own *child*.
//   5. Pinning: verification uses ONLY the caller's trust set — a certificate the document carries in its own
//      `KeyInfo` is never used to verify (`getCertFromKeyInfo` is disabled: the library prefers it otherwise), and
//      if the document names a certificate that is not pinned, the document is refused.
//   6. Each Signature is verified with `xml-crypto` against each pinned certificate inside its validity window
//      (a rotation overlap is several); ALL signatures must verify (an unverifiable extra signature refuses the
//      document). The library's registries are pruned to the allow-list, so even a structural gap above would
//      meet "unknown algorithm" inside the library.
//   7. The result is `getSignedReferences()`: the canonical bytes of the signed element, nothing from the input.

import { XmlSignature } from "@awthaq/ports";
import { createHash } from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SignedXml } from "xml-crypto";
import * as SafeXml from "./SafeXml.ts";

export const NS_DSIG = "http://www.w3.org/2000/09/xmldsig#";

const ALGORITHMS = {
  exclusiveC14n: "http://www.w3.org/2001/10/xml-exc-c14n#",
  enveloped: "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
  rsaSha256: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  rsaSha512: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512",
  sha256: "http://www.w3.org/2001/04/xmlenc#sha256",
  sha512: "http://www.w3.org/2001/04/xmlenc#sha512",
} as const;

const SIGNATURE_ALGORITHMS: ReadonlySet<string> = new Set([
  ALGORITHMS.rsaSha256,
  ALGORITHMS.rsaSha512,
]);
const DIGEST_ALGORITHMS: ReadonlySet<string> = new Set([ALGORITHMS.sha256, ALGORITHMS.sha512]);

/** Named so a log line says what was refused: the algorithms a wrapping or downgrade attempt reaches for. */
const REFUSED_ALGORITHMS: Readonly<Record<string, string>> = {
  "http://www.w3.org/2000/09/xmldsig#rsa-sha1": "SHA-1 signature",
  "http://www.w3.org/2000/09/xmldsig#dsa-sha1": "DSA-SHA1 signature",
  "http://www.w3.org/2000/09/xmldsig#hmac-sha1": "HMAC signature (key confusion)",
  "http://www.w3.org/2001/04/xmldsig-more#hmac-sha256": "HMAC signature (key confusion)",
  "http://www.w3.org/2000/09/xmldsig#sha1": "SHA-1 digest",
  "http://www.w3.org/2001/04/xmldsig-more#md5": "MD5",
  "http://www.w3.org/TR/2001/REC-xml-c14n-20010315": "inclusive canonicalization",
  "http://www.w3.org/TR/2001/REC-xml-c14n-20010315#WithComments":
    "inclusive canonicalization with comments",
  "http://www.w3.org/2001/10/xml-exc-c14n#WithComments": "exclusive canonicalization with comments",
  "http://www.w3.org/TR/1999/REC-xslt-19991116": "XSLT transform",
  "http://www.w3.org/TR/1999/REC-xpath-19991116": "XPath transform",
  "http://www.w3.org/2002/06/xmldsig-filter2": "XPath filter 2 transform",
  "http://www.w3.org/2000/09/xmldsig#base64": "base64 transform",
};

const MAX_SIGNATURES = 4;

const name = (localName: string): XmlSignature.ElementName => ({ namespace: NS_DSIG, localName });
const SIGNATURE = name("Signature");
const SIGNED_INFO = name("SignedInfo");
const SIGNATURE_VALUE = name("SignatureValue");
const KEY_INFO = name("KeyInfo");
const CANONICALIZATION_METHOD = name("CanonicalizationMethod");
const SIGNATURE_METHOD = name("SignatureMethod");
const REFERENCE = name("Reference");
const TRANSFORMS = name("Transforms");
const TRANSFORM = name("Transform");
const DIGEST_METHOD = name("DigestMethod");
const X509_CERTIFICATE = name("X509Certificate");

const fail = (reason: XmlSignature.XmlSignatureFailure, detail: string) =>
  Effect.fail(new XmlSignature.XmlSignatureError({ reason, detail }));

/** The algorithm URI when it is on `allowed`; otherwise a refusal that names what was refused. */
const allowedAlgorithm = (
  algorithm: string | undefined,
  allowed: ReadonlySet<string>,
  what: string,
  transform = false,
) => {
  if (algorithm !== undefined && allowed.has(algorithm)) return Effect.succeed(algorithm);
  const refused = algorithm === undefined ? undefined : REFUSED_ALGORITHMS[algorithm];
  return fail(
    transform ? "unsupportedTransform" : "unsupportedAlgorithm",
    refused === undefined ? `${what} is not on the allow-list` : `${what}: ${refused} is refused`,
  );
};

/** Exactly one child of that name. */
const single = (parent: Element, child: XmlSignature.ElementName, detail: string) => {
  const found = SafeXml.childrenNamed(parent, child);
  const first = found[0];
  return found.length === 1 && first !== undefined
    ? Effect.succeed(first)
    : fail("signatureStructure", detail);
};

/** SHA-256 of the DER of a PEM certificate, lower-case hex; `undefined` when it is not one. */
export const fingerprintOfPem = (pem: string): string | undefined => {
  const body = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
  if (body.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return undefined;
  return createHash("sha256").update(Buffer.from(body, "base64")).digest("hex");
};

/** Steps 3-4 for one Signature: structure and algorithms, before any cryptography. */
const checkStructure = Effect.fnUntraced(function* (
  signature: Element,
  idIndex: ReadonlyMap<string, ReadonlyArray<Element>>,
  policy: XmlSignature.VerifyPolicy,
) {
  const signedInfo = yield* single(signature, SIGNED_INFO, "exactly one SignedInfo is required");
  yield* single(signature, SIGNATURE_VALUE, "exactly one SignatureValue is required");
  const keyInfos = SafeXml.childrenNamed(signature, KEY_INFO);
  if (keyInfos.length > 1)
    return yield* fail("signatureStructure", "at most one KeyInfo is allowed");

  const canonicalization = yield* single(
    signedInfo,
    CANONICALIZATION_METHOD,
    "exactly one CanonicalizationMethod is required",
  );
  yield* allowedAlgorithm(
    SafeXml.attribute(canonicalization, "Algorithm"),
    new Set([ALGORITHMS.exclusiveC14n]),
    "CanonicalizationMethod",
  );
  if (SafeXml.childElements(canonicalization).length > 0) {
    return yield* fail(
      "unsupportedAlgorithm",
      "an inclusive namespace list on the SignedInfo canonicalization is not accepted",
    );
  }

  const method = yield* single(
    signedInfo,
    SIGNATURE_METHOD,
    "exactly one SignatureMethod is required",
  );
  const signatureAlgorithm = yield* allowedAlgorithm(
    SafeXml.attribute(method, "Algorithm"),
    SIGNATURE_ALGORITHMS,
    "SignatureMethod",
  );

  const reference = yield* single(signedInfo, REFERENCE, "exactly one Reference is required");
  const uri = SafeXml.attribute(reference, "URI");
  if (uri === undefined || !/^#[^#\s]+$/.test(uri)) {
    return yield* fail(
      "signatureStructure",
      "the Reference URI must be a same-document #ID (never empty or external)",
    );
  }

  const transformLists = SafeXml.childrenNamed(reference, TRANSFORMS);
  const transformList = transformLists[0];
  if (transformLists.length !== 1 || transformList === undefined) {
    return yield* fail("unsupportedTransform", "the Reference must carry a Transforms list");
  }
  const seen = new Set<string>();
  for (const transform of SafeXml.childrenNamed(transformList, TRANSFORM)) {
    const algorithm = yield* allowedAlgorithm(
      SafeXml.attribute(transform, "Algorithm"),
      new Set([ALGORITHMS.enveloped, ALGORITHMS.exclusiveC14n]),
      "Transform",
      true,
    );
    if (seen.has(algorithm)) return yield* fail("unsupportedTransform", "a transform is repeated");
    seen.add(algorithm);
    // An exclusive-C14N prefix list is the one child a transform may carry; anything else (an XPath expression) is refused.
    if (
      SafeXml.childElements(transform).some((child) => child.localName !== "InclusiveNamespaces")
    ) {
      return yield* fail(
        "unsupportedTransform",
        "a transform carries content this adapter does not accept",
      );
    }
  }
  if (!seen.has(ALGORITHMS.enveloped) || !seen.has(ALGORITHMS.exclusiveC14n)) {
    return yield* fail(
      "unsupportedTransform",
      "the Reference must use enveloped-signature and exclusive canonicalization",
    );
  }
  if (SafeXml.childElements(transformList).length !== seen.size) {
    return yield* fail(
      "unsupportedTransform",
      "the Transforms list carries an element that is not a Transform",
    );
  }

  const digest = yield* single(reference, DIGEST_METHOD, "exactly one DigestMethod is required");
  const digestAlgorithm = yield* allowedAlgorithm(
    SafeXml.attribute(digest, "Algorithm"),
    DIGEST_ALGORITHMS,
    "DigestMethod",
  );

  // The Reference must resolve to exactly one element (the duplicate-ID check already ran), a permitted one,
  // and the Signature must be that element's own child: an enveloped signature, not one parked elsewhere.
  const targets = idIndex.get(uri.slice(1));
  const target = targets?.[0];
  if (targets === undefined || targets.length !== 1 || target === undefined) {
    return yield* fail("unsignedElement", "the Reference does not resolve to exactly one element");
  }
  if (!policy.signedElements.some((allowed) => SafeXml.isNamed(target, allowed))) {
    return yield* fail(
      "unsignedElement",
      "the signature covers an element this consumer does not accept",
    );
  }
  if (signature.parentNode !== target) {
    return yield* fail(
      "signatureNotEnveloped",
      "the Signature is not a child of the element it signs",
    );
  }

  const namedCertificates: Array<string> = [];
  for (const keyInfo of keyInfos) {
    for (const element of SafeXml.allElements(keyInfo)) {
      if (!SafeXml.isNamed(element, X509_CERTIFICATE)) continue;
      const fingerprint = fingerprintOfPem(SafeXml.textOf(element) ?? "");
      if (fingerprint === undefined) {
        return yield* fail("signatureStructure", "a KeyInfo certificate is not a certificate");
      }
      namedCertificates.push(fingerprint);
    }
  }

  return { element: signature, target, signatureAlgorithm, digestAlgorithm, namedCertificates };
});

/** Every ID-like attribute value in the document, mapped to the elements carrying it; a repeated value is refused. */
const indexIds = Effect.fnUntraced(function* (root: Element) {
  const index = new Map<string, Array<Element>>();
  for (const element of SafeXml.allElements(root)) {
    for (const attributeName of ["ID", "Id", "id"]) {
      const value = SafeXml.attribute(element, attributeName);
      if (value === undefined) continue;
      const seen = index.get(value) ?? [];
      seen.push(element);
      index.set(value, seen);
    }
  }
  for (const [, elements] of index) {
    if (elements.length > 1) {
      return yield* fail("duplicateId", "an ID value occurs more than once in the document");
    }
  }
  return index;
});

/** The library, restricted: only the allow-listed algorithms exist inside it, and KeyInfo is never a key source. */
const verifierFor = (pem: string) => {
  const signed = new SignedXml({ publicCert: pem, getCertFromKeyInfo: () => null });
  const keep = <T>(
    registry: Record<string, T>,
    allowed: ReadonlyArray<string>,
  ): Record<string, T> =>
    Object.fromEntries(Object.entries(registry).filter(([key]) => allowed.includes(key)));
  signed.SignatureAlgorithms = keep(signed.SignatureAlgorithms, [...SIGNATURE_ALGORITHMS]);
  signed.HashAlgorithms = keep(signed.HashAlgorithms, [...DIGEST_ALGORITHMS]);
  signed.CanonicalizationAlgorithms = keep(signed.CanonicalizationAlgorithms, [
    ALGORITHMS.exclusiveC14n,
    ALGORITHMS.enveloped,
  ]);
  return signed;
};

const inWindow = (certificate: XmlSignature.TrustedCertificate, now: DateTime.Utc): boolean =>
  DateTime.toEpochMillis(certificate.notBefore) <= DateTime.toEpochMillis(now) &&
  DateTime.toEpochMillis(now) < DateTime.toEpochMillis(certificate.notAfter);

interface Checked {
  readonly element: Element;
  readonly target: Element;
  readonly signatureAlgorithm: string;
  readonly digestAlgorithm: string;
}

interface Verified {
  readonly checked: Checked;
  readonly signedXml: string;
  readonly fingerprint: string;
}

/** Step 6 for one Signature: the library, against each candidate pinned certificate in turn. */
const verifySignature = Effect.fnUntraced(function* (
  document: string,
  checked: Checked,
  candidates: ReadonlyArray<XmlSignature.TrustedCertificate>,
) {
  for (const certificate of candidates) {
    const verifier = verifierFor(certificate.pem);
    const outcome = yield* Effect.try({
      try: () => {
        verifier.loadSignature(checked.element);
        return verifier.checkSignature(document) === true
          ? verifier.getSignedReferences()
          : undefined;
      },
      // The library throws on a signature it cannot process; that certificate did not verify it.
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => undefined));
    if (outcome === undefined) continue;
    const [signedXml] = outcome;
    if (outcome.length !== 1 || signedXml === undefined) {
      return yield* fail(
        "signatureStructure",
        "the signature did not yield exactly one signed element",
      );
    }
    const verified: Verified = { checked, signedXml, fingerprint: certificate.fingerprint };
    return verified;
  }
  return yield* fail("invalidSignature", "no pinned certificate verifies the signature");
});

/** The whole verification. Synchronous CPU work over the document and the trust set, expressed as an Effect for its typed failures. */
export const verifyAt = Effect.fnUntraced(function* (
  input: {
    readonly xml: string;
    readonly trust: XmlSignature.TrustSet;
    readonly policy: XmlSignature.VerifyPolicy;
  },
  now: DateTime.Utc,
) {
  const { policy } = input;
  const root = yield* SafeXml.parse(input.xml, policy.maxBytes);

  for (const forbidden of policy.forbidden ?? []) {
    if (SafeXml.named(root, forbidden).length > 0) {
      return yield* fail("forbiddenElement", `${forbidden.localName} is not accepted`);
    }
  }
  for (const required of policy.exactlyOne ?? []) {
    if (SafeXml.named(root, required).length !== 1) {
      return yield* fail(
        "cardinality",
        `the document must contain exactly one ${required.localName}`,
      );
    }
  }

  const ids = yield* indexIds(root);

  const signatures = SafeXml.named(root, SIGNATURE);
  if (signatures.length === 0) return yield* fail("noSignature", "the document is not signed");
  if (signatures.length > MAX_SIGNATURES) {
    return yield* fail("tooManySignatures", "the document carries too many signatures");
  }

  const pinned = input.trust.certificates.filter((certificate) => {
    // A trust entry whose declared fingerprint is not its certificate's is a configuration error: never trusted.
    const actual = fingerprintOfPem(certificate.pem);
    return actual !== undefined && actual === certificate.fingerprint.toLowerCase();
  });

  const verified: Array<Verified> = [];
  for (const signature of signatures) {
    const checked = yield* checkStructure(signature, ids, policy);
    // Pinning: EVERY certificate the document names must be one we hold (a list with the IdP's certificate
    // second and the attacker's first is the classic way to make a library that reads the first one verify
    // with the wrong key); then only OUR copy verifies.
    const heldFingerprints = new Set(
      pinned.map((certificate) => certificate.fingerprint.toLowerCase()),
    );
    if (checked.namedCertificates.some((fingerprint) => !heldFingerprints.has(fingerprint))) {
      return yield* fail(
        "untrustedKey",
        "the document names a signing certificate that is not pinned",
      );
    }
    const pool =
      checked.namedCertificates.length === 0
        ? pinned
        : pinned.filter((certificate) =>
            checked.namedCertificates.includes(certificate.fingerprint.toLowerCase()),
          );
    const candidates = pool.filter((certificate) => inWindow(certificate, now));
    if (candidates.length === 0) {
      return yield* fail("noTrustedCertificate", "no pinned certificate is valid at this time");
    }
    verified.push(yield* verifySignature(input.xml, checked, candidates));
  }

  // The first permitted element (in the policy's order) that a verified signature covers.
  for (const allowed of policy.signedElements) {
    const winner = verified.find((item) => SafeXml.isNamed(item.checked.target, allowed));
    if (winner === undefined) continue;
    const target = winner.checked.target;
    const result: XmlSignature.VerifiedXml = {
      signedXml: winner.signedXml,
      signedElement: allowed,
      signedId:
        SafeXml.attribute(target, "ID") ??
        SafeXml.attribute(target, "Id") ??
        SafeXml.attribute(target, "id") ??
        "",
      signatureAlgorithm: winner.checked.signatureAlgorithm,
      digestAlgorithm: winner.checked.digestAlgorithm,
      certificateFingerprint: winner.fingerprint,
    };
    return result;
  }
  return yield* fail(
    "unsignedElement",
    "no verified signature covers an element this consumer accepts",
  );
});

/** The port over `xml-crypto`. */
export const layer = Layer.succeed(
  XmlSignature.XmlSignature,
  XmlSignature.XmlSignature.of({
    verify: (input) =>
      Effect.gen(function* () {
        const now = input.policy.now ?? (yield* DateTime.now);
        return yield* verifyAt(input, now);
      }),
  }),
);
