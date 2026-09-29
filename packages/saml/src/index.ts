// @awthaq/saml — Plugin
//
// SAML 2.0 service provider (SP only): SP-initiated login through an organization's own identity provider,
// its assertions verified behind the `XmlSignature` port (SFS-003, SFS-001, SFS-007; ADR-EA-023).
//
// spec/behaviors/29-saml-sp.md, BEH-EA-238 through 245; spec/models/10-saml.md.
// See spec/overview.md for the full package map.

export * as SafeXml from "./SafeXml.ts";
export * as Saml from "./Saml.ts";
export * as SamlApi from "./SamlApi.ts";
export * as SamlAssertion from "./SamlAssertion.ts";
export * as SamlConnections from "./SamlConnections.ts";
export * as SamlProtocol from "./SamlProtocol.ts";
export * as SamlRecords from "./SamlRecords.ts";
export * as XmlSignatureNode from "./XmlSignatureNode.ts";
