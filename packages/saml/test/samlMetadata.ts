// Fixtures for the metadata, signing and logout suites: IdP metadata as an administrator would paste it (or a URL would serve
// it), the certificates an SP metadata document publishes, and the redirect binding as the IdP's side sees it.
import { NS, idp } from "./samlFixtures.ts";

export interface IdpMetadataOptions {
  readonly certs?: ReadonlyArray<string>;
  readonly entityId?: string;
  readonly ssoUrl?: string;
  /** `redirect`/`post` single-logout endpoints, by location. */
  readonly slo?: { readonly redirect?: string; readonly post?: string };
  readonly wantAuthnRequestsSigned?: boolean;
  readonly redirectSso?: boolean;
}

const certBody = (pem: string) => pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");

/** IdP metadata as an administrator would paste it (or a URL would serve it). */
export const idpMetadataXml = (options: IdpMetadataOptions = {}): string =>
  `<?xml version="1.0"?><md:EntityDescriptor xmlns:md="${NS.md}" xmlns:ds="${NS.ds}" entityID="${options.entityId ?? "https://idp.example.com/metadata"}">` +
  `<md:IDPSSODescriptor WantAuthnRequestsSigned="${options.wantAuthnRequestsSigned === true}" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">` +
  (options.certs ?? [idp.cert])
    .map(
      (pem) =>
        `<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certBody(pem)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`,
    )
    .join("") +
  (options.slo?.redirect === undefined
    ? ""
    : `<md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${options.slo.redirect}"/>`) +
  (options.slo?.post === undefined
    ? ""
    : `<md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${options.slo.post}"/>`) +
  (options.redirectSso === false
    ? `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.com/post"/>`
    : `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${options.ssoUrl ?? "https://idp.example.com/sso"}"/>`) +
  `</md:IDPSSODescriptor></md:EntityDescriptor>`;

/** The PEM certificates an SP metadata document publishes as signing keys. */
export const certificatesInSpMetadata = (metadata: string): ReadonlyArray<string> =>
  [...metadata.matchAll(/<ds:X509Certificate>([^<]+)<\/ds:X509Certificate>/g)].map(
    (match) => `-----BEGIN CERTIFICATE-----\n${match[1] ?? ""}\n-----END CERTIFICATE-----\n`,
  );

/** What a redirect-binding URL carries, raw: the octets a signature covers and the (decoded) signature and algorithm. */
export const redirectParts = (location: string) => {
  const raw = location.slice(location.indexOf("?") + 1);
  const rawOf = (name: string) =>
    raw
      .split("&")
      .find((pair) => pair.startsWith(`${name}=`))
      ?.slice(name.length + 1);
  const kind = rawOf("SAMLRequest") === undefined ? "SAMLResponse" : "SAMLRequest";
  const message = rawOf(kind) ?? "";
  const relay = rawOf("RelayState");
  const sigAlg = rawOf("SigAlg");
  const signature = rawOf("Signature");
  return {
    raw,
    kind,
    message,
    relay,
    sigAlg: sigAlg === undefined ? undefined : decodeURIComponent(sigAlg),
    signature: signature === undefined ? undefined : decodeURIComponent(signature),
    octets:
      sigAlg === undefined
        ? undefined
        : `${kind}=${message}${relay === undefined ? "" : `&RelayState=${relay}`}&SigAlg=${sigAlg}`,
  };
};
