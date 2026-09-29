// @awthaq/saml — SamlApi
//
// spec/behaviors/29-saml-sp.md, BEH-EA-238 through 245 and 314 through 318; spec/models/10-saml.md ("The contract"). Three groups:
//
//   - `saml` (BEH-EA-004): public. The SP metadata document, the login redirect, the Assertion Consumer Service and the Single
//     Logout endpoint (the IdP's browser delivers a `LogoutRequest` or the `LogoutResponse` to ours, over Redirect or POST).
//   - `saml.account`: authenticated. `POST /auth/saml/logout`, the signed-in user's own SP-initiated Single Logout.
//   - `saml.admin`: the administrator's CRUD over connections (admin tier by its id, AR-003; behind `Api.AdminAuthentication`
//     and CSRF; every operation gated by `SamlConfig.canManageSaml`, which denies by default), the metadata refresh and the SP
//     signing keys.
//
// Every validation failure at the ACS is ONE uniform `SamlAssertionRejected` with no fields (BEH-EA-238), and every one at the
// logout endpoint ONE `SamlLogoutRejected`: which check failed is logged and audited, never answered, so neither endpoint is
// an oracle for probing its chain.
//
// No `CsrfProtection` on the public group: the ACS and the logout endpoint receive cross-site POSTs from the IdP by
// construction, and the request is bound to the browser that started it by a cookie plus a single-consume request id (the
// ACS), or is a signed message that changes nothing but ending the sessions it names (the IdP's LogoutRequest).

import { Api } from "@awthaq/api";
import { HookPoint, Hooks, Users } from "@awthaq/core";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

/** No such connection — or its organization is suspended or gone (indistinguishable, BEH-EA-237). */
export class SamlConnectionNotFound extends Schema.TaggedError<SamlConnectionNotFound>()(
  "SamlConnectionNotFound",
  {},
  { httpApiStatus: 404 },
) {}

/** BEH-EA-238: the one answer to every reason a `SAMLResponse` can be refused. */
export class SamlAssertionRejected extends Schema.TaggedError<SamlAssertionRejected>()(
  "SamlAssertionRejected",
  {},
  { httpApiStatus: 400 },
) {}

/** BEH-EA-315: the one answer to every reason a Single Logout message can be refused. */
export class SamlLogoutRejected extends Schema.TaggedError<SamlLogoutRejected>()(
  "SamlLogoutRejected",
  {},
  { httpApiStatus: 400 },
) {}

const ConnectionIdSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) =>
      value.length > 0 && value.length <= 255
        ? undefined
        : "a connection id of 1 to 255 characters",
    ),
  ),
);

export const ConnectionQuery = Schema.Struct({ connection: ConnectionIdSchema });
export type ConnectionQuery = typeof ConnectionQuery.Type;

export const LoginQuery = Schema.Struct({
  ...ConnectionQuery.fields,
  /** Where the browser lands after sign-in: a relative path, or an origin in `SamlConfig.trustedOrigins`; anything else is the default. */
  callbackURL: Schema.optional(Schema.String),
});
export type LoginQuery = typeof LoginQuery.Type;

/** The form the IdP's browser posts. `RelayState` is accepted and ignored: the return path is held server-side. */
export const AcsPayload = Schema.Struct({
  SAMLResponse: Schema.String,
  RelayState: Schema.optional(Schema.String),
}).pipe(HttpApiSchema.asFormUrlEncoded());
export type AcsPayload = typeof AcsPayload.Type;

/**
 * BEH-EA-315: what the IdP's browser delivers to the logout endpoint. Over the Redirect binding these are query parameters
 * (the signature covers the raw query, which the handler reads from the request itself); over POST, a form. Exactly one of
 * `SAMLRequest` (the IdP asks this SP to end sessions) and `SAMLResponse` (the IdP answers our request) is expected.
 */
export const SloQuery = Schema.Struct({
  SAMLRequest: Schema.optional(Schema.String),
  SAMLResponse: Schema.optional(Schema.String),
  RelayState: Schema.optional(Schema.String),
  SigAlg: Schema.optional(Schema.String),
  Signature: Schema.optional(Schema.String),
});
export type SloQuery = typeof SloQuery.Type;

export const SloPayload = Schema.Struct({
  SAMLRequest: Schema.optional(Schema.String),
  SAMLResponse: Schema.optional(Schema.String),
  RelayState: Schema.optional(Schema.String),
}).pipe(HttpApiSchema.asFormUrlEncoded());
export type SloPayload = typeof SloPayload.Type;

export const SloParams = Schema.Struct({ connection: ConnectionIdSchema });
export type SloParams = typeof SloParams.Type;

