// @awthaq/organization — OrganizationConnections
//
// EP-004/CWM-001 (wayfinder ticket 18, ADR-EA-018, BEH-EA-235): per-organization
// OAuth/OIDC connections — the WorkOS "connection per organization" model — as
// *data*, additive to `@awthaq/oauth`'s static provider array (which stays
// exactly as is for Google/GitHub-style consumer sign-in).
//
// Three pieces, all opt-in (nothing here is required by `Organization.layer`):
//
// - `OrganizationConnections`, a `LayerMap.Service` keyed by organization id
//   (ADR-EA-005's reserved seam for keyed, per-tenant resources). Building an
//   organization's entry reads its `organization_oauth_connection` rows, decrypts
//   each client secret with the `Encryption` port, and yields a `ConnectionSet`
//   of ready `OAuthProviderConfig`s. Entries idle out and are invalidated on
//   every write below.
// - `OrganizationConnectionStore`, the write side: create / update / remove /
//   list / discover, validating what an organization supplies. The client secret
//   is sealed with AAD `organization-oauth-connection:<id>:clientSecret`, so a
//   ciphertext cannot be moved to another connection or field.
// - `oauthConnections`, the layer that installs a resolver into
//   `@awthaq/oauth` (`OAuthConnections`), which consults it after its static
//   registry. A connection's provider id is `org:<organizationId>:<connectionId>`,
//   so it can never shadow a static provider.
//
// Discovery (its deadline, its retries, its issuer-exact-match defect) stays
// `@awthaq/oauth`'s job: this module only maps stored rows to configs. Role and
// entitlement mapping derived from a connection stays out of this table, in qadi
// (ADR-EA-009).
//
// SSRF: an organization administrator supplies URLs this server will call. Only
// absolute `https:` URLs without credentials are accepted, and `localhost`,
// `.local`/`.internal` names and private/loopback/link-local IP literals are
// refused. That is a floor, not a defence against DNS rebinding — egress
// filtering at the network layer is the deployer's responsibility.

import { OAuthConnections, OAuthProvider } from "@awthaq/oauth";
import { Claims } from "@awthaq/oauth/presets";
import { Encryption } from "@awthaq/ports";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Data from "effect/Data";
import * as ConnectionRecords from "./ConnectionRecords.ts";
import * as OrganizationHooks from "./OrganizationHooks.ts";

// ---- provider ids -------------------------------------------------------------

/** The `providerId` a connection signs users in under (also the account's `providerId`). */
export const providerIdOf = (organizationId: string, connectionId: string): string =>
  `org:${organizationId}:${connectionId}`;

/** Inverse of `providerIdOf`; `None` for a static provider id. */
export const parseProviderId = (
  providerId: string,
): Option.Option<{ readonly organizationId: string; readonly connectionId: string }> => {
  const match = /^org:([^:]+):([^:]+)$/.exec(providerId);
  const organizationId = match?.[1];
  const connectionId = match?.[2];
  return organizationId === undefined || connectionId === undefined
    ? Option.none()
    : Option.some({ organizationId, connectionId });
};

const secretAad = (connectionId: string): string =>
  `organization-oauth-connection:${connectionId}:clientSecret`;

// ---- record -> provider config ----------------------------------------------------

/** OIDC standard claims -> `OAuthProfile`; a plain OAuth2 provider's userinfo usually carries `sub` or a numeric `id`. */
const standardProfile = (claims: Record<string, unknown>): OAuthProvider.OAuthProfile =>
  Claims.profileOf({
    subject: Claims.stringClaim(claims, "sub") ?? Claims.idClaim(claims, "id"),
    email: Claims.stringClaim(claims, "email"),
    emailVerified: Claims.booleanClaim(claims, "email_verified"),
    name: Claims.stringClaim(claims, "name"),
    image: Claims.stringClaim(claims, "picture"),
  });

