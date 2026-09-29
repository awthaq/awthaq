// @awthaq/saml — SamlProtocol
//
// The XML this service provider *produces* and the IdP metadata it *reads*: SP metadata, the AuthnRequest and its
// HTTP-Redirect encoding (raw DEFLATE, base64, URL-encoded: SAML bindings 3.4), and IdP metadata import. Producing
// is string assembly with every interpolated value XML-escaped (no user-controlled markup); reading goes through
// `SafeXml` like every other document here.
//
// BEH-EA-305: signed AuthnRequests. The redirect binding's signature is a query-string signature, not an XML-DSig one
// (SamlKeys.signRedirect); this module only assembles the message and the metadata that publishes the SP certificate.
// BEH-EA-306: the Single Logout messages (LogoutRequest, LogoutResponse) and the HTML form of the POST binding.

import type { XmlSignature } from "@awthaq/ports";
import { deflateRawSync } from "node:zlib";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SafeXml from "./SafeXml.ts";
import { NS_METADATA, NS_SAML, NS_SAMLP } from "./SamlAssertion.ts";
import * as SamlKeys from "./SamlKeys.ts";
import { NS_DSIG, fingerprintOfPem } from "./XmlSignatureNode.ts";

export const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

export const BINDING_REDIRECT = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
export const BINDING_POST = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";
export const NAMEID_EMAIL = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";
export const NAMEID_PERSISTENT = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";

/** The `AuthnRequest` for one login. `id` must be an NCName (letters, digits, `-`, `_`, `.`; not starting with a digit). */
export const authnRequestXml = (input: {
  readonly id: string;
  readonly issueInstant: DateTime.Utc;
  readonly destination: string;
  readonly acsUrl: string;
  readonly issuer: string;
}): string =>
  `<samlp:AuthnRequest xmlns:samlp="${NS_SAMLP}" xmlns:saml="${NS_SAML}" ID="${escapeXml(input.id)}" Version="2.0" ` +
  `IssueInstant="${DateTime.formatIso(input.issueInstant)}" Destination="${escapeXml(input.destination)}" ` +
  `ProtocolBinding="${BINDING_POST}" AssertionConsumerServiceURL="${escapeXml(input.acsUrl)}">` +
  `<saml:Issuer>${escapeXml(input.issuer)}</saml:Issuer>` +
  `<samlp:NameIDPolicy Format="${NAMEID_EMAIL}" AllowCreate="true"/>` +
  `</samlp:AuthnRequest>`;

/** SAML bindings 3.4.4.1: DEFLATE (raw), then base64: the value of `SAMLRequest`/`SAMLResponse` before URL-encoding. */
export const deflateBase64 = (xml: string): string =>
  deflateRawSync(Buffer.from(xml, "utf8")).toString("base64");

const appendQuery = (endpoint: string, query: string): string =>
  `${endpoint}${endpoint.includes("?") ? "&" : "?"}${query}`;

/**
 * The redirect-binding URL for one message: the endpoint plus `<kind>=..[&RelayState=..]`, and, when `signWith` is given,
 * `&SigAlg=..&Signature=..` over those exact octets (BEH-EA-305). Any query the endpoint already carries is kept ahead of
 * ours: the signature covers only what this function appends, as the binding says.
 */
export const redirectUrl = (input: {
  readonly endpoint: string;
  readonly kind: "SAMLRequest" | "SAMLResponse";
  readonly xml: string;
  readonly relayState?: string | undefined;
  /** The SP's PKCS#8 private key (PEM) when the message is to be signed. */
  readonly signWith?: string | undefined;
}): string => {
  const message = deflateBase64(input.xml);
  const query =
    input.signWith === undefined
      ? SamlKeys.plainRedirect({ kind: input.kind, message, relayState: input.relayState })
      : SamlKeys.signRedirect({
          kind: input.kind,
          message,
          relayState: input.relayState,
          privateKeyPem: input.signWith,
        });
  return appendQuery(input.endpoint, query);
};

/** Unsigned redirect to the IdP (the pre-BEH-EA-305 shape, kept for callers that build a request by hand). */
export const redirectLocation = (ssoUrl: string, requestXml: string, relayState?: string): string =>
  redirectUrl({ endpoint: ssoUrl, kind: "SAMLRequest", xml: requestXml, relayState });

/** The HTTP-POST binding: a self-submitting HTML form (SAML bindings 3.5). The XML is base64 (not deflated). */
export const postFormHtml = (input: {
  readonly destination: string;
  readonly kind: "SAMLRequest" | "SAMLResponse";
  readonly xml: string;
  readonly relayState?: string | undefined;
}): string =>
  `<!DOCTYPE html><html><body onload="document.forms[0].submit()">` +
  `<noscript><p>Your browser has JavaScript disabled: press the button to continue.</p></noscript>` +
  `<form method="post" action="${escapeXml(input.destination)}">` +
  `<input type="hidden" name="${input.kind}" value="${Buffer.from(input.xml, "utf8").toString("base64")}"/>` +
  (input.relayState === undefined
    ? ""
    : `<input type="hidden" name="RelayState" value="${escapeXml(input.relayState)}"/>`) +
  `<noscript><input type="submit" value="Continue"/></noscript></form></body></html>`;

