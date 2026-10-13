// @awthaq/organization — OrganizationSystem
//
// The system interfaces `Organization.layer` exposes (`AuthPlugin.layer`'s `exposes`, ADR-EA-040):
// one module per sub-domain, each taking an explicit `Actor`, each owning its invariants, hook
// points, events and transactions. Another plugin (SCIM, SAML, AdminTenants) or application code
// requires them through the Layer type and lists `Organization` in `dependsOn`; none of them
// touches the records.

import type { AuthEvents } from "@awthaq/core";
import type { SqlTransaction } from "@awthaq/ports";
import * as OrganizationAuthority from "./OrganizationAuthority.ts";
import * as OrganizationMembers from "./OrganizationMembers.ts";
import * as OrganizationTeams from "./OrganizationTeams.ts";
import * as Layer from "effect/Layer";

/** The tags the plugin exposes, for the manifest (`plugin list --graph`). */
export const services = [
  OrganizationTeams.OrganizationTeams,
  OrganizationMembers.OrganizationMembers,
  OrganizationAuthority.OrganizationAuthority,
] as const;

/** Built once, beneath the plugin's own `make`. */
export const layer = Layer.mergeAll(
  OrganizationTeams.OrganizationTeams.layer,
  OrganizationMembers.OrganizationMembers.layer,
).pipe(Layer.provideMerge(OrganizationAuthority.OrganizationAuthority.layer));

/**
 * The core services and port `layer` requires beyond the plugin's own records and hook points.
 * Named here so the layer's inferred type can be emitted (it needs both namespaces in scope).
 */
export type CoreRequirements = AuthEvents.AuthEvents | SqlTransaction.SqlTransaction;