export const SamlGroup = HttpApiGroup.make("saml")
  .add(
    HttpApiEndpoint.get("metadata", "/auth/saml/metadata", {
      query: ConnectionQuery,
      success: Schema.String.pipe(
        HttpApiSchema.asText({ contentType: "application/samlmetadata+xml" }),
      ),
      error: SamlConnectionNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("login", "/auth/saml/login", {
      query: LoginQuery,
      success: HttpApiSchema.Empty(302),
      error: [SamlConnectionNotFound, Api.RateLimited, Api.StoreUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.post("acs", "/auth/saml/acs", {
      payload: AcsPayload,
      success: HttpApiSchema.Empty(302),
      error: [
        SamlAssertionRejected,
        // SCP-001: `Users.assertCanSignIn` refused a suspended user.
        Users.UserSuspended,
        Api.RateLimited,
        Api.StoreUnavailable,
        HookPoint.HookAborted,
        Hooks.TwoFactorRequired,
      ],
    }),
  )
  .add(
    // BEH-EA-315: the answer is a redirect (a LogoutResponse over the Redirect binding, or back to the app after our own
    // logout) or, for an IdP that takes the POST binding, a self-submitting HTML form (200): the handler chooses.
    HttpApiEndpoint.get("slo", "/auth/saml/slo/:connection", {
      params: SloParams,
      query: SloQuery,
      success: HttpApiSchema.Empty(302),
      error: [SamlLogoutRejected, Api.RateLimited, Api.StoreUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.post("sloPost", "/auth/saml/slo/:connection", {
      params: SloParams,
      payload: SloPayload,
      success: HttpApiSchema.Empty(302),
      error: [SamlLogoutRejected, Api.RateLimited, Api.StoreUnavailable],
    }),
  )
  // BEH-EA-201: the IdP posts here cross-site by construction (no double-submit cookie can exist); the messages carry their own
  // signature and single-use id, so `awthaq doctor` skips its CSRF check for this group.
  .annotate(Api.BackChannel, true);

export const LogoutPayload = Schema.Struct({
  /** Where the browser lands after the logout: a relative path, or an origin in `SamlConfig.trustedOrigins`; anything else is the default. */
  callbackURL: Schema.optional(Schema.String),
});
export type LogoutPayload = typeof LogoutPayload.Type;

/** BEH-EA-315: the signed-in user's own SP-initiated Single Logout (authenticated, CSRF-protected). */
export const SamlAccountGroup = HttpApiGroup.make("saml.account")
  .add(
    HttpApiEndpoint.post("logout", "/auth/saml/logout", {
      payload: LogoutPayload,
      success: HttpApiSchema.Empty(302),
      error: [Api.RateLimited, Api.StoreUnavailable],
    }),
  )
  .middleware(Api.Authentication)
  .middleware(Api.CsrfProtection);

// ---- the administrator's surface (BEH-EA-318, BEH-EA-316) -------------------------------------------

/** The caller failed `canManageSaml` (or is rate limited before it is asked). */
export class SamlActionDenied extends Schema.TaggedError<SamlActionDenied>()(
  "SamlActionDenied",
  {},
  { httpApiStatus: 403 },
) {}

/** What the administrator supplied is not acceptable; `reason` names the rule (a constant sentence, never an excerpt). */
export class InvalidSamlConnectionRequest extends Schema.TaggedError<InvalidSamlConnectionRequest>()(
  "InvalidSamlConnectionRequest",
  { reason: Schema.String },
  { httpApiStatus: 422 },
) {}

/** An email domain is already routed to another connection. */
export class SamlDomainAlreadyRouted extends Schema.TaggedError<SamlDomainAlreadyRouted>()(
  "SamlDomainAlreadyRouted",
  { domain: Schema.String },
  { httpApiStatus: 409 },
) {}

/** The IdP metadata could not be fetched from its URL; `failure` is a class (`blocked`, `timeout`, `connect`, `tooLarge`, `status`, `invalidUrl`), never text from the far end. */
export class SamlMetadataUnavailable extends Schema.TaggedError<SamlMetadataUnavailable>()(
  "SamlMetadataUnavailable",
  { failure: Schema.String },
  { httpApiStatus: 502 },
) {}

/** A refresh needs the URL the metadata was imported from, and this connection was made by hand or from pasted XML. */
export class SamlNoMetadataUrl extends Schema.TaggedError<SamlNoMetadataUrl>()(
  "SamlNoMetadataUrl",
  {},
  { httpApiStatus: 409 },
) {}

const NameSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) =>
      value.trim().length > 0 && value.length <= 255
        ? undefined
        : "a non-blank name of at most 255 characters",
    ),
  ),
);
const UrlSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) =>
      value.length > 0 && value.length <= 2048 ? undefined : "a URL of at most 2048 characters",
    ),
  ),
);
const PemSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) =>
      value.length > 0 && value.length <= 32768 ? undefined : "a PEM of at most 32 KiB",
    ),
  ),
);
const MetadataXmlSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) =>
      value.length > 0 && value.length <= 1_048_576 ? undefined : "metadata of at most 1 MiB",
    ),
  ),
);
const DomainsSchema = Schema.Array(Schema.String).pipe(
  Schema.check(
    Schema.makeFilter((value: ReadonlyArray<string>) =>
      value.length <= 50 ? undefined : "at most 50 email domains",
    ),
  ),
);
const IdParams = Schema.Struct({ connectionId: ConnectionIdSchema });
export const ConnectionIdParams = IdParams;
export type ConnectionIdParams = typeof IdParams.Type;

