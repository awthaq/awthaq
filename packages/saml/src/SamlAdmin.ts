// @awthaq/saml — SamlAdmin
//
// BEH-EA-318: the administrator's operations over SAML connections (and BEH-EA-316's role mapping), behind the `saml.admin` group (admin tier). Fail-closed:
// `SamlConfig.canManageSaml` DENIES BY DEFAULT and is asked first (a denial publishes `auth.admin.actionDenied`
// `saml.<action>` and reveals nothing about which ids exist), then each administrator is rate limited, then the operation runs
// scoped to the ambient tenant: inside a tenant a connection of another organization is answered exactly like one that does not
// exist (and registering one for another organization like an organization that does not exist); outside any tenant (the
// platform's operator) every organization is in reach, which is the point of an onboarding tool.
//
// Every SUCCESSFUL mutation publishes an audit event of identifiers (`auth.saml.connectionCreated`, `connectionUpdated` with the
// NAMES of the fields changed, `connectionDeleted`, `signingKeyRotated`). A connection can be described by pasted metadata XML,
// by hand, or by a metadata URL, which is fetched through the SSRF-safe pinned path (`SamlMetadataFetcher`) and re-fetched by
// `refreshMetadata`; the certificates it lists REPLACE the trust set (the IdP's metadata is the source of truth for its keys).

import { Api } from "@awthaq/api";
import { AuthEvents, RateLimits, Tenant, Users } from "@awthaq/core";
import { RateLimiter } from "@awthaq/ports";
import { makeSubject } from "@qadi/core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SamlApi from "./SamlApi.ts";
import * as SamlConfig from "./SamlConfig.ts";
import * as SamlConnections from "./SamlConnections.ts";
import * as SamlMetadataFetcher from "./SamlMetadataFetcher.ts";
import * as SamlRecords from "./SamlRecords.ts";
import * as SamlSpKeys from "./SamlSpKeys.ts";

type Gate = SamlApi.SamlActionDenied | Api.RateLimited;

export interface SamlAdminShape {
  readonly createConnection: (
    caller: Api.UserPrincipal,
    input: SamlApi.CreateConnectionPayload,
  ) => Effect.Effect<
    SamlApi.ConnectionDto,
    | Gate
    | SamlApi.InvalidSamlConnectionRequest
    | SamlApi.SamlDomainAlreadyRouted
    | SamlApi.SamlMetadataUnavailable
  >;
  readonly listConnections: (
    caller: Api.UserPrincipal,
    organizationId: string,
  ) => Effect.Effect<ReadonlyArray<SamlApi.ConnectionDto>, Gate>;
  readonly getConnection: (
    caller: Api.UserPrincipal,
    connectionId: string,
  ) => Effect.Effect<SamlApi.ConnectionDto, Gate | SamlApi.SamlConnectionNotFound>;
  readonly updateConnection: (
    caller: Api.UserPrincipal,
    connectionId: string,
    input: SamlApi.UpdateConnectionPayload,
  ) => Effect.Effect<
    SamlApi.ConnectionDto,
    | Gate
    | SamlApi.SamlConnectionNotFound
    | SamlApi.InvalidSamlConnectionRequest
    | SamlApi.SamlDomainAlreadyRouted
  >;
  readonly deleteConnection: (
    caller: Api.UserPrincipal,
    connectionId: string,
  ) => Effect.Effect<void, Gate | SamlApi.SamlConnectionNotFound>;
  /** Re-fetches the metadata from the URL the connection was imported from, and replaces the trust set with what it lists. */
  readonly refreshMetadata: (
    caller: Api.UserPrincipal,
    connectionId: string,
  ) => Effect.Effect<
    SamlApi.ConnectionDto,
    | Gate
    | SamlApi.SamlConnectionNotFound
    | SamlApi.SamlNoMetadataUrl
    | SamlApi.SamlMetadataUnavailable
    | SamlApi.InvalidSamlConnectionRequest
  >;
  /** Generates a new SP signing key (or imports the one supplied); it signs from now on and the previous one stays published until it expires. */
  readonly rotateSigningKey: (
    caller: Api.UserPrincipal,
    connectionId: string,
    input: SamlApi.SigningKeyPayload,
  ) => Effect.Effect<
    SamlApi.SigningKeyDto,
    Gate | SamlApi.SamlConnectionNotFound | SamlApi.InvalidSamlConnectionRequest
  >;
  readonly listSigningKeys: (
    caller: Api.UserPrincipal,
    connectionId: string,
  ) => Effect.Effect<ReadonlyArray<SamlApi.SigningKeyDto>, Gate | SamlApi.SamlConnectionNotFound>;
}

