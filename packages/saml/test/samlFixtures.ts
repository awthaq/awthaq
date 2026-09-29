// Fixtures for the SAML package's tests: test-only RSA keys and self-signed certificates (`fixtures/*.pem`,
// generated with `openssl req -x509 -newkey rsa:2048 -nodes`, never used anywhere else), a builder for a SAML
// `Response`, and a signer over `xml-crypto` — the very library under test, which is fine for producing VALID
// documents; the attack documents are built by editing those, never by a signer that would make them "valid".
import { XmlSignature } from "@awthaq/ports";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as DateTime from "effect/DateTime";
import { SignedXml } from "xml-crypto";
import * as SafeXml from "../src/SafeXml.ts";
import * as XmlSignatureNode from "../src/XmlSignatureNode.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pem = (file: string): string => readFileSync(join(here, "fixtures", file), "utf8");

export interface Identity {
  readonly key: string;
  readonly cert: string;
  readonly fingerprint: string;
}

const identity = (name: string): Identity => {
  const cert = pem(`${name}.cert.pem`);
  const fingerprint = XmlSignatureNode.fingerprintOfPem(cert);
  if (fingerprint === undefined) throw new Error(`fixture ${name} is not a certificate`);
  return { key: pem(`${name}.key.pem`), cert, fingerprint };
};

export const idp = identity("idp-current");
export const idpNext = identity("idp-next");
export const attacker = identity("attacker");
/** Certificates the connection store must refuse as signing keys: RSA under 2048 bits, and a non-RSA key. */
export const weakRsa = identity("weak-rsa");
export const ecdsa = identity("ec");

/** Certificates are valid in the fixtures' own window; tests fix the clock inside it. */
export const NOW = DateTime.makeUnsafe(Date.UTC(2026, 8, 29, 12, 0, 0));
export const NOT_BEFORE = DateTime.makeUnsafe(Date.UTC(2026, 0, 1));
export const NOT_AFTER = DateTime.makeUnsafe(Date.UTC(2036, 0, 1));

export const trustOf = (...identities: ReadonlyArray<Identity>): XmlSignature.TrustSet => ({
  certificates: identities.map((entry) => ({
    fingerprint: entry.fingerprint,
    pem: entry.cert,
    notBefore: NOT_BEFORE,
    notAfter: NOT_AFTER,
  })),
});

export const ACS_URL = "https://sp.example.com/auth/saml/acs";
export const SP_ENTITY_ID_PREFIX = "https://sp.example.com/auth/saml/sp/";

export const NS = {
  samlp: "urn:oasis:names:tc:SAML:2.0:protocol",
  saml: "urn:oasis:names:tc:SAML:2.0:assertion",
  ds: "http://www.w3.org/2000/09/xmldsig#",
  md: "urn:oasis:names:tc:SAML:2.0:metadata",
};

export const RESPONSE: XmlSignature.ElementName = { namespace: NS.samlp, localName: "Response" };
export const ASSERTION: XmlSignature.ElementName = { namespace: NS.saml, localName: "Assertion" };
const ENCRYPTED_ASSERTION: XmlSignature.ElementName = {
  namespace: NS.saml,
  localName: "EncryptedAssertion",
};

/** The policy the SAML plugin uses: one Assertion, signed at the Assertion or the Response, no encrypted assertions. */
export const samlPolicy: XmlSignature.VerifyPolicy = {
  signedElements: [ASSERTION, RESPONSE],
  exactlyOne: [ASSERTION],
  forbidden: [ENCRYPTED_ASSERTION],
  now: NOW,
};

export interface ResponseOptions {
  readonly responseId?: string;
  readonly assertionId?: string;
  readonly issuer?: string;
  readonly nameId?: string;
  readonly audience?: string;
  readonly recipient?: string;
  readonly destination?: string;
  readonly inResponseTo?: string;
  readonly notBefore?: string;
  readonly notOnOrAfter?: string;
  readonly attributes?: Readonly<Record<string, ReadonlyArray<string>>>;
}

/** An unsigned Response with one Assertion. Times are ISO strings (defaults bracket `NOW`). */
export const responseXml = (options: ResponseOptions = {}): string => {
  const {
    responseId = "_resp1",
    assertionId = "_assert1",
    issuer = "https://idp.example.com/metadata",
    nameId = "ada@acme.example",
    audience = "https://sp.example.com/saml",
    recipient = "https://sp.example.com/auth/saml/acs",
    destination = "https://sp.example.com/auth/saml/acs",
    inResponseTo = "_authn1",
    notBefore = "2026-09-29T11:55:00Z",
    notOnOrAfter = "2026-09-29T12:05:00Z",
    attributes = { email: ["ada@acme.example"], groups: ["eng", "admins"] },
  } = options;
  const attributeXml = Object.entries(attributes)
    .map(
      ([attributeName, values]) =>
        `<saml:Attribute Name="${attributeName}">${values
          .map((value) => `<saml:AttributeValue>${value}</saml:AttributeValue>`)
          .join("")}</saml:Attribute>`,
    )
    .join("");
  return (
    `<samlp:Response xmlns:samlp="${NS.samlp}" xmlns:saml="${NS.saml}" ID="${responseId}" Version="2.0" ` +
    `IssueInstant="2026-09-29T12:00:00Z" Destination="${destination}" InResponseTo="${inResponseTo}">` +
    `<saml:Issuer>${issuer}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    `<saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="2026-09-29T12:00:00Z">` +
    `<saml:Issuer>${issuer}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${nameId}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<saml:SubjectConfirmationData Recipient="${recipient}" InResponseTo="${inResponseTo}" NotOnOrAfter="${notOnOrAfter}"/>` +
    `</saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">` +
    `<saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="2026-09-29T11:59:00Z" SessionIndex="_session1"/>` +
    `<saml:AttributeStatement>${attributeXml}</saml:AttributeStatement>` +
    `</saml:Assertion></samlp:Response>`
  );
};

