// @awthaq/scim — Plugin
//
// Inbound SCIM 2.0 (RFC 7643/7644) provisioning: an organization's identity provider
// creates, updates and deactivates its users and groups, and deactivation ends their
// sessions at once (CWM-002, AOMS-009; ADR-EA-023).
//
// spec/behaviors/30-scim.md, BEH-EA-241 through 248; spec/models/12-scim.md.
// See spec/overview.md for the full package map.

export * as Scim from "./Scim.ts";
export * as ScimApi from "./ScimApi.ts";
export * as ScimConnections from "./ScimConnections.ts";
export * as ScimRecords from "./ScimRecords.ts";