/**
 * Changes whenever what a config is built from does. `updatedAt` alone is not
 * enough (two edits inside one millisecond share it); the sealed secret's
 * envelope is fresh on every write, so it is part of the fingerprint too (it is
 * ciphertext — this value is compared, never displayed).
 */
const revisionOf = (record: ConnectionRecords.ConnectionRecord): string =>
  [
    DateTime.formatIso(record.updatedAt),
    record.clientId,
    Option.getOrElse(record.clientSecret, () => ""),
    Option.getOrElse(record.issuer, () => ""),
    Option.getOrElse(record.discoveryUrl, () => ""),
    Option.getOrElse(record.authorizationEndpoint, () => ""),
    Option.getOrElse(record.tokenEndpoint, () => ""),
    Option.getOrElse(record.jwksUri, () => ""),
    Option.getOrElse(record.userinfoEndpoint, () => ""),
    record.scopes.join(" "),
  ].join("|");

const DEFAULT_OIDC_SCOPES = ["openid", "email", "profile"];

const toConfig = (
  record: ConnectionRecords.ConnectionRecord,
  clientSecret: Option.Option<Redacted.Redacted<string>>,
): OAuthProvider.OAuthProviderConfig => {
  const factory = record.kind === "oidc" ? OAuthProvider.oidc : OAuthProvider.oauth2;
  const authorizationEndpoint = Option.getOrUndefined(record.authorizationEndpoint);
  const tokenEndpoint = Option.getOrUndefined(record.tokenEndpoint);
  return factory({
    id: providerIdOf(record.organizationId, record.id),
    ...(Option.isSome(record.issuer) ? { issuer: record.issuer.value } : {}),
    ...(Option.isSome(record.discoveryUrl) ? { discoveryUrl: record.discoveryUrl.value } : {}),
    ...(authorizationEndpoint !== undefined && tokenEndpoint !== undefined
      ? {
          endpoints: {
            authorizationEndpoint,
            tokenEndpoint,
            ...(Option.isSome(record.jwksUri) ? { jwksUri: record.jwksUri.value } : {}),
            ...(Option.isSome(record.userinfoEndpoint)
              ? { userinfoEndpoint: record.userinfoEndpoint.value }
              : {}),
          },
        }
      : {}),
    clientId: record.clientId,
    ...(Option.isSome(clientSecret) ? { clientSecret: Config.succeed(clientSecret.value) } : {}),
    scopes: record.scopes.length > 0 ? record.scopes : record.kind === "oidc" ? DEFAULT_OIDC_SCOPES : [],
    mapProfile: standardProfile,
  });
};

// ---- the LayerMap ------------------------------------------------------------------

export interface ConnectionSetShape {
  /** This organization's connections, by *provider id* (`org:<organizationId>:<connectionId>`). */
  readonly connections: ReadonlyMap<string, OAuthConnections.OAuthConnection>;
}

export class ConnectionSet extends Context.Service<ConnectionSet, ConnectionSetShape>()(
  "awthaq/organization/ConnectionSet",
) {}

const buildSet = (organizationId: string) =>
  Effect.gen(function* () {
    const records = yield* ConnectionRecords.ConnectionRecords;
    const encryption = yield* Encryption.Encryption;
    const rows = yield* records.listByOrganization(organizationId);
    const connections = new Map<string, OAuthConnections.OAuthConnection>();
    for (const record of rows) {
      // A secret that no longer decrypts (a retired key, a tampered row) drops
      // that one connection with a warning; it never takes the others down.
      const secret = Option.isNone(record.clientSecret)
        ? Option.some(Option.none<Redacted.Redacted<string>>())
        : yield* encryption.decrypt(record.clientSecret.value, secretAad(record.id)).pipe(
            Effect.map((decrypted) => Option.some(Option.some(decrypted.plaintext))),
            Effect.catchTags({
              DecryptionFailed: () => Effect.succeedNone,
              UnknownKeyId: () => Effect.succeedNone,
            }),
          );
      if (Option.isNone(secret)) {
        yield* Effect.logWarning(
          `awthaq/organization: connection "${record.id}" of organization "${organizationId}" has an undecryptable client secret and was not loaded`,
        );
        continue;
      }
      const providerId = providerIdOf(organizationId, record.id);
      connections.set(providerId, {
        config: toConfig(record, secret.value),
        revision: revisionOf(record),
      });
    }
    return ConnectionSet.of({ connections });
  });

