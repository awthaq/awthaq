// Shared composition for the SCIM suites: the real in-memory core, the organization
// plugin (`Scim` `dependsOn: [Organization]`), the SCIM records, connection store and
// bearer authentication — the same layer graph an application builds.
import { Api } from "@awthaq/api";
import { AuditLog, AuthEvents, Hooks, Sessions, Users } from "@awthaq/core";
import {
  ActiveContextRecords,
  InvitationRecords,
  MembershipRecords,
  Organization,
  OrganizationHooks,
  OrganizationRecords,
  OrgRoleRecords,
  TeamRecords,
} from "@awthaq/organization";
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

const CoreLive = (users: typeof Users.layerMemory) =>
  Layer.mergeAll(Sessions.layerMemory, users).pipe(
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layerMemory),
    Layer.provideMerge(Hooks.HooksLive),
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

/** The organization plugin and every records store it needs, in memory. */
const OrganizationLive = (options: Partial<Organization.OrganizationConfigShape> = {}) =>
  Organization.Organization.layer.pipe(
    Layer.provide(Organization.config(options)),
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
  users: typeof Users.layerMemory = Users.layerMemory,
) =>
  Scim.Scim.layer.pipe(
    Layer.provide(Scim.config(scimConfig)),
    Layer.provide(ScimConnections.ScimAuthenticationLive),
    Layer.provideMerge(ScimConnections.layerStore),
    Layer.provideMerge(OrganizationLive(organizationConfig)),
    Layer.provideMerge(ScimRecords.layerMemory),
    Layer.provideMerge(CoreLive(users)),
    Layer.provideMerge(OrganizationRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(MembershipRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(ActiveContextRecords.layerMemory),
    Layer.provideMerge(InvitationRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(OrgRoleRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(TeamRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(Mailer.layerMemory),
    Layer.provideMerge(SqlTransaction.layerNoop),
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
