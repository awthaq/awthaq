// P20a: the IdP's side of 29-saml-sp.feature — a builder for a SAML `Response`, a signer over `xml-crypto`
// (the very library the adapter under test verifies with, which is fine for producing VALID documents), and
// DOM edits for the attack documents. Attack documents are always made by editing a validly signed one, never
// by a signer that would make them "valid". The key material under `fixtures/saml/` is test-only, copied from
// `packages/saml/test/fixtures` (a features package cannot import another package's test directory).
import { SafeXml, XmlSignatureNode } from "@awthaq/saml";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SignedXml } from "xml-crypto";

const here = dirname(fileURLToPath(import.meta.url));
const pem = (file: string): string => readFileSync(join(here, "fixtures", "saml", file), "utf8");

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

/** The fixtures' clock: inside every certificate's validity window and inside the default assertion window. */
export const NOW_MILLIS = Date.UTC(2026, 8, 29, 12, 0, 0);
/** The default assertion window: NotBefore 11:55, NotOnOrAfter 12:05. */
export const NOT_BEFORE_MILLIS = Date.UTC(2026, 8, 29, 11, 55, 0);
export const NOT_ON_OR_AFTER_MILLIS = Date.UTC(2026, 8, 29, 12, 5, 0);
/** After every fixture certificate's notAfter (2036-09-26). */
export const AFTER_CERTIFICATES_MILLIS = Date.UTC(2036, 9, 1, 0, 0, 0);

export const NS = {
  samlp: "urn:oasis:names:tc:SAML:2.0:protocol",
  saml: "urn:oasis:names:tc:SAML:2.0:assertion",
  ds: "http://www.w3.org/2000/09/xmldsig#",
};

export const ALGORITHM = {
  rsaSha1: "http://www.w3.org/2000/09/xmldsig#rsa-sha1",
  rsaSha256: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  sha1: "http://www.w3.org/2000/09/xmldsig#sha1",
  sha256: "http://www.w3.org/2001/04/xmlenc#sha256",
  exclusive: "http://www.w3.org/2001/10/xml-exc-c14n#",
  enveloped: "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
};

const iso = (millis: number) => new Date(millis).toISOString().replace(".000Z", "Z");

export interface ResponseOptions {
  readonly responseId?: string;
  readonly assertionId?: string;
  readonly issuer?: string;
  readonly nameId?: string;
  readonly audience?: string;
  readonly recipient?: string;
  /** `null` leaves the Response's Destination attribute out. */
  readonly destination?: string | null;
  /** `null` leaves InResponseTo out (an unsolicited response). */
  readonly inResponseTo?: string | null;
  readonly confirmationMethod?: string;
  readonly notBefore?: string;
  /** `null` leaves the Conditions' NotOnOrAfter out. */
  readonly notOnOrAfter?: string | null;
  /** The SubjectConfirmationData's own NotOnOrAfter; defaults to the assertion window's. */
  readonly confirmationNotOnOrAfter?: string;
  readonly attributes?: Readonly<Record<string, ReadonlyArray<string>>>;
}