/**
 * BEH-EA-235: a `LayerMap.Service` keyed by organization id. Requires
 * `ConnectionRecords` and `Encryption`; provide `OrganizationConnections.layer`.
 */
export class OrganizationConnections extends LayerMap.Service<OrganizationConnections>()(
  "awthaq/organization/OrganizationConnections",
  {
    lookup: (organizationId: string) => Layer.effect(ConnectionSet, buildSet(organizationId)),
    // A connection edited elsewhere (another instance) is picked up within this window;
    // this instance's own writes invalidate immediately.
    idleTimeToLive: "5 minutes",
  },
) {}

/** Installs the resolver `@awthaq/oauth` consults after its static registry (BEH-EA-235). */
export const oauthConnections = Layer.effect(
  OAuthConnections.OAuthConnectionResolver,
  Effect.gen(function* () {
    const map = yield* OrganizationConnections;
    const resolver: OAuthConnections.OAuthConnectionResolverShape = {
      find: (providerId) =>
        Option.match(parseProviderId(providerId), {
          onNone: () => Effect.succeedNone,
          onSome: ({ organizationId }) =>
            Effect.scoped(map.contextEffect(organizationId)).pipe(
              Effect.map((context) =>
                Option.fromNullishOr(Context.get(context, ConnectionSet).connections.get(providerId)),
              ),
              Effect.orDie,
            ),
        }),
    };
    return Option.some(resolver);
  }),
);

// ---- the store ---------------------------------------------------------------------

/** The connection a caller sees: never the secret, only whether one is stored. */
export interface ConnectionView {
  readonly id: string;
  readonly organizationId: string;
  /** The `providerId` to hand `@awthaq/oauth`'s `/oauth/:provider/authorize`. */
  readonly providerId: string;
  readonly kind: ConnectionRecords.ConnectionKind;
  readonly name: string;
  readonly issuer: Option.Option<string>;
  readonly discoveryUrl: Option.Option<string>;
  readonly authorizationEndpoint: Option.Option<string>;
  readonly tokenEndpoint: Option.Option<string>;
  readonly jwksUri: Option.Option<string>;
  readonly userinfoEndpoint: Option.Option<string>;
  readonly clientId: string;
  readonly hasClientSecret: boolean;
  readonly scopes: ReadonlyArray<string>;
  readonly emailDomains: ReadonlyArray<string>;
  readonly createdAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
}

export class InvalidConnection extends Data.TaggedError("InvalidConnection")<{
  readonly reason: string;
}> {}

export interface ConnectionCreateInput {
  readonly organizationId: string;
  readonly kind: ConnectionRecords.ConnectionKind;
  readonly name: string;
  readonly issuer?: string | undefined;
  readonly discoveryUrl?: string | undefined;
  readonly authorizationEndpoint?: string | undefined;
  readonly tokenEndpoint?: string | undefined;
  readonly jwksUri?: string | undefined;
  readonly userinfoEndpoint?: string | undefined;
  readonly clientId: string;
  readonly clientSecret?: Redacted.Redacted<string> | undefined;
  readonly scopes?: ReadonlyArray<string> | undefined;
  readonly emailDomains?: ReadonlyArray<string> | undefined;
}

export interface ConnectionUpdateInput {
  readonly name?: string | undefined;
  readonly issuer?: string | null | undefined;
  readonly discoveryUrl?: string | null | undefined;
  readonly authorizationEndpoint?: string | null | undefined;
  readonly tokenEndpoint?: string | null | undefined;
  readonly jwksUri?: string | null | undefined;
  readonly userinfoEndpoint?: string | null | undefined;
  readonly clientId?: string | undefined;
  readonly clientSecret?: Redacted.Redacted<string> | null | undefined;
  readonly scopes?: ReadonlyArray<string> | undefined;
  readonly emailDomains?: ReadonlyArray<string> | undefined;
}

