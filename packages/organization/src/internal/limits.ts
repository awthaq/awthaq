// @awthaq/organization — EP-006 quota resolution (package-private)

import * as Effect from "effect/Effect";
import type { OrganizationConfigShape, OrganizationLimits } from "../OrganizationConfig.ts";

/**
 * EP-006: the static limits with one organization's `limitsFor` overrides merged over them,
 * resolved against the configuration in force for this fiber (EP-007).
 */
export const limitsOf = (config: OrganizationConfigShape, organizationId: string) =>
  (config.limitsFor === undefined
    ? Effect.succeed<OrganizationLimits>({})
    : config.limitsFor(organizationId)
  ).pipe(
    Effect.map((override) => ({
      membershipLimit: override.membershipLimit ?? config.membershipLimit,
      invitationLimit: override.invitationLimit ?? config.invitationLimit,
      maximumTeams: override.maximumTeams ?? config.teams.maximumTeams,
      maximumMembersPerTeam: override.maximumMembersPerTeam ?? config.teams.maximumMembersPerTeam,
      maximumRolesPerOrganization:
        override.maximumRolesPerOrganization ??
        config.dynamicAccessControl.maximumRolesPerOrganization,
    })),
  );