/**
 * SP metadata for one connection: its entity id and the ACS. `WantAssertionsSigned="true"` and
 * `AuthnRequestsSigned="false"`; bearer POST binding only. Give it to the IdP administrator (or an IdP that
 * imports metadata by URL).
 */
export const spMetadataXml = (input: {
  readonly entityId: string;
  readonly acsUrl: string;
  /** BEH-EA-305: the connection signs its AuthnRequests (and Single Logout messages). */
  readonly authnRequestsSigned?: boolean | undefined;
  /** The SP signing certificates (PEM) to publish as `KeyDescriptor use="signing"`: every unexpired one (a rotation overlap). */
  readonly certificates?: ReadonlyArray<string> | undefined;
  /** BEH-EA-306: this SP's Single Logout endpoint; when given, it is published for the Redirect and POST bindings. */
  readonly sloUrl?: string | undefined;
}): string => {
  const bodyOf = (pem: string) =>
    pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
  const keys = (input.certificates ?? [])
    .map(
      (pem) =>
        `<md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="${NS_DSIG}"><ds:X509Data>` +
        `<ds:X509Certificate>${bodyOf(pem)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`,
    )
    .join("");
  const slo =
    input.sloUrl === undefined
      ? ""
      : `<md:SingleLogoutService Binding="${BINDING_REDIRECT}" Location="${escapeXml(input.sloUrl)}"/>` +
        `<md:SingleLogoutService Binding="${BINDING_POST}" Location="${escapeXml(input.sloUrl)}"/>`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<md:EntityDescriptor xmlns:md="${NS_METADATA}" entityID="${escapeXml(input.entityId)}">` +
    `<md:SPSSODescriptor AuthnRequestsSigned="${input.authnRequestsSigned === true}" WantAssertionsSigned="true" protocolSupportEnumeration="${NS_SAMLP}">` +
    keys +
    slo +
    `<md:NameIDFormat>${NAMEID_EMAIL}</md:NameIDFormat>` +
    `<md:NameIDFormat>${NAMEID_PERSISTENT}</md:NameIDFormat>` +
    `<md:AssertionConsumerService Binding="${BINDING_POST}" Location="${escapeXml(input.acsUrl)}" index="0" isDefault="true"/>` +
    `</md:SPSSODescriptor></md:EntityDescriptor>`
  );
};

// ---- Single Logout messages (BEH-EA-306) -------------------------------------------------------------

/** A `LogoutRequest` for one identity. `id` must be an NCName. */
export const logoutRequestXml = (input: {
  readonly id: string;
  readonly issueInstant: DateTime.Utc;
  readonly destination: string;
  readonly issuer: string;
  readonly nameId: { readonly value: string; readonly format?: string | undefined };
  readonly sessionIndex?: string | undefined;
}): string =>
  `<samlp:LogoutRequest xmlns:samlp="${NS_SAMLP}" xmlns:saml="${NS_SAML}" ID="${escapeXml(input.id)}" Version="2.0" ` +
  `IssueInstant="${DateTime.formatIso(input.issueInstant)}" Destination="${escapeXml(input.destination)}">` +
  `<saml:Issuer>${escapeXml(input.issuer)}</saml:Issuer>` +
  `<saml:NameID${input.nameId.format === undefined ? "" : ` Format="${escapeXml(input.nameId.format)}"`}>${escapeXml(input.nameId.value)}</saml:NameID>` +
  (input.sessionIndex === undefined
    ? ""
    : `<samlp:SessionIndex>${escapeXml(input.sessionIndex)}</samlp:SessionIndex>`) +
  `</samlp:LogoutRequest>`;

export const STATUS_SUCCESS_URI = "urn:oasis:names:tc:SAML:2.0:status:Success";
export const STATUS_REQUESTER = "urn:oasis:names:tc:SAML:2.0:status:Requester";

/** A `LogoutResponse` answering the IdP's request `inResponseTo`. */
export const logoutResponseXml = (input: {
  readonly id: string;
  readonly issueInstant: DateTime.Utc;
  readonly destination: string;
  readonly issuer: string;
  readonly inResponseTo: string;
  readonly success: boolean;
}): string =>
  `<samlp:LogoutResponse xmlns:samlp="${NS_SAMLP}" xmlns:saml="${NS_SAML}" ID="${escapeXml(input.id)}" Version="2.0" ` +
  `IssueInstant="${DateTime.formatIso(input.issueInstant)}" Destination="${escapeXml(input.destination)}" ` +
  `InResponseTo="${escapeXml(input.inResponseTo)}">` +
  `<saml:Issuer>${escapeXml(input.issuer)}</saml:Issuer>` +
  `<samlp:Status><samlp:StatusCode Value="${input.success ? STATUS_SUCCESS_URI : STATUS_REQUESTER}"/></samlp:Status>` +
  `</samlp:LogoutResponse>`;

/** The metadata is not usable as an IdP description; `detail` is a constant sentence, never an excerpt. */
export class InvalidMetadata extends Data.TaggedError("InvalidMetadata")<{
  readonly detail: string;
}> {}

const invalid = (detail: string) => new InvalidMetadata({ detail });

export interface IdpMetadata {
  readonly entityId: string;
  /** The HTTP-Redirect single sign-on URL. */
  readonly ssoUrl: string;
  /** Signing certificates (PEM), from `KeyDescriptor use="signing"` or an unmarked one. */
  readonly certificates: ReadonlyArray<string>;
  /** BEH-EA-306: the IdP's Single Logout endpoint and its binding (Redirect preferred over POST), when it offers one. */
  readonly slo?: { readonly url: string; readonly binding: "redirect" | "post" } | undefined;
  /** BEH-EA-305: the IdP says it requires signed AuthnRequests (`WantAuthnRequestsSigned="true"`). */
  readonly wantsSignedRequests: boolean;
}

const md = (localName: string): XmlSignature.ElementName => ({ namespace: NS_METADATA, localName });
const ds = (localName: string): XmlSignature.ElementName => ({ namespace: NS_DSIG, localName });

const pemOf = (base64: string): string => {
  const body = base64.replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
};

/**
 * Reads an IdP's metadata document through `SafeXml` (size cap, no DOCTYPE, no comments). The certificates it
 * lists become a connection's trust set, so importing metadata is trusting whatever channel delivered it: fetch it
 * over TLS from the IdP's own URL, or paste it from the IdP administrator; the fingerprints are what get pinned.
 */
export const parseIdpMetadata = Effect.fnUntraced(function* (xml: string) {
  const root = yield* SafeXml.parse(xml);
  if (!SafeXml.isNamed(root, md("EntityDescriptor"))) {
    return yield* Effect.fail(invalid("the document is not SAML metadata"));
  }
  const entityId = SafeXml.attribute(root, "entityID");
  if (entityId === undefined || entityId === "") {
    return yield* Effect.fail(invalid("the metadata names no entityID"));
  }
  const descriptors = SafeXml.childrenNamed(root, md("IDPSSODescriptor"));
  const descriptor = descriptors[0];
  if (descriptors.length !== 1 || descriptor === undefined) {
    return yield* Effect.fail(invalid("the metadata must carry exactly one IDPSSODescriptor"));
  }
  const redirect = SafeXml.childrenNamed(descriptor, md("SingleSignOnService")).find(
    (service) => SafeXml.attribute(service, "Binding") === BINDING_REDIRECT,
  );
  const ssoUrl = redirect === undefined ? undefined : SafeXml.attribute(redirect, "Location");
  if (ssoUrl === undefined) {
    return yield* Effect.fail(
      invalid("the metadata offers no HTTP-Redirect single sign-on service"),
    );
  }
  const certificates: Array<string> = [];
  for (const key of SafeXml.childrenNamed(descriptor, md("KeyDescriptor"))) {
    const use = SafeXml.attribute(key, "use");
    if (use !== undefined && use !== "signing") continue;
    for (const element of SafeXml.allElements(key)) {
      if (!SafeXml.isNamed(element, ds("X509Certificate"))) continue;
      const text = SafeXml.textOf(element);
      const pem = text === undefined ? undefined : pemOf(text);
      if (pem === undefined || fingerprintOfPem(pem) === undefined) {
        return yield* Effect.fail(invalid("a metadata certificate is not a certificate"));
      }
      certificates.push(pem);
    }
  }
  if (certificates.length === 0) {
    return yield* Effect.fail(invalid("the metadata lists no signing certificate"));
  }
  const logoutServices = SafeXml.childrenNamed(descriptor, md("SingleLogoutService"));
  const logoutOf = (binding: string) =>
    logoutServices.find((service) => SafeXml.attribute(service, "Binding") === binding);
  const redirectLogout = SafeXml.attribute(logoutOf(BINDING_REDIRECT) ?? descriptor, "Location");
  const postLogout = SafeXml.attribute(logoutOf(BINDING_POST) ?? descriptor, "Location");
  const slo =
    logoutOf(BINDING_REDIRECT) !== undefined && redirectLogout !== undefined
      ? ({ url: redirectLogout, binding: "redirect" } as const)
      : logoutOf(BINDING_POST) !== undefined && postLogout !== undefined
        ? ({ url: postLogout, binding: "post" } as const)
        : undefined;
  const result: IdpMetadata = {
    entityId,
    ssoUrl,
    certificates,
    slo,
    wantsSignedRequests: SafeXml.attribute(descriptor, "WantAuthnRequestsSigned") === "true",
  };
  return result;
});
