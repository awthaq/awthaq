// @awthaq/saml — SamlProtocol
//
// The XML this service provider *produces* and the IdP metadata it *reads*: SP metadata, the AuthnRequest and its
// HTTP-Redirect encoding (raw DEFLATE, base64, URL-encoded: SAML bindings 3.4), and IdP metadata import. Producing
// is string assembly with every interpolated value XML-escaped (no user-controlled markup); reading goes through
// `SafeXml` like every other document here.
//
// Not built: signed AuthnRequests (`AuthnRequestsSigned="false"` in the metadata says so) — the redirect binding
// signature is a query-string signature, not an XML-DSig one, and no IdP this targets requires it.

import type { XmlSignature } from "@awthaq/ports";
import { deflateRawSync } from "node:zlib";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SafeXml from "./SafeXml.ts";
import { NS_METADATA, NS_SAML, NS_SAMLP } from "./SamlAssertion.ts";
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

/** SAML bindings 3.4.4.1: DEFLATE (raw), base64, then URL-encode as the `SAMLRequest` parameter. */
export const redirectLocation = (
  ssoUrl: string,
  requestXml: string,
  relayState?: string,
): string => {
  const url = new URL(ssoUrl);
  url.searchParams.set("SAMLRequest", deflateRawSync(Buffer.from(requestXml, "utf8")).toString("base64"));
  if (relayState !== undefined) url.searchParams.set("RelayState", relayState);
  return url.toString();
};

/**
 * SP metadata for one connection: its entity id and the ACS. `WantAssertionsSigned="true"` and
 * `AuthnRequestsSigned="false"`; bearer POST binding only. Give it to the IdP administrator (or an IdP that
 * imports metadata by URL).
 */
export const spMetadataXml = (input: { readonly entityId: string; readonly acsUrl: string }): string =>
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<md:EntityDescriptor xmlns:md="${NS_METADATA}" entityID="${escapeXml(input.entityId)}">` +
  `<md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="${NS_SAMLP}">` +
  `<md:NameIDFormat>${NAMEID_EMAIL}</md:NameIDFormat>` +
  `<md:NameIDFormat>${NAMEID_PERSISTENT}</md:NameIDFormat>` +
  `<md:AssertionConsumerService Binding="${BINDING_POST}" Location="${escapeXml(input.acsUrl)}" index="0" isDefault="true"/>` +
  `</md:SPSSODescriptor></md:EntityDescriptor>`;

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
    return yield* Effect.fail(invalid("the metadata offers no HTTP-Redirect single sign-on service"));
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
  const result: IdpMetadata = { entityId, ssoUrl, certificates };
  return result;
});