export interface OrganizationConnectionStoreShape {
  readonly create: (
    input: ConnectionCreateInput,
  ) => Effect.Effect<ConnectionView, InvalidConnection | ConnectionRecords.ConnectionDomainTaken>;
  readonly update: (
    organizationId: string,
    connectionId: string,
    patch: ConnectionUpdateInput,
  ) => Effect.Effect<
    ConnectionView,
    InvalidConnection | ConnectionRecords.ConnectionRecordNotFound | ConnectionRecords.ConnectionDomainTaken
  >;
  readonly remove: (
    organizationId: string,
    connectionId: string,
  ) => Effect.Effect<void, ConnectionRecords.ConnectionRecordNotFound>;
  readonly list: (organizationId: string) => Effect.Effect<ReadonlyArray<ConnectionView>>;
  /**
   * Home-realm discovery: the `providerId` an organization id, or an email's
   * domain, routes to (`None` when nothing does). The caller redirects to
   * `/oauth/<providerId>/authorize`. An organization with several connections
   * routes to its first-created one; an email domain routes to exactly one.
   */
  readonly discover: (hint: {
    readonly organizationId?: string | undefined;
    readonly email?: string | undefined;
  }) => Effect.Effect<Option.Option<string>>;
}

export class OrganizationConnectionStore extends Context.Service<
  OrganizationConnectionStore,
  OrganizationConnectionStoreShape
>()("awthaq/organization/OrganizationConnectionStore") {}

const PRIVATE_HOSTNAME = /(^|\.)(localhost|local|internal|localdomain)$/i;

const isPrivateIpv4 = (host: string): boolean => {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (match === null) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
};

