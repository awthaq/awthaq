// AH-003 (decision 36, Tier 2): the real `@awthaq/organization` stores plus its qadi
// `relationships` resolver, composed the way `packages/organization/test/OrganizationQadi.test.ts`
// does, for 21-qadi-resolvers-obligations.feature (BEH-EA-162). The one seam an application owns is
// `ResourceOrganizationLookup` (which organization a resource belongs to); `probe` lets a scenario
// steer and observe it.
import { Auth } from "@awthaq/core";
import {
  DomainClaims,
  Organization,
  OrganizationActiveContext,
  OrganizationAuthority,
  OrganizationDeletion,
  OrganizationDirectory,
  OrganizationHooks,
  OrganizationInvitations,
  OrganizationMembers,
  OrganizationQadi,
  OrganizationRoles,
  OrganizationTeams,
} from "@awthaq/organization";
import {
  ActiveContextRecords,
  ConnectionRecords,
  InvitationRecords,
  MembershipRecords,
  OrganizationRecords,
  OrgRoleRecords,
  TeamRecords,
} from "@awthaq/organization/records";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { TestAuth } from "@awthaq/test";

/** What a scenario steers and observes about the application's resource -> organization walk. */
export interface WalkProbe {
  /** resource id -> the organization that owns it */
  readonly parents: Ref.Ref<Readonly<Record<string, string>>>;
  /** every resource id the resolver asked the lookup about */
  readonly consulted: Ref.Ref<ReadonlyArray<string>>;
  /** when true the lookup itself fails (the "organization-membership lookup fails while walking" case) */
  readonly failing: Ref.Ref<boolean>;
}

/** The application's own lookup failing (a database outage behind it). */
class LookupDown extends Data.TaggedError("LookupDown")<{ readonly reason: string }> {}

export const makeWalkProbe = (): WalkProbe => ({
  parents: Ref.makeUnsafe<Readonly<Record<string, string>>>({}),
  consulted: Ref.makeUnsafe<ReadonlyArray<string>>([]),
  failing: Ref.makeUnsafe(false),
});

const OrganizationLive = TestAuth.layer(Auth.make([Organization.Organization]), {
  services: Organization.config({}),
});

export const organizationFixture = (probe: WalkProbe) => {
  const lookup = Layer.succeed(
    OrganizationQadi.ResourceOrganizationLookup,
    OrganizationQadi.ResourceOrganizationLookup.of({
      organizationOf: (resourceId) =>
        Effect.gen(function* () {
          yield* Ref.update(probe.consulted, (seen) => [...seen, resourceId]);
          if (yield* Ref.get(probe.failing)) {
            return yield* Effect.fail(
              new LookupDown({ reason: "organization-membership lookup is down" }),
            );
          }
          return Option.fromNullishOr((yield* Ref.get(probe.parents))[resourceId]);
        }),
    }),
  );
  return OrganizationQadi.relationships.pipe(
    Layer.provide(lookup),
    Layer.provideMerge(OrganizationLive),
  );
};

/**
 * The organization services and record stores the fixture's layer provides, named so its inferred type can
 * be emitted (declaration emit needs each namespace in scope).
 */
export type OrganizationServiceNames =
  | OrganizationActiveContext.OrganizationActiveContext
  | OrganizationAuthority.OrganizationAuthority
  | OrganizationDeletion.OrganizationDeletion
  | OrganizationDirectory.OrganizationDirectory
  | OrganizationInvitations.OrganizationInvitations
  | OrganizationMembers.OrganizationMembers
  | OrganizationRoles.OrganizationRoles
  | OrganizationTeams.OrganizationTeams
  | ActiveContextRecords.ActiveContextRecords
  | InvitationRecords.InvitationRecords
  | MembershipRecords.MembershipRecords
  | OrganizationRecords.OrganizationRecords
  | OrgRoleRecords.OrgRoleRecords
  | TeamRecords.TeamRecords
  | ConnectionRecords.ConnectionRecords
  | DomainClaims.DomainClaims
  | OrganizationHooks.AfterCreateOrganization;

export type OrganizationFixtureServices = Layer.Success<ReturnType<typeof organizationFixture>>;