/** An unsigned Response with one Assertion. The defaults bracket `NOW_MILLIS`. */
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
    confirmationMethod = "urn:oasis:names:tc:SAML:2.0:cm:bearer",
    notBefore = iso(NOT_BEFORE_MILLIS),
    attributes = { email: ["ada@acme.example"] },
  } = options;
  const notOnOrAfter =
    options.notOnOrAfter === undefined ? iso(NOT_ON_OR_AFTER_MILLIS) : options.notOnOrAfter;
  const confirmationNotOnOrAfter = options.confirmationNotOnOrAfter ?? notOnOrAfter;
  const attributeXml = Object.entries(attributes)
    .map(
      ([attributeName, values]) =>
        `<saml:Attribute Name="${attributeName}">${values
          .map((value) => `<saml:AttributeValue>${value}</saml:AttributeValue>`)
          .join("")}</saml:Attribute>`,
    )
    .join("");
  const responseAttributes =
    `ID="${responseId}" Version="2.0" IssueInstant="${iso(NOW_MILLIS)}"` +
    (destination === null ? "" : ` Destination="${destination}"`) +
    (inResponseTo === null ? "" : ` InResponseTo="${inResponseTo}"`);
  const confirmationData =
    `Recipient="${recipient}"` +
    (inResponseTo === null ? "" : ` InResponseTo="${inResponseTo}"`) +
    (confirmationNotOnOrAfter === null ? "" : ` NotOnOrAfter="${confirmationNotOnOrAfter}"`);
  return (
    `<samlp:Response xmlns:samlp="${NS.samlp}" xmlns:saml="${NS.saml}" ${responseAttributes}>` +
    `<saml:Issuer>${issuer}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    `<saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${iso(NOW_MILLIS)}">` +
    `<saml:Issuer>${issuer}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">${nameId}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="${confirmationMethod}">` +
    `<saml:SubjectConfirmationData ${confirmationData}/>` +
    `</saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${notBefore}"${notOnOrAfter === null ? "" : ` NotOnOrAfter="${notOnOrAfter}"`}>` +
    `<saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(NOW_MILLIS - 60_000)}" SessionIndex="_session1"/>` +
    `<saml:AttributeStatement>${attributeXml}</saml:AttributeStatement>` +
    `</saml:Assertion></samlp:Response>`
  );
};

export interface SignOptions {
  readonly who?: Identity;
  readonly target?: "assertion" | "response" | "both";
  readonly signatureAlgorithm?: string;
  readonly digestAlgorithm?: string;
  readonly assertionId?: string;
  readonly responseId?: string;
}

const signElement = (
  xml: string,
  id: string,
  who: Identity,
  signatureAlgorithm: string,
  digestAlgorithm: string,
): string => {
  const signer = new SignedXml({
    privateKey: who.key,
    publicCert: who.cert,
    signatureAlgorithm,
    canonicalizationAlgorithm: ALGORITHM.exclusive,
  });
  signer.addReference({
    xpath: `//*[@ID='${id}']`,
    transforms: [ALGORITHM.enveloped, ALGORITHM.exclusive],
    digestAlgorithm,
  });
  signer.computeSignature(xml, {
    prefix: "ds",
    location: { reference: `//*[@ID='${id}']/*[local-name(.)='Issuer']`, action: "after" },
  });
  return signer.getSignedXml();
};

/** A validly signed Response (Assertion-signed unless `target` says otherwise). */
export const signedResponse = (xml: string, options: SignOptions = {}): string => {
  const who = options.who ?? idp;
  const signatureAlgorithm = options.signatureAlgorithm ?? ALGORITHM.rsaSha256;
  const digestAlgorithm = options.digestAlgorithm ?? ALGORITHM.sha256;
  const target = options.target ?? "assertion";
  let signed = xml;
  if (target === "assertion" || target === "both")
    signed = signElement(
      signed,
      options.assertionId ?? "_assert1",
      who,
      signatureAlgorithm,
      digestAlgorithm,
    );
  if (target === "response" || target === "both")
    signed = signElement(
      signed,
      options.responseId ?? "_resp1",
      who,
      signatureAlgorithm,
      digestAlgorithm,
    );
  return signed;
};

// ---- DOM editing for the attack documents ----------------------------------------------------------

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

/** A forged Assertion: the signed one, edited to name an administrator under a new ID, its Signature removed. */
export const forgedAssertion = (original: Element, id: string): Element => {
  const forged = cloneOf(original);
  forged.setAttribute("ID", id);
  for (const child of Array.from(forged.childNodes)) {
    if (SafeXml.isElement(child) && child.localName === "Signature") forged.removeChild(child);
  }
  const nameId = first(Array.from(forged.getElementsByTagNameNS(NS.saml, "NameID")), "NameID");
  nameId.textContent = "admin@acme.example";
  return forged;
};
