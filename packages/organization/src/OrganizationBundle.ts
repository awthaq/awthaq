// @awthaq/organization — OrganizationBundle
//
// Plan 08 (BEH-EA-T4): the plugin's record stores as two matched layers, `Organization.records`: the same
// eight stores over memory and over SQL, and nothing else. A host picks one the way it picks a database;
// `TestAuth.layer` selects one per composition. `ConnectionRecords` is in the bundle although
// `Organization.layer` does not require it itself: it backs the plugin's own `organization_oauth_connection*`
// tables, which `OrganizationConnections` and `Sso` use.
//
// memory: single-process by construction (every store is a `Ref`), lost on restart; the stores need
// `Crypto` for their ids and `Encryption` for the sealed connection secret.
// sql: every store over the one `SqlClient`; `Encryption` seals the connection client secret.

import type { Encryption } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ActiveContextRecords from "./ActiveContextRecords.ts";
import * as ConnectionRecords from "./ConnectionRecords.ts";
import * as DomainClaims from "./DomainClaims.ts";
import * as InvitationRecords from "./InvitationRecords.ts";
import * as MembershipRecords from "./MembershipRecords.ts";
import * as OrganizationRecords from "./OrganizationRecords.ts";
import * as OrgRoleRecords from "./OrgRoleRecords.ts";
import * as TeamRecords from "./TeamRecords.ts";

/** Named so the bundle layers' inferred types can be emitted (TS2883 needs the `Encryption` namespace in scope). */
export type BundleEncryption = Encryption.Encryption;

/**
 * `ConnectionRecords.layerMemory` also provides `MemoryEnvelopes`, a test seam that is not a store; a bundle
 * provides record stores only, so it is projected away here (a suite that plants envelopes uses
 * `ConnectionRecords.layerMemory` directly).
 */
const connectionsMemory = Layer.effect(
  ConnectionRecords.ConnectionRecords,
  Effect.service(ConnectionRecords.ConnectionRecords),
).pipe(Layer.provide(ConnectionRecords.layerMemory));

export const memory = Layer.mergeAll(
  OrganizationRecords.layerMemory,
  MembershipRecords.layerMemory,
  ActiveContextRecords.layerMemory,
  InvitationRecords.layerMemory,
  OrgRoleRecords.layerMemory,
  TeamRecords.layerMemory,
  connectionsMemory,
  DomainClaims.layerMemory,
);

export const sql = Layer.mergeAll(
  OrganizationRecords.layerSql,
  MembershipRecords.layerSql,
  ActiveContextRecords.layerSql,
  InvitationRecords.layerSql,
  OrgRoleRecords.layerSql,
  TeamRecords.layerSql,
  ConnectionRecords.layerSql,
  DomainClaims.layerSql,
);
