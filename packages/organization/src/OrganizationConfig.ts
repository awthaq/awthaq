// @awthaq/organization — OrganizationConfig
//
// The plugin's configuration reference and its builder. A leaf file: every organization module
// reads `OrganizationConfig` per operation (ADR-EA-018 decision 8) without importing the plugin.

import { Users } from "@awthaq/core";
import { Defects } from "@awthaq/ports";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as OrganizationRecords from "./OrganizationRecords.ts";
import * as PermissionEngine from "./PermissionEngine.ts";

// ---- config -------------------------------------------------------------------

/**
 * EP-006: per-organization quota overrides, merged over the static
 * `OrganizationConfigShape` values at decision time by `limitsFor`.
 */
export interface OrganizationLimits {
  readonly membershipLimit?: number;
  readonly invitationLimit?: number;
  readonly maximumTeams?: number;
  readonly maximumMembersPerTeam?: number;
  readonly maximumRolesPerOrganization?: number;
}

export interface OrganizationConfigShape {
  /** spec.md: role assigned to the creating user. */
  readonly creatorRole: "owner" | "admin";
  /** spec.md: fail-open by default — every caller may create an organization unless configured otherwise. */
  readonly allowUserToCreateOrganization: (userId: Users.UserId) => Effect.Effect<boolean>;
  /**
   * Max organizations a single user may own (own = holds `owner` on it).
   * EP-006: finite by default (10) so an open sign-up cannot mint unbounded
   * tenants; `Infinity` opts out.
   */
  readonly organizationLimit: number;
  /** Max memberships per organization. */
  readonly membershipLimit: number;
  /**
   * EP-006 (ADR-EA-018): quota overrides for one organization, consulted at
   * decision time and merged over the static limits (`membershipLimit`,
   * `invitationLimit`, `teams.maximumTeams`, `teams.maximumMembersPerTeam`,
   * `dynamicAccessControl.maximumRolesPerOrganization`) — so a plan tier or a
   * negotiated quota changes without redeploying or reconfiguring the plugin
   * tuple. Unset means every organization uses the static values.
   */
  readonly limitsFor?: (organizationId: string) => Effect.Effect<OrganizationLimits>;
  /**
   * DRS-007: the residency vocabulary an organization's `homeRegion` must come
   * from (`["eu-west", "us-east"]`). Empty by default, which refuses any
   * `homeRegion` — a deployment that pins tenants opts in by listing regions.
   */
  readonly regions: ReadonlyArray<string>;
  readonly disableOrganizationDeletion: boolean;
  /** Custom static roles an application layers on top of `PermissionEngine.defaultStatements`. */
  readonly permissionStatements: Readonly<Record<string, PermissionEngine.Statements>>;
  readonly dynamicAccessControl: {
    readonly enabled: boolean;
    readonly maximumRolesPerOrganization: number;
  };
  readonly teams: {
    readonly enabled: boolean;
    readonly maximumTeams: number;
    readonly maximumMembersPerTeam: number;
    readonly allowRemovingAllTeams: boolean;
  };
  /**
   * OHS-004: team-scoped roles a `TeamMembershipRecord` can hold, each mapped to
   * the `team` statements it confers on *that team and its descendants*, on top of
   * whatever the caller's organization roles already grant. `team:create` lets a
   * holder create child teams under the team, `team:update` rename/move it and
   * manage its roster and roles, `team:delete` remove it. `member` (no
   * statements) is always defined and is the default; the default `lead` may
   * update its team.
   */
  readonly teamStatements: Readonly<Record<string, PermissionEngine.Statements>>;
  readonly invitationExpiresIn: Duration.Duration;
  readonly invitationLimit: number;
  readonly cancelPendingInvitationsOnReInvite: boolean;
  readonly requireEmailVerificationOnInvitation: boolean;
}

const defaultOrganizationConfig: OrganizationConfigShape = {
  creatorRole: "owner",
  allowUserToCreateOrganization: () => Effect.succeed(true),
  organizationLimit: 10,
  membershipLimit: 100,
  regions: [],
  disableOrganizationDeletion: false,
  permissionStatements: {},
  dynamicAccessControl: { enabled: false, maximumRolesPerOrganization: Number.POSITIVE_INFINITY },
  teams: {
    enabled: false,
    maximumTeams: Number.POSITIVE_INFINITY,
    maximumMembersPerTeam: Number.POSITIVE_INFINITY,
    allowRemovingAllTeams: false,
  },
  teamStatements: { lead: { team: ["update"] } },
  invitationExpiresIn: Duration.hours(48),
  invitationLimit: 100,
  cancelPendingInvitationsOnReInvite: false,
  // EP-010: an invitation is addressed to an email, so membership is conferred
  // only on a verified owner of that address; `false` restores the old behavior.
  requireEmailVerificationOnInvitation: true,
};

/**
 * DRS-007: the pure routing helper — an application maps an organization to its
 * shard or database with this, never by reading the record's storage shape.
 */
export const homeRegionOf = (
  record: OrganizationRecords.OrganizationRecord,
): Option.Option<string> => record.homeRegion;

export const OrganizationConfig: Context.Reference<OrganizationConfigShape> = Context.Reference(
  "awthaq/organization/Config",
  { defaultValue: () => defaultOrganizationConfig },
);

export const config = (partial: Partial<OrganizationConfigShape>) => {
  // RZS-005/N8: a static custom role may not redefine a built-in tier — fail
  // at layer build rather than silently ignoring (or honoring) the override.
  const reserved = Object.keys(partial.permissionStatements ?? {}).filter(
    PermissionEngine.isBuiltInRole,
  );
  return reserved.length > 0
    ? Layer.effect(
        OrganizationConfig,
        Defects.invalidConfiguration(
          "permissionStatements",
          `awthaq: Organization.config permissionStatements may not redefine the built-in role(s): ${reserved.join(", ")}`,
        ),
      )
    : Layer.succeed(OrganizationConfig, { ...defaultOrganizationConfig, ...partial });
};