/** `Some(reason)` when `value` is not an acceptable outbound endpoint. */
const endpointProblem = (field: string, value: string): Option.Option<string> => {
  if (!URL.canParse(value)) return Option.some(`${field} is not an absolute URL`);
  const url = new URL(value);
  if (url.protocol !== "https:") return Option.some(`${field} must be https`);
  if (url.username !== "" || url.password !== "") {
    return Option.some(`${field} must not carry credentials`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    PRIVATE_HOSTNAME.test(host) ||
    isPrivateIpv4(host) ||
    host === "::1" ||
    host === "::" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe80")
  ) {
    return Option.some(`${field} must not point at a private or loopback address`);
  }
  return Option.none();
};

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const normalizeDomains = (
  domains: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, InvalidConnection> => {
  const normalized = Array.from(new Set(domains.map((domain) => domain.trim().toLowerCase())));
  const bad = normalized.find((domain) => !DOMAIN.test(domain));
  return bad === undefined
    ? Effect.succeed(normalized)
    : Effect.fail(new InvalidConnection({ reason: `"${bad}" is not a valid email domain` }));
};

/** The rules a connection must satisfy, checked on the merged (post-patch) shape. */
const validate = (fields: {
  readonly kind: ConnectionRecords.ConnectionKind;
  readonly name: string;
  readonly issuer: Option.Option<string>;
  readonly discoveryUrl: Option.Option<string>;
  readonly authorizationEndpoint: Option.Option<string>;
  readonly tokenEndpoint: Option.Option<string>;
  readonly jwksUri: Option.Option<string>;
  readonly userinfoEndpoint: Option.Option<string>;
  readonly clientId: string;
  readonly scopes: ReadonlyArray<string>;
}): Effect.Effect<void, InvalidConnection> => {
  const problems: Array<string> = [];
  if (fields.name.trim() === "") problems.push("name is required");
  if (fields.clientId.trim() === "") problems.push("clientId is required");
  if (fields.kind === "oidc") {
    if (Option.isNone(fields.issuer)) problems.push("an oidc connection needs an issuer");
    if (fields.scopes.length > 0 && !fields.scopes.includes("openid")) {
      problems.push('an oidc connection\'s scopes must include "openid"');
    }
  }
  const hasEndpoints =
    Option.isSome(fields.authorizationEndpoint) && Option.isSome(fields.tokenEndpoint);
  if (Option.isNone(fields.discoveryUrl) && !hasEndpoints) {
    problems.push("supply a discoveryUrl, or both authorizationEndpoint and tokenEndpoint");
  }
  for (const [field, value] of [
    ["issuer", fields.issuer],
    ["discoveryUrl", fields.discoveryUrl],
    ["authorizationEndpoint", fields.authorizationEndpoint],
    ["tokenEndpoint", fields.tokenEndpoint],
    ["jwksUri", fields.jwksUri],
    ["userinfoEndpoint", fields.userinfoEndpoint],
  ] as const) {
    if (Option.isSome(value)) {
      const problem = endpointProblem(field, value.value);
      if (Option.isSome(problem)) problems.push(problem.value);
    }
  }
  return problems.length === 0
    ? Effect.void
    : Effect.fail(new InvalidConnection({ reason: problems.join("; ") }));
};

const toView = (record: ConnectionRecords.ConnectionRecord): ConnectionView => ({
  id: record.id,
  organizationId: record.organizationId,
  providerId: providerIdOf(record.organizationId, record.id),
  kind: record.kind,
  name: record.name,
  issuer: record.issuer,
  discoveryUrl: record.discoveryUrl,
  authorizationEndpoint: record.authorizationEndpoint,
  tokenEndpoint: record.tokenEndpoint,
  jwksUri: record.jwksUri,
  userinfoEndpoint: record.userinfoEndpoint,
  clientId: record.clientId,
  hasClientSecret: Option.isSome(record.clientSecret),
  scopes: record.scopes,
  emailDomains: record.emailDomains,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

/** Requires `ConnectionRecords`, `Encryption`, `OrganizationConnections` (invalidated on every write) and `Crypto`. */
export const layerStore = Layer.effect(
  OrganizationConnectionStore,
  Effect.gen(function* () {
    const records = yield* ConnectionRecords.ConnectionRecords;
    const encryption = yield* Encryption.Encryption;
    const map = yield* OrganizationConnections;
    const crypto = yield* Crypto.Crypto;

    const sealSecret = (connectionId: string, secret: Redacted.Redacted<string>) =>
      encryption.encrypt(secret, secretAad(connectionId));

    const create: OrganizationConnectionStoreShape["create"] = Effect.fnUntraced(function* (input) {
      const id = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
      const scopes = input.scopes ?? [];
      yield* validate({
        kind: input.kind,
        name: input.name,
        issuer: Option.fromNullishOr(input.issuer),
        discoveryUrl: Option.fromNullishOr(input.discoveryUrl),
        authorizationEndpoint: Option.fromNullishOr(input.authorizationEndpoint),
        tokenEndpoint: Option.fromNullishOr(input.tokenEndpoint),
        jwksUri: Option.fromNullishOr(input.jwksUri),
        userinfoEndpoint: Option.fromNullishOr(input.userinfoEndpoint),
        clientId: input.clientId,
        scopes,
      });
      const emailDomains = yield* normalizeDomains(input.emailDomains ?? []);
      const clientSecret =
        input.clientSecret === undefined ? undefined : yield* sealSecret(id, input.clientSecret);
      const record = yield* records.create({
        id,
        organizationId: input.organizationId,
        kind: input.kind,
        name: input.name.trim(),
        issuer: input.issuer,
        discoveryUrl: input.discoveryUrl,
        authorizationEndpoint: input.authorizationEndpoint,
        tokenEndpoint: input.tokenEndpoint,
        jwksUri: input.jwksUri,
        userinfoEndpoint: input.userinfoEndpoint,
        clientId: input.clientId,
        clientSecret,
        scopes,
        emailDomains,
      });
      yield* map.invalidate(input.organizationId);
      return toView(record);
    });

    const update: OrganizationConnectionStoreShape["update"] = Effect.fnUntraced(
      function* (organizationId, connectionId, patch) {
        const existing = yield* records.findById(organizationId, connectionId);
        if (Option.isNone(existing)) {
          return yield* new ConnectionRecords.ConnectionRecordNotFound({ id: connectionId });
        }
        const current = existing.value;
        const nullable = (
          held: Option.Option<string>,
          next: string | null | undefined,
        ): Option.Option<string> => (next === undefined ? held : Option.fromNullOr(next));
        yield* validate({
          kind: current.kind,
          name: patch.name ?? current.name,
          issuer: nullable(current.issuer, patch.issuer),
          discoveryUrl: nullable(current.discoveryUrl, patch.discoveryUrl),
          authorizationEndpoint: nullable(current.authorizationEndpoint, patch.authorizationEndpoint),
          tokenEndpoint: nullable(current.tokenEndpoint, patch.tokenEndpoint),
          jwksUri: nullable(current.jwksUri, patch.jwksUri),
          userinfoEndpoint: nullable(current.userinfoEndpoint, patch.userinfoEndpoint),
          clientId: patch.clientId ?? current.clientId,
          scopes: patch.scopes ?? current.scopes,
        });
        const emailDomains =
          patch.emailDomains === undefined ? undefined : yield* normalizeDomains(patch.emailDomains);
        const clientSecret =
          patch.clientSecret === undefined
            ? undefined
            : patch.clientSecret === null
              ? null
              : yield* sealSecret(connectionId, patch.clientSecret);
        const record = yield* records.update(organizationId, connectionId, {
          ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
          issuer: patch.issuer,
          discoveryUrl: patch.discoveryUrl,
          authorizationEndpoint: patch.authorizationEndpoint,
          tokenEndpoint: patch.tokenEndpoint,
          jwksUri: patch.jwksUri,
          userinfoEndpoint: patch.userinfoEndpoint,
          clientId: patch.clientId,
          clientSecret,
          scopes: patch.scopes,
          emailDomains,
        });
        yield* map.invalidate(organizationId);
        return toView(record);
      },
    );

    const remove: OrganizationConnectionStoreShape["remove"] = Effect.fnUntraced(
      function* (organizationId, connectionId) {
        yield* records.remove(organizationId, connectionId);
        yield* map.invalidate(organizationId);
      },
    );

    const list: OrganizationConnectionStoreShape["list"] = (organizationId) =>
      records.listByOrganization(organizationId).pipe(Effect.map((rows) => rows.map(toView)));

    const discover: OrganizationConnectionStoreShape["discover"] = ({ organizationId, email }) =>
      Effect.gen(function* () {
        if (organizationId !== undefined) {
          const rows = yield* records.listByOrganization(organizationId);
          const first = rows[0];
          if (first !== undefined) return Option.some(providerIdOf(organizationId, first.id));
        }
        const at = email?.lastIndexOf("@") ?? -1;
        if (email === undefined || at < 0) return Option.none<string>();
        const found = yield* records.findByEmailDomain(email.slice(at + 1).trim().toLowerCase());
        return Option.map(found, (row) => providerIdOf(row.organizationId, row.id));
      });

    return OrganizationConnectionStore.of({ create, update, remove, list, discover });
  }),
);

/**
 * Deleting an organization removes its connections and releases their email
 * domains. A separate opt-in layer, like `Organization.beforeUserDeleteErasure`
 * (hook-point taps are a module-level registry that freezes at first run, so a
 * tap cannot be merged into a layer rebuilt repeatedly): provide it once.
 */
export const cleanupOnOrganizationDelete = Layer.unwrap(
  Effect.gen(function* () {
    const records = yield* ConnectionRecords.ConnectionRecords;
    const map = yield* OrganizationConnections;
    return OrganizationHooks.AfterDeleteOrganization.tap(({ organizationId }) =>
      records.removeAllForOrganization(organizationId).pipe(Effect.andThen(map.invalidate(organizationId))),
    );
  }),
);
