// @awthaq/organization — OrganizationPersonalData
//
// This plugin's parts of the account erasure (ADR-EA-031) and the data-subject export (CSG-005).

import { DataExport, Erasure, Retention } from "@awthaq/core";
import { TenantScoped } from "@awthaq/sql";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ActiveContextRecords from "./ActiveContextRecords.ts";
import * as InvitationRecords from "./InvitationRecords.ts";
import * as MembershipRecords from "./MembershipRecords.ts";
import * as OrganizationConfig from "./OrganizationConfig.ts";
import * as TeamRecords from "./TeamRecords.ts";

// ---- cross-organization witnesses (plan 05, ADR-EA-018 decision 10) ----------------------

/** The erasure cascade removes a user everywhere. */
const erasureGrant = TenantScoped.crossTenant(
  "organization erasure (CSG-001/DRS-002/DRS-008): deleting a user removes them from every organization",
);
/** The data-subject export reads a user's rows everywhere. */
const exportGrant = TenantScoped.crossTenant(
  "organization data-subject export (CSG-005): a user's memberships, teams and invitations across organizations",
);

/**
 * CSG-001/DRS-002 (.issues/high), wayfinder ticket 30: this plugin's part of
 * `AccountErasure.eraseAccount`, part of `Organization.layer` itself (it requires
 * `Erasure.ErasureRegistry`, so a composition without one does not compile). It
 * removes every row that names the erased user: their memberships, their team
 * memberships (`memberCount`s decremented), the invitations they sent or that
 * were addressed to their email (the row holds it in plaintext), and their
 * active-context rows (DRS-008). It runs inside `eraseAccount`'s transaction.
 */
export const organizationErasure = Erasure.contribute({
  id: "organization",
  make: Effect.gen(function* () {
    const members = yield* MembershipRecords.MembershipRecords;
    const teams = yield* TeamRecords.TeamRecords;
    const invitations = yield* InvitationRecords.InvitationRecords;
    const activeContext = yield* ActiveContextRecords.ActiveContextRecords;
    return (subject: Erasure.ErasureSubject) =>
      Effect.all(
        [
          teams.removeUserFromAllTeams(erasureGrant, subject.userId),
          members.deleteAllByUser(erasureGrant, subject.userId),
          activeContext.deleteAllByUser(erasureGrant, subject.userId),
          invitations.removeAllForUser(erasureGrant, subject.userId, subject.email),
        ],
        { discard: true },
      );
  }),
});

/**
 * CSG-005: this plugin's section of the data-subject export — the organizations the person
 * belongs to and their role in each, the teams they are on, and the invitations they sent
 * or received. An invitation carries no third party's address (the invitee's email is
 * their data, not the subject's), and a role is a name, never a permission secret.
 */
export const organizationExport = DataExport.contribute({
  id: "organization",
  make: Effect.gen(function* () {
    const members = yield* MembershipRecords.MembershipRecords;
    const teams = yield* TeamRecords.TeamRecords;
    const invitations = yield* InvitationRecords.InvitationRecords;
    const invitationView = (row: InvitationRecords.InvitationRecord) => ({
      organizationId: row.organizationId,
      role: [...row.role],
      status: row.status,
      createdAt: DateTime.formatIso(row.createdAt),
      expiresAt: DateTime.formatIso(row.expiresAt),
    });
    return (subject: DataExport.DataExportSubject) =>
      Effect.gen(function* () {
        const memberships = yield* members.listByUser(exportGrant, subject.userId);
        const teamRows = yield* Effect.forEach(memberships, (membership) =>
          teams.listTeamsByUser(membership.organizationId, subject.userId),
        );
        return {
          memberships: memberships.map((membership) => ({
            organizationId: membership.organizationId,
            role: [...membership.role],
            createdAt: DateTime.formatIso(membership.createdAt),
          })),
          teams: teamRows.flat().map((team) => ({
            id: team.id,
            organizationId: team.organizationId,
            name: team.name,
          })),
          invitationsSent: (yield* invitations.listByInviter(exportGrant, subject.userId)).map(
            invitationView,
          ),
          invitationsReceived: (subject.email === undefined
            ? []
            : yield* invitations.listByEmail(exportGrant, subject.email)
          ).map(invitationView),
        };
      });
  }),
});

/** The retention sweep reaches every organization's invitation rows. */
const retentionGrant = TenantScoped.crossTenant(
  "organization retention (plan 10 item 6): invitations past their expiry are swept in every organization",
);

/**
 * Plan 10 item 6: an invitation nobody answers (or that was answered long ago) is never deleted
 * except with its organization or its invitee, so the table grows for ever. `Retention.sweep` removes
 * the rows `invitationRetention` past their `expiresAt`.
 */
export const organizationInvitationRetention = Retention.contribute({
  id: "organization.invitations",
  make: Effect.gen(function* () {
    const invitations = yield* InvitationRecords.InvitationRecords;
    const settings = yield* OrganizationConfig.OrganizationConfig;
    return (now: DateTime.Utc) =>
      invitations.purgeExpired(
        retentionGrant,
        DateTime.subtractDuration(now, settings.invitationRetention),
      );
  }),
});
