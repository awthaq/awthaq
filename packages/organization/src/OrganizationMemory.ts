// @awthaq/organization — OrganizationMemory
//
// ELC-004: every record store the Organization plugin reads, over memory, as one layer. Each
// record layer's `layerMemory` needs `Crypto` (for its ids), so a composition used to list six
// `layerMemory` layers and repeat the same `Layer.provide(NodeCrypto.layer)` on each; this asks
// for `Crypto` once. Single-process by construction, exactly like the layers it merges: for
// anything with more than one instance the record stores need a durable backend. The hook
// points' own defaults are a separate layer (`OrganizationHooks.OrganizationHooksLive`) because a
// composition may want its own taps.

import * as Layer from "effect/Layer";
import * as ActiveContextRecords from "./ActiveContextRecords.ts";
import * as InvitationRecords from "./InvitationRecords.ts";
import * as MembershipRecords from "./MembershipRecords.ts";
import * as OrganizationRecords from "./OrganizationRecords.ts";
import * as OrgRoleRecords from "./OrgRoleRecords.ts";
import * as TeamRecords from "./TeamRecords.ts";

export const layer = Layer.mergeAll(
  OrganizationRecords.layerMemory,
  MembershipRecords.layerMemory,
  ActiveContextRecords.layerMemory,
  InvitationRecords.layerMemory,
  OrgRoleRecords.layerMemory,
  TeamRecords.layerMemory,
);
