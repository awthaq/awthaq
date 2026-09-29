// @awthaq/saml — Plugin
//
// SAML 2.0 service provider (SP only): SP-initiated login through an organization's own identity provider, its assertions
// verified behind the `XmlSignature` port (SFS-003, SFS-001, SFS-007; ADR-EA-023); signed AuthnRequests; Single Logout in both
// directions; the administrator's connection CRUD with IdP metadata import from a URL or XML; organization role mapping under a
// ceiling; and the `Sso` dispatcher that routes an email domain to an OIDC or a SAML connection.
//
// spec/behaviors/29-saml-sp.md, BEH-EA-238 through 245 and 305 through 309; spec/models/10-saml.md.
// See spec/overview.md for the full package map.

export * as SafeXml from "./SafeXml.ts";
export * as Saml from "./Saml.ts";
export * as SamlAdmin from "./SamlAdmin.ts";
export * as SamlApi from "./SamlApi.ts";
export * as SamlAssertion from "./SamlAssertion.ts";
export * as SamlConnections from "./SamlConnections.ts";
export * as SamlKeys from "./SamlKeys.ts";
export * as SamlLogout from "./SamlLogout.ts";
export * as SamlMetadataFetcher from "./SamlMetadataFetcher.ts";
export * as SamlProtocol from "./SamlProtocol.ts";
export * as SamlRecords from "./SamlRecords.ts";
export * as SamlRoleMapping from "./SamlRoleMapping.ts";
export * as SamlSlo from "./SamlSlo.ts";
export * as SamlSpKeys from "./SamlSpKeys.ts";
export * as Sso from "./Sso.ts";
export * as XmlSignatureNode from "./XmlSignatureNode.ts";