export const RoleRulePayload = Schema.Struct({
  /** The assertion attribute (case-insensitive), e.g. `groups`. */
  attribute: NameSchema,
  /** Matches when the attribute holds exactly this value; absent, when it is present at all. */
  value: Schema.optional(NameSchema),
  /** The organization roles the rule gives. */
  roles: Schema.Array(NameSchema),
});
export const RoleMappingPayload = Schema.Struct({
  rules: Schema.Array(RoleRulePayload),
  /** The roles this connection may confer at most (RRM-001's `canGrant` rule): a rule beyond it is refused. Default `["member"]`. */
  ceiling: Schema.optional(Schema.Array(NameSchema)),
  /** Given when no rule matched; empty, a sign-in that matched nothing changes no membership. */
  defaultRoles: Schema.optional(Schema.Array(NameSchema)),
});
export type RoleMappingPayload = typeof RoleMappingPayload.Type;

/** How the IdP is described: by its metadata (pasted XML, or a URL this server fetches through the SSRF-safe pinned path) or by hand. */
const IdpPayload = Schema.Union([
  Schema.Struct({ metadataXml: MetadataXmlSchema }),
  Schema.Struct({ metadataUrl: UrlSchema }),
  Schema.Struct({
    entityId: NameSchema,
    ssoUrl: UrlSchema,
    certificates: Schema.Array(PemSchema),
    sloUrl: Schema.optional(UrlSchema),
    sloBinding: Schema.optional(Schema.Literals(["redirect", "post"])),
  }),
]);

export const CreateConnectionPayload = Schema.Struct({
  organizationId: ConnectionIdSchema,
  name: NameSchema,
  idp: IdpPayload,
  emailDomains: Schema.optional(DomainsSchema),
  trustsEmail: Schema.optional(Schema.Boolean),
  authnRequestsSigned: Schema.optional(Schema.Boolean),
  roleMapping: Schema.optional(RoleMappingPayload),
});
export type CreateConnectionPayload = typeof CreateConnectionPayload.Type;

export const UpdateConnectionPayload = Schema.Struct({
  name: Schema.optional(NameSchema),
  entityId: Schema.optional(NameSchema),
  ssoUrl: Schema.optional(UrlSchema),
  /** Replaces the trust set (that is how a rotation retires the old key). */
  certificates: Schema.optional(Schema.Array(PemSchema)),
  emailDomains: Schema.optional(DomainsSchema),
  trustsEmail: Schema.optional(Schema.Boolean),
  authnRequestsSigned: Schema.optional(Schema.Boolean),
  /** `null` removes the single-logout endpoint. */
  sloUrl: Schema.optional(Schema.NullOr(UrlSchema)),
  sloBinding: Schema.optional(Schema.Literals(["redirect", "post"])),
  /** `null` forgets the metadata URL. */
  metadataUrl: Schema.optional(Schema.NullOr(UrlSchema)),
  roleMapping: Schema.optional(RoleMappingPayload),
});
export type UpdateConnectionPayload = typeof UpdateConnectionPayload.Type;

export const ListConnectionsQuery = Schema.Struct({ organizationId: ConnectionIdSchema });
export type ListConnectionsQuery = typeof ListConnectionsQuery.Type;

/** A key pair the operator brings; absent, one is generated. Both or neither. */
export const SigningKeyPayload = Schema.Struct({
  privateKeyPem: Schema.optional(PemSchema),
  certificatePem: Schema.optional(PemSchema),
});
export type SigningKeyPayload = typeof SigningKeyPayload.Type;