const iso = (instant: DateTime.Utc): string => DateTime.formatIso(instant);

const roleMappingOf = (payload: SamlApi.RoleMappingPayload): SamlRecords.RoleMapping => ({
  rules: payload.rules.map((rule) => ({
    attribute: rule.attribute,
    ...(rule.value === undefined ? {} : { value: rule.value }),
    roles: [...rule.roles],
  })),
  ceiling: payload.ceiling === undefined ? ["member"] : [...payload.ceiling],
  defaultRoles: payload.defaultRoles === undefined ? [] : [...payload.defaultRoles],
});

const UPDATE_FIELDS: ReadonlyArray<keyof SamlApi.UpdateConnectionPayload> = [
  "name",
  "entityId",
  "ssoUrl",
  "certificates",
  "emailDomains",
  "trustsEmail",
  "authnRequestsSigned",
  "sloUrl",
  "sloBinding",
  "metadataUrl",
  "roleMapping",
];

/** Requires the store, the SP keys, the metadata fetcher, `AuthEvents`, `RateLimiter` and `SamlConfig`. */
export const makeAdmin = Effect.gen(function* () {
  const store = yield* SamlConnections.SamlConnectionStore;
  const spKeys = yield* SamlSpKeys.SamlSpKeys;
  const fetcher = yield* SamlMetadataFetcher.SamlMetadataFetcher;
  const events = yield* AuthEvents.AuthEvents;
  const limiter = yield* RateLimiter.RateLimiter;
  const settings = yield* SamlConfig.SamlConfig;

  const authorize = Effect.fnUntraced(function* (
    caller: Api.UserPrincipal,
    action: string,
    organizationId: string | undefined,
  ) {
    const allowed = yield* settings.canManageSaml({
      admin: makeSubject({ id: caller.ref.id }),
      action,
      organizationId,
    });
    if (!allowed) {
      yield* events.publish({
        _tag: "auth.admin.actionDenied",
        adminUserId: Users.UserId(caller.ref.id),
        action: `saml.${action}`,
      });
      return yield* Effect.fail(new SamlApi.SamlActionDenied());
    }
    yield* RateLimits.enforce({
      key: `saml:admin:${caller.ref.id}`,
      limit: settings.adminRate.limit,
      window: settings.adminRate.window,
      meta: { group: "saml.admin", endpoint: action, rule: "admin", dimension: "principal" },
    }).pipe(
      Effect.provideService(RateLimiter.RateLimiter, limiter),
      Effect.provideService(AuthEvents.AuthEvents, events),
      Effect.catchTag(
        "RateLimitExceeded",
        (error) => new Api.RateLimited({ retryAfterMillis: error.retryAfterMillis }),
      ),
    );
  });

  const adminId = (caller: Api.UserPrincipal) => Users.UserId(caller.ref.id);

  /** Inside a tenant, only that tenant's organization is in reach; outside any tenant, every organization is. */
  const inScope = (organizationId: string) =>
    Effect.map(
      Tenant.TenantContext,
      (tenant) => Option.isNone(tenant) || tenant.value === organizationId,
    );

  const toDto = Effect.fnUntraced(function* (record: SamlRecords.ConnectionRecord) {
    const keys = yield* spKeys.list(record.id);
    return new SamlApi.ConnectionDto({
      id: record.id,
      organizationId: record.organizationId,
      name: record.name,
      idpEntityId: record.idpEntityId,
      ssoUrl: record.ssoUrl,
      sloUrl: Option.getOrNull(record.sloUrl),
      sloBinding: record.sloBinding,
      metadataUrl: Option.getOrNull(record.metadataUrl),
      certificates: record.idpCertificates.map(
        (certificate) =>
          new SamlApi.CertificateDto({
            fingerprint: certificate.fingerprint,
            notBefore: iso(certificate.notBefore),
            notAfter: iso(certificate.notAfter),
          }),
      ),
      emailDomains: [...record.emailDomains],
      trustsEmail: record.trustsEmail,
      authnRequestsSigned: record.authnRequestsSigned,
      roleRules: record.roleMapping.rules.map(
        (rule) =>
          new SamlApi.RoleRuleDto({
            attribute: rule.attribute,
            value: rule.value ?? null,
            roles: [...rule.roles],
          }),
      ),
      roleCeiling: [...record.roleMapping.ceiling],
      defaultRoles: [...record.roleMapping.defaultRoles],
      spEntityId: settings.spEntityId(record.id),
      spMetadataUrl: `${settings.baseUrl}/auth/saml/metadata?connection=${encodeURIComponent(record.id)}`,
      spCertificates: keys.map(
        (key) =>
          new SamlApi.CertificateDto({
            fingerprint: key.fingerprint,
            notBefore: iso(key.notBefore),
            notAfter: iso(key.notAfter),
          }),
      ),
      createdAt: iso(record.createdAt),
      updatedAt: iso(record.updatedAt),
    });
  });

  const invalid = (reason: string) => new SamlApi.InvalidSamlConnectionRequest({ reason });

  /** Store errors, as the API's. */
  const fromInvalid = (error: SamlConnections.InvalidSamlConnection) =>
    Effect.fail(invalid(error.reason));
  const fromTaken = (error: SamlRecords.SamlDomainTaken) =>
    Effect.fail(new SamlApi.SamlDomainAlreadyRouted({ domain: error.domain }));
  const fromMissing = () => Effect.fail(new SamlApi.SamlConnectionNotFound());

  /** A connection that exists AND is in the ambient tenant's reach: anything else is `SamlConnectionNotFound`. */
  const existing = Effect.fnUntraced(function* (connectionId: string) {
    const found = yield* store
      .get(connectionId)
      .pipe(
        Effect.catchTag("SamlConnections/NotFound", () =>
          Effect.fail(new SamlApi.SamlConnectionNotFound()),
        ),
      );
    if (!(yield* inScope(found.organizationId))) {
      return yield* Effect.fail(new SamlApi.SamlConnectionNotFound());
    }
    return found;
  });

  const fetchMetadata = (url: string) =>
    fetcher
      .fetch(url)
      .pipe(
        Effect.mapError((error) => new SamlApi.SamlMetadataUnavailable({ failure: error.failure })),
      );

  const createConnection: SamlAdminShape["createConnection"] = Effect.fnUntraced(
    function* (caller, input) {
      yield* authorize(caller, "createConnection", input.organizationId);
      // Registering for an organization outside the tenant is answered as an organization that does not exist.
      if (!(yield* inScope(input.organizationId))) {
        return yield* Effect.fail(invalid("the organization does not exist"));
      }
      const source = input.idp;
      const idp =
        "metadataUrl" in source
          ? { metadataXml: yield* fetchMetadata(source.metadataUrl) }
          : "metadataXml" in source
            ? { metadataXml: source.metadataXml }
            : {
                entityId: source.entityId,
                ssoUrl: source.ssoUrl,
                certificates: source.certificates,
                sloUrl: source.sloUrl,
                sloBinding: source.sloBinding,
              };
      const created = yield* store
        .create({
          organizationId: input.organizationId,
          name: input.name,
          idp,
          emailDomains: input.emailDomains,
          trustsEmail: input.trustsEmail,
          authnRequestsSigned: input.authnRequestsSigned,
          metadataUrl: "metadataUrl" in source ? source.metadataUrl : undefined,
          roleMapping:
            input.roleMapping === undefined ? undefined : roleMappingOf(input.roleMapping),
        })
        .pipe(Effect.catchTags({ InvalidSamlConnection: fromInvalid, SamlDomainTaken: fromTaken }));
      yield* Effect.logInfo("awthaq/saml: connection created", { connectionId: created.id });
      yield* events.publish({
        _tag: "auth.saml.connectionCreated",
        adminUserId: adminId(caller),
        connectionId: created.id,
        organizationId: created.organizationId,
      });
      return yield* toDto(created);
    },
  );

  const listConnections: SamlAdminShape["listConnections"] = Effect.fnUntraced(
    function* (caller, organizationId) {
      yield* authorize(caller, "listConnections", organizationId);
      if (!(yield* inScope(organizationId))) return [];
      const rows = yield* store.list(organizationId);
      return yield* Effect.forEach(rows, toDto);
    },
  );

  const getConnection: SamlAdminShape["getConnection"] = Effect.fnUntraced(
    function* (caller, connectionId) {
      yield* authorize(caller, "getConnection", undefined);
      return yield* toDto(yield* existing(connectionId));
    },
  );

  const updateConnection: SamlAdminShape["updateConnection"] = Effect.fnUntraced(
    function* (caller, connectionId, input) {
      yield* authorize(caller, "updateConnection", undefined);
      yield* existing(connectionId);
      const updated = yield* store
        .update(connectionId, {
          name: input.name,
          entityId: input.entityId,
          ssoUrl: input.ssoUrl,
          certificates: input.certificates,
          emailDomains: input.emailDomains,
          trustsEmail: input.trustsEmail,
          authnRequestsSigned: input.authnRequestsSigned,
          sloUrl: input.sloUrl,
          sloBinding: input.sloBinding,
          metadataUrl: input.metadataUrl,
          roleMapping:
            input.roleMapping === undefined ? undefined : roleMappingOf(input.roleMapping),
        })
        .pipe(
          Effect.catchTags({
            InvalidSamlConnection: fromInvalid,
            SamlDomainTaken: fromTaken,
            "SamlConnections/NotFound": fromMissing,
          }),
        );
      yield* events.publish({
        _tag: "auth.saml.connectionUpdated",
        adminUserId: adminId(caller),
        connectionId,
        organizationId: updated.organizationId,
        // Names only: what an administrator typed never enters the audit trail.
        fields: UPDATE_FIELDS.filter((field) => input[field] !== undefined),
      });
      return yield* toDto(updated);
    },
  );

  const deleteConnection: SamlAdminShape["deleteConnection"] = Effect.fnUntraced(
    function* (caller, connectionId) {
      yield* authorize(caller, "deleteConnection", undefined);
      const found = yield* existing(connectionId);
      yield* store
        .remove(connectionId)
        .pipe(Effect.catchTag("SamlConnections/NotFound", fromMissing));
      yield* Effect.logInfo("awthaq/saml: connection deleted", { connectionId });
      yield* events.publish({
        _tag: "auth.saml.connectionDeleted",
        adminUserId: adminId(caller),
        connectionId,
        organizationId: found.organizationId,
      });
    },
  );

  const refreshMetadata: SamlAdminShape["refreshMetadata"] = Effect.fnUntraced(
    function* (caller, connectionId) {
      yield* authorize(caller, "refreshMetadata", undefined);
      const found = yield* existing(connectionId);
      if (Option.isNone(found.metadataUrl))
        return yield* Effect.fail(new SamlApi.SamlNoMetadataUrl());
      const xml = yield* fetchMetadata(found.metadataUrl.value);
      const refreshed = yield* store.refreshMetadata(connectionId, xml).pipe(
        Effect.catchTags({
          InvalidSamlConnection: fromInvalid,
          "SamlConnections/NotFound": fromMissing,
        }),
      );
      yield* events.publish({
        _tag: "auth.saml.connectionUpdated",
        adminUserId: adminId(caller),
        connectionId,
        organizationId: refreshed.organizationId,
        fields: ["certificates", "ssoUrl", "sloUrl"],
      });
      return yield* toDto(refreshed);
    },
  );

  const keyDto = (key: SamlSpKeys.SpKeySummary) =>
    new SamlApi.SigningKeyDto({
      id: key.id,
      fingerprint: key.fingerprint,
      certificate: key.certificate,
      notBefore: iso(key.notBefore),
      notAfter: iso(key.notAfter),
      createdAt: iso(key.createdAt),
    });

  const rotateSigningKey: SamlAdminShape["rotateSigningKey"] = Effect.fnUntraced(
    function* (caller, connectionId, input) {
      yield* authorize(caller, "rotateSigningKey", undefined);
      const found = yield* existing(connectionId);
      if ((input.privateKeyPem === undefined) !== (input.certificatePem === undefined)) {
        return yield* Effect.fail(
          invalid("supply both a private key and its certificate, or neither to generate one"),
        );
      }
      const created = yield* (
        input.privateKeyPem === undefined || input.certificatePem === undefined
          ? spKeys.generate(connectionId)
          : spKeys.importKey(connectionId, {
              privateKeyPem: Redacted.make(input.privateKeyPem),
              certificatePem: input.certificatePem,
            })
      ).pipe(Effect.catchTag("InvalidSigningKey", (error) => Effect.fail(invalid(error.reason))));
      yield* events.publish({
        _tag: "auth.saml.signingKeyRotated",
        adminUserId: adminId(caller),
        connectionId,
        organizationId: found.organizationId,
      });
      return keyDto(created);
    },
  );

  const listSigningKeys: SamlAdminShape["listSigningKeys"] = Effect.fnUntraced(
    function* (caller, connectionId) {
      yield* authorize(caller, "listSigningKeys", undefined);
      yield* existing(connectionId);
      return (yield* spKeys.list(connectionId)).map(keyDto);
    },
  );

  return {
    createConnection,
    listConnections,
    getConnection,
    updateConnection,
    deleteConnection,
    refreshMetadata,
    rotateSigningKey,
    listSigningKeys,
  } satisfies SamlAdminShape;
});