export interface SignOptions {
  readonly who?: Identity;
  /** Which element(s) to sign. `both` signs the Assertion first, then the Response around it. */
  readonly target?: "assertion" | "response" | "both";
  readonly signatureAlgorithm?: string;
  readonly digestAlgorithm?: string;
  readonly keyInfo?: boolean;
  readonly assertionId?: string;
  readonly responseId?: string;
}

export const ALGORITHM = {
  rsaSha1: "http://www.w3.org/2000/09/xmldsig#rsa-sha1",
  rsaSha256: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  rsaSha512: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512",
  sha1: "http://www.w3.org/2000/09/xmldsig#sha1",
  sha256: "http://www.w3.org/2001/04/xmlenc#sha256",
  sha512: "http://www.w3.org/2001/04/xmlenc#sha512",
  exclusive: "http://www.w3.org/2001/10/xml-exc-c14n#",
  inclusive: "http://www.w3.org/TR/2001/REC-xml-c14n-20010315",
  enveloped: "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
};

const signElement = (
  xml: string,
  id: string,
  options: Required<
    Pick<SignOptions, "who" | "signatureAlgorithm" | "digestAlgorithm" | "keyInfo">
  >,
): string => {
  const signer = new SignedXml({
    privateKey: options.who.key,
    publicCert: options.who.cert,
    signatureAlgorithm: options.signatureAlgorithm,
    canonicalizationAlgorithm: ALGORITHM.exclusive,
    ...(options.keyInfo ? {} : { getKeyInfoContent: () => null }),
  });
  signer.addReference({
    xpath: `//*[@ID='${id}']`,
    transforms: [ALGORITHM.enveloped, ALGORITHM.exclusive],
    digestAlgorithm: options.digestAlgorithm,
  });
  signer.computeSignature(xml, {
    prefix: "ds",
    location: { reference: `//*[@ID='${id}']/*[local-name(.)='Issuer']`, action: "after" },
  });
  return signer.getSignedXml();
};

/** A validly signed Response. */
export const signedResponse = (xml: string, options: SignOptions = {}): string => {
  const resolved = {
    who: options.who ?? idp,
    signatureAlgorithm: options.signatureAlgorithm ?? ALGORITHM.rsaSha256,
    digestAlgorithm: options.digestAlgorithm ?? ALGORITHM.sha256,
    keyInfo: options.keyInfo ?? true,
  };
  const target = options.target ?? "assertion";
  const assertionId = options.assertionId ?? "_assert1";
  const responseId = options.responseId ?? "_resp1";
  let signed = xml;
  if (target === "assertion" || target === "both")
    signed = signElement(signed, assertionId, resolved);
  if (target === "response" || target === "both")
    signed = signElement(signed, responseId, resolved);
  return signed;
};

// ---- DOM editing for the attack documents ---------------------------------------------------------

export const parseDom = (xml: string): Document => new DOMParser().parseFromString(xml, "text/xml");
export const serialize = (document: Document): string =>
  new XMLSerializer().serializeToString(document);

export const elementsNamed = (
  document: Document,
  namespace: string,
  localName: string,
): Array<Element> => Array.from(document.getElementsByTagNameNS(namespace, localName));

export const first = <A>(items: ReadonlyArray<A>, what: string): A => {
  const found = items[0];
  if (found === undefined) throw new Error(`fixture: no ${what}`);
  return found;
};

/** Edits a signed document through the DOM and re-serializes it. */
export const edit = (xml: string, change: (document: Document) => void): string => {
  const document = parseDom(xml);
  change(document);
  return serialize(document);
};

export const cloneOf = (element: Element): Element => {
  const copy = element.cloneNode(true);
  if (!SafeXml.isElement(copy)) throw new Error("fixture: clone is not an element");
  return copy;
};

/** Every fixture asserts what it expects of the library's own success path before attacking it. */
export const verifyWith = (
  xml: string,
  trust: XmlSignature.TrustSet,
  policy: XmlSignature.VerifyPolicy = samlPolicy,
) => XmlSignatureNode.verifyAt({ xml, trust, policy }, NOW);