export class CertificateDto extends Schema.Class<CertificateDto>("SamlCertificateDto")({
  fingerprint: Schema.String,
  notBefore: Schema.String,
  notAfter: Schema.String,
}) {}

/** A stored SP signing key as the API shows it: the PUBLIC certificate and its window, never the private half. */
export class SigningKeyDto extends Schema.Class<SigningKeyDto>("SamlSigningKeyDto")({
  id: Schema.String,
  fingerprint: Schema.String,
  certificate: Schema.String,
  notBefore: Schema.String,
  notAfter: Schema.String,
  createdAt: Schema.String,
}) {}

export class RoleRuleDto extends Schema.Class<RoleRuleDto>("SamlRoleRuleDto")({
  attribute: Schema.String,
  value: Schema.NullOr(Schema.String),
  roles: Schema.Array(Schema.String),
}) {}

export class ConnectionDto extends Schema.Class<ConnectionDto>("SamlConnectionDto")({
  id: Schema.String,
  organizationId: Schema.String,
  name: Schema.String,
  idpEntityId: Schema.String,
  ssoUrl: Schema.String,
  sloUrl: Schema.NullOr(Schema.String),
  sloBinding: Schema.Literals(["redirect", "post"]),
  metadataUrl: Schema.NullOr(Schema.String),
  /** The IdP's pinned signing certificates (the trust set), fingerprints and windows. */
  certificates: Schema.Array(CertificateDto),
  emailDomains: Schema.Array(Schema.String),
  trustsEmail: Schema.Boolean,
  authnRequestsSigned: Schema.Boolean,
  roleRules: Schema.Array(RoleRuleDto),
  roleCeiling: Schema.Array(Schema.String),
  defaultRoles: Schema.Array(Schema.String),
  /** What to give the IdP administrator: this SP's entity id, and the metadata document that carries the rest. */
  spEntityId: Schema.String,
  spMetadataUrl: Schema.String,
  /** The SP signing certificates published in that metadata (fingerprints). */
  spCertificates: Schema.Array(CertificateDto),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}) {}

const gate = [SamlActionDenied, Api.RateLimited] as const;

export const SamlAdminGroup = HttpApiGroup.make("saml.admin")
  .add(
    HttpApiEndpoint.post("createConnection", "/admin/saml/connections", {
      payload: CreateConnectionPayload,
      success: ConnectionDto,
      error: [
        ...gate,
        InvalidSamlConnectionRequest,
        SamlDomainAlreadyRouted,
        SamlMetadataUnavailable,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.get("listConnections", "/admin/saml/connections", {
      query: ListConnectionsQuery,
      success: Schema.Array(ConnectionDto),
      error: gate,
    }),
  )
  .add(
    HttpApiEndpoint.get("getConnection", "/admin/saml/connections/:connectionId", {
      params: IdParams,
      success: ConnectionDto,
      error: [...gate, SamlConnectionNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.patch("updateConnection", "/admin/saml/connections/:connectionId", {
      params: IdParams,
      payload: UpdateConnectionPayload,
      success: ConnectionDto,
      error: [
        ...gate,
        SamlConnectionNotFound,
        InvalidSamlConnectionRequest,
        SamlDomainAlreadyRouted,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteConnection", "/admin/saml/connections/:connectionId", {
      params: IdParams,
      success: HttpApiSchema.Empty(204),
      error: [...gate, SamlConnectionNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.post(
      "refreshMetadata",
      "/admin/saml/connections/:connectionId/refresh-metadata",
      {
        params: IdParams,
        success: ConnectionDto,
        error: [
          ...gate,
          SamlConnectionNotFound,
          SamlNoMetadataUrl,
          SamlMetadataUnavailable,
          InvalidSamlConnectionRequest,
        ],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post("rotateSigningKey", "/admin/saml/connections/:connectionId/signing-key", {
      params: IdParams,
      payload: SigningKeyPayload,
      success: SigningKeyDto,
      error: [...gate, SamlConnectionNotFound, InvalidSamlConnectionRequest],
    }),
  )
  .add(
    HttpApiEndpoint.get("listSigningKeys", "/admin/saml/connections/:connectionId/signing-keys", {
      params: IdParams,
      success: Schema.Array(SigningKeyDto),
      error: [...gate, SamlConnectionNotFound],
    }),
  )
  // Same tier and CSRF posture as the rest of the admin surface: `CsrfProtection` declared last so it runs first.
  .middleware(Api.AdminAuthentication)
  .middleware(Api.CsrfProtection);

export const SamlApi = HttpApi.make("auth")
  .add(SamlGroup)
  .add(SamlAccountGroup)
  .add(SamlAdminGroup);
