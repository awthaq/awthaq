// Shared composition for the SCIM suites: the real in-memory core, the organization
// plugin (`Scim` `dependsOn: [Organization]`), the SCIM records, connection store and
// bearer authentication — the same layer graph an application builds.
import { Api } from "@awthaq/api";
import {
  Accounts,
  AuditLog,
  AuthEvents,
  Erasure,
  Hooks,
  Persistence,
  Sessions,
  Users,
  Verification,
} from "@awthaq/core";
import { Organization, OrganizationHooks, OrganizationMemory } from "@awthaq/organization";
import { Mailer, SqlTransaction } from "@awthaq/ports";
import { Authentication, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Scim from "../src/Scim.ts";
import * as ScimApi from "../src/ScimApi.ts";
import * as ScimConnections from "../src/ScimConnections.ts";
import * as ScimRecords from "../src/ScimRecords.ts";

const UsersInMemory = Users.layer.pipe(Layer.provide(Persistence.memory));

const CoreLive = (users: typeof UsersInMemory, hooks: typeof Hooks.HooksLive) =>
  Layer.mergeAll(
    Sessions.layer.pipe(Layer.provide(Persistence.memory)),
    Accounts.layer.pipe(Layer.provide(Persistence.memory)),
    Verification.layer.pipe(Layer.provide(Persistence.memory)),
    users,
  ).pipe(
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layer.pipe(Layer.provide(Persistence.memory))),
    Layer.provideMerge(hooks),
    Layer.provideMerge(NodeCrypto.layer),
  );

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make("scim-test-csrf-secret-padded-to-thirty-two-bytes-long"),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

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

/** The organization plugin and every records store it needs, in memory. */
const OrganizationLive = (options: Partial<Organization.OrganizationConfigShape> = {}) =>
  Organization.Organization.layer.pipe(
    Layer.provide(Organization.config({ teams: groupsTeams, ...options })),
    Layer.provide(AuthenticationLive),
    Layer.provide(CsrfProtectionLive),
  );

/**
 * `Scim` over in-memory storage. `ScimRecords.layerMemory` is shared by the plugin, the
 * connection store and the bearer authentication (one `Ref`), so a token created through
 * the store authenticates through the plugin.
 */
export const ScimLive = (
  scimConfig: Partial<Scim.ScimConfigShape> = {},
  organizationConfig: Partial<Organization.OrganizationConfigShape> = {},
  users: typeof UsersInMemory = Users.layer.pipe(Layer.provide(Persistence.memory)),
  // P20a: a composition with a tap installed on a hook point (e.g. a `beforeDelete` veto) passes
  // `Tap.pipe(Layer.provideMerge(Hooks.HooksLive))` here.
  hooks: typeof Hooks.HooksLive = Hooks.HooksLive,
  // Plan 04: taps on the organization hook points (a team veto, an observer counting departures),
  // installed on the points this composition builds. A tap's layer requires its point.
  taps: Layer.Layer<
    never,
    never,
    Layer.Success<typeof OrganizationHooks.OrganizationHooksLive>
  > = Layer.empty,
) =>
  Scim.Scim.layer.pipe(
    Layer.provide(Scim.config(scimConfig)),
    Layer.provideMerge(OrganizationLive(organizationConfig)),
    Layer.provideMerge(ScimRecords.layerMemory),
    Layer.provideMerge(OrganizationMemory.layer),
    // `AccountErasure` (SCIM `erase` runs the ADR-EA-031 cascade) shares the one `ErasureRegistry`
    // from `hooks` with the organization and SCIM contributions.
    Layer.provideMerge(Erasure.layer),
    Layer.provideMerge(CoreLive(users, hooks)),
    Layer.provideMerge(Mailer.layerMemory),
    Layer.provideMerge(SqlTransaction.layerNoop),
    Layer.provideMerge(taps),
    Layer.provideMerge(OrganizationHooks.OrganizationHooksLive),
  );

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
