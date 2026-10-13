// Shared composition for the SCIM suites: `Auth.make([Organization, Scim])` through `TestAuth.layer` (plan 08), so the
// real in-memory core, the organization plugin (`Scim` `dependsOn: [Organization]`), the SCIM records, connection
// store and bearer authentication come from the plugins' own declarations: the same layer graph an application builds.
import { Api } from "@awthaq/api";
import { Auth, Erasure, Hooks, Users } from "@awthaq/core";
import { Organization, OrganizationHooks } from "@awthaq/organization";
import { TestAuth } from "@awthaq/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Scim from "../src/Scim.ts";
import * as ScimApi from "../src/ScimApi.ts";
import * as ScimConnections from "../src/ScimConnections.ts";

const built = Auth.make([Organization.Organization, Scim.Scim]);

/**
 * SCIM Groups are organization teams, so they need `teams.enabled` (plan 04, BEH-EA-251). The default
 * keeps the groups tests meaningful: teams on, no quotas, and a directory may delete every group
 * (`allowRemovingAllTeams`); a test that checks a refusal overrides it.
 */
export const groupsTeams = {
  enabled: true,
  maximumTeams: Number.POSITIVE_INFINITY,
  maximumMembersPerTeam: Number.POSITIVE_INFINITY,
  allowRemovingAllTeams: true,
};

/**
 * `Scim` over in-memory storage. `ScimRecords` is shared by the plugin, the connection store and the bearer
 * authentication (one `Ref`), so a token created through the store authenticates through the plugin.
 *
 * `users` is a `Users` the suite substitutes for the plugins and the test alike (an outage, an erasure between
 * reads: `TestAuth.layer`'s `decorate`). `taps` are application taps installed on the hook points the
 * composition builds, core's (`Hooks.BeforeSignUp`) and the organization's: a tap's layer requires its point.
 */
export const ScimLive = (
  scimConfig: Partial<Scim.ScimConfigShape> = {},
  organizationConfig: Partial<Organization.OrganizationConfigShape> = {},
  users?: Layer.Layer<Users.Users, never, Users.Users>,
  taps: Layer.Layer<
    never,
    never,
    | Hooks.BeforeSignUp
    | Hooks.BeforeUserDelete
    | Layer.Success<typeof OrganizationHooks.OrganizationHooksLive>
  > = Layer.empty,
) =>
  TestAuth.layer(built, {
    services: Layer.mergeAll(
      Scim.config(scimConfig),
      Organization.config({ teams: groupsTeams, ...organizationConfig }),
      // A substituted `Users` must reach the erasure cascade too (SCIM `erase` runs it): a fresh instance,
      // built over the decorated `Users`, since the base's own was built over the real one.
      ...(users === undefined ? [] : [Layer.fresh(Erasure.layer)]),
    ),
    ...(users === undefined ? {} : { decorate: users }),
    taps,
  });

const ownerPrincipal = (id: string): Api.UserPrincipal =>
  new Api.UserPrincipal({
    ref: new Api.PrincipalRef({ type: "user", id }),
    sessionId: `${id}-session`,
  });

/** An organization owned by `owner-1`, and a SCIM connection for it (its identity and bearer token). */
export const seedConnection = (name = "Okta") =>
  Effect.gen(function* () {
    const organization = yield* Organization.Organization;
    const store = yield* ScimConnections.ScimConnectionStore;
    const org = yield* organization.create({
      caller: ownerPrincipal("owner-1"),
      name: "Acme",
      slug: `acme-${name.toLowerCase()}`,
    });
    const { connection, token } = yield* store.create({ organizationId: org.id, name });
    const identity: ScimApi.ScimConnectionIdentity = {
      id: connection.id,
      organizationId: org.id,
      name: connection.name,
    };
    return { organizationId: org.id, connection: identity, token: Redacted.value(token) };
  });
