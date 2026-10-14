// @awthaq/organization — OrganizationSystem
//
// The system interfaces `Organization.layer` exposes (`AuthPlugin.layer`'s `exposes`, ADR-EA-040):
// one module per sub-domain, each taking an explicit `Actor`, each owning its invariants, hook
// points, events and transactions. Another plugin (SCIM, SAML, AdminTenants) or application code
// requires them through the Layer type and lists `Organization` in `dependsOn`; none of them
// touches the records.

import type { AuthEvents, Users } from "@awthaq/core";
import type { Mailer, SqlTransaction } from "@awthaq/ports";
import * as OrganizationActiveContext from "./OrganizationActiveContext.ts";
import * as OrganizationAuthority from "./OrganizationAuthority.ts";
import * as OrganizationDeletion from "./OrganizationDeletion.ts";
import * as OrganizationDirectory from "./OrganizationDirectory.ts";
import * as OrganizationInvitations from "./OrganizationInvitations.ts";
import * as OrganizationMembers from "./OrganizationMembers.ts";
import * as OrganizationRoles from "./OrganizationRoles.ts";
import * as OrganizationTeams from "./OrganizationTeams.ts";
import * as Layer from "effect/Layer";

/** The tags the plugin exposes, for the manifest (`plugin list --graph`). */
export const services = [
  OrganizationDirectory.OrganizationDirectory,
  OrganizationTeams.OrganizationTeams,
  OrganizationMembers.OrganizationMembers,
  OrganizationInvitations.OrganizationInvitations,
  OrganizationRoles.OrganizationRoles,
  OrganizationActiveContext.OrganizationActiveContext,
  OrganizationAuthority.OrganizationAuthority,
  OrganizationDeletion.OrganizationDeletion,
] as const;

/** Built once, beneath the plugin's own `make`. */
export const layer = Layer.mergeAll(
  OrganizationTeams.OrganizationTeams.layer,
  OrganizationMembers.OrganizationMembers.layer,
  OrganizationInvitations.OrganizationInvitations.layer,
  OrganizationRoles.OrganizationRoles.layer,
  OrganizationActiveContext.OrganizationActiveContext.layer,
).pipe(
  Layer.provideMerge(OrganizationAuthority.OrganizationAuthority.layer),
  Layer.provideMerge(OrganizationDirectory.OrganizationDirectory.layer),
  Layer.provideMerge(OrganizationDeletion.OrganizationDeletion.layer),
);

/**
 * The core services and port `layer` requires beyond the plugin's own records and hook points.
 * Named here so the layer's inferred type can be emitted (it needs both namespaces in scope).
 */
export type CoreRequirements =
  | AuthEvents.AuthEvents
  | Users.Users
  | Mailer.Mailer
  | SqlTransaction.SqlTransaction;
