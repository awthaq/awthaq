// @awthaq/scim — ScimApi
//
// spec/behaviors/30-scim.md, BEH-EA-246 through 253; RFC 7643 (schemas) and
// RFC 7644 (protocol). This plugin's own contract: one group, `scim`, mounted at
// `/scim/v2`, every endpoint behind `ScimAuthentication` — a bearer token that
// names one SCIM *connection* (an organization's own directory sync), never a
// user session, which is why there is no CSRF middleware here: nothing ambient
// (no cookie) is ever trusted.
//
// Wire details a directory service relies on:
//   - responses are `application/scim+json`; a request body is accepted as
//     `application/scim+json` or plain `application/json` (Okta sends the latter),
//   - errors are RFC 7644 §3.12 bodies (`schemas`, `status` as a string,
//     `scimType`, `detail`) — the plugin's own `_tag` rides along and is ignored
//     by clients,
//   - request enums are lenient where IdPs are (`op` is matched
//     case-insensitively, a boolean may arrive as `"False"`), strict everywhere
//     that matters for safety (see `Scim.ts`).

import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import * as HttpApiSecurity from "effect/unstable/httpapi/HttpApiSecurity";

// ---- schema urns ---------------------------------------------------------------------

export const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
export const SERVICE_PROVIDER_CONFIG_SCHEMA =
  "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig";
export const RESOURCE_TYPE_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:ResourceType";
export const SCHEMA_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Schema";

export const SCIM_CONTENT_TYPE = "application/scim+json";

// ---- errors (RFC 7644 §3.12) ---------------------------------------------------------

const errorFields = {
  schemas: Schema.Array(Schema.String),
  status: Schema.String,
  scimType: Schema.optional(Schema.String),
  detail: Schema.String,
};

/** 401: no bearer token, an unknown one, or a revoked connection's. */
export class ScimUnauthorized extends Schema.TaggedError<ScimUnauthorized>()(
  "ScimUnauthorized",
  errorFields,
  { httpApiStatus: 401 },
) {}

/** 400: `invalidFilter`, `invalidValue`, `mutability`, `invalidSyntax`. */
export class ScimBadRequest extends Schema.TaggedError<ScimBadRequest>()(
  "ScimBadRequest",
  errorFields,
  { httpApiStatus: 400 },
) {}

/** 404: no such resource *for this connection* — another connection's user is exactly this. */
export class ScimNotFound extends Schema.TaggedError<ScimNotFound>()("ScimNotFound", errorFields, {
  httpApiStatus: 404,
}) {}

/** 409: `uniqueness`. */
export class ScimConflict extends Schema.TaggedError<ScimConflict>()("ScimConflict", errorFields, {
  httpApiStatus: 409,
}) {}

/** 403: an operation this connection may not perform (a vetoed create, a full organization). */
export class ScimForbidden extends Schema.TaggedError<ScimForbidden>()(
  "ScimForbidden",
  errorFields,
  { httpApiStatus: 403 },
) {}

/**
 * 503: a backing store this request needed is unavailable (ADR-EA-028 `StoreUnavailable`, mapped
 * at the handler so no internal detail reaches the wire). RFC 7644 has no `scimType` for it: the
 * directory retries.
 */
export class ScimUnavailable extends Schema.TaggedError<ScimUnavailable>()(
  "ScimUnavailable",
  errorFields,
  { httpApiStatus: 503 },
) {}

const errorBody = (status: number, detail: string, scimType?: string) => ({
  schemas: [ERROR_SCHEMA],
  status: String(status),
  ...(scimType === undefined ? {} : { scimType }),
  detail,
});

export const unauthorized = (detail = "Bearer token required") =>
  new ScimUnauthorized(errorBody(401, detail));
export const badRequest = (detail: string, scimType = "invalidValue") =>
  new ScimBadRequest(errorBody(400, detail, scimType));
export const notFound = (detail = "Resource not found") =>
  new ScimNotFound(errorBody(404, detail));
export const conflict = (detail: string) => new ScimConflict(errorBody(409, detail, "uniqueness"));
export const forbidden = (detail: string) => new ScimForbidden(errorBody(403, detail));
export const unavailable = () =>
  new ScimUnavailable(errorBody(503, "The service is temporarily unavailable; retry later"));

// ---- the authenticated connection --------------------------------------------------------

/** What `ScimAuthentication` provides: the connection the bearer token names. */
export interface ScimConnectionIdentity {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
}

export class CurrentScimConnection extends Context.Service<
  CurrentScimConnection,
  ScimConnectionIdentity
>()("awthaq/scim/CurrentScimConnection") {}

/** Bearer only — a directory service authenticates with the long-lived connection token, not a session. */
export class ScimAuthentication extends HttpApiMiddleware.Service<
  ScimAuthentication,
  { provides: CurrentScimConnection }
>()("ScimAuthentication", {
  security: { bearer: HttpApiSecurity.bearer },
  error: ScimUnauthorized,
}) {}

// ---- resources (RFC 7643) ----------------------------------------------------------------

export const ScimName = Schema.Struct({
  formatted: Schema.optional(Schema.String),
  givenName: Schema.optional(Schema.String),
  familyName: Schema.optional(Schema.String),
});

export const ScimEmail = Schema.Struct({
  value: Schema.String,
  primary: Schema.optional(Schema.Boolean),
  type: Schema.optional(Schema.String),
});

export const ScimMeta = Schema.Struct({
  resourceType: Schema.String,
  created: Schema.String,
  lastModified: Schema.String,
  location: Schema.String,
});

export const UserResource = Schema.Struct({
  schemas: Schema.Array(Schema.String),
  id: Schema.String,
  externalId: Schema.optional(Schema.String),
  userName: Schema.String,
  name: Schema.optional(ScimName),
  displayName: Schema.optional(Schema.String),
  emails: Schema.optional(Schema.Array(ScimEmail)),
  active: Schema.Boolean,
  meta: ScimMeta,
});
export type UserResource = typeof UserResource.Type;

/** What `POST`/`PUT /Users` accepts. Unknown members (enterprise extension, `phoneNumbers`, ...) are ignored. */
export const UserInput = Schema.Struct({
  schemas: Schema.optional(Schema.Array(Schema.String)),
  externalId: Schema.optional(Schema.String),
  userName: Schema.String,
  name: Schema.optional(ScimName),
  displayName: Schema.optional(Schema.String),
  emails: Schema.optional(Schema.Array(ScimEmail)),
  active: Schema.optional(Schema.Boolean),
});
export type UserInput = typeof UserInput.Type;

export const GroupMember = Schema.Struct({
  value: Schema.String,
  display: Schema.optional(Schema.String),
});

export const GroupResource = Schema.Struct({
  schemas: Schema.Array(Schema.String),
  id: Schema.String,
  externalId: Schema.optional(Schema.String),
  displayName: Schema.String,
  members: Schema.Array(GroupMember),
  meta: ScimMeta,
});
export type GroupResource = typeof GroupResource.Type;

export const GroupInput = Schema.Struct({
  schemas: Schema.optional(Schema.Array(Schema.String)),
  externalId: Schema.optional(Schema.String),
  displayName: Schema.String,
  members: Schema.optional(Schema.Array(Schema.Struct({ value: Schema.String }))),
});
export type GroupInput = typeof GroupInput.Type;

/** RFC 7644 §3.5.2. `op` and `value` are decoded loosely on purpose; `Scim.ts` interprets them. */
export const PatchRequest = Schema.Struct({
  schemas: Schema.optional(Schema.Array(Schema.String)),
  Operations: Schema.Array(
    Schema.Struct({
      op: Schema.String,
      path: Schema.optional(Schema.String),
      value: Schema.optional(Schema.Unknown),
    }),
  ),
});
export type PatchRequest = typeof PatchRequest.Type;

const listOf = <S extends Schema.Top>(resource: S) =>
  Schema.Struct({
    schemas: Schema.Array(Schema.String),
    totalResults: Schema.Number,
    startIndex: Schema.Number,
    itemsPerPage: Schema.Number,
    Resources: Schema.Array(resource),
  });

export const UserListResponse = listOf(UserResource);
export type UserListResponse = typeof UserListResponse.Type;
export const GroupListResponse = listOf(GroupResource);
export type GroupListResponse = typeof GroupListResponse.Type;

// ---- discovery documents -------------------------------------------------------------------

export const ServiceProviderConfig = Schema.Struct({
  schemas: Schema.Array(Schema.String),
  patch: Schema.Struct({ supported: Schema.Boolean }),
  bulk: Schema.Struct({
    supported: Schema.Boolean,
    maxOperations: Schema.Number,
    maxPayloadSize: Schema.Number,
  }),
  filter: Schema.Struct({ supported: Schema.Boolean, maxResults: Schema.Number }),
  changePassword: Schema.Struct({ supported: Schema.Boolean }),
  sort: Schema.Struct({ supported: Schema.Boolean }),
  etag: Schema.Struct({ supported: Schema.Boolean }),
  authenticationSchemes: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      name: Schema.String,
      description: Schema.String,
      primary: Schema.Boolean,
    }),
  ),
});

export const ResourceTypeDescription = Schema.Struct({
  schemas: Schema.Array(Schema.String),
  id: Schema.String,
  name: Schema.String,
  endpoint: Schema.String,
  schema: Schema.String,
});

export const SchemaDescription = Schema.Struct({
  schemas: Schema.Array(Schema.String),
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
});

// ---- query and params ------------------------------------------------------------------------

const PathIdSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) =>
      value.length > 0 && value.length <= 255
        ? undefined
        : "a non-empty id of at most 255 characters",
    ),
  ),
);

export const IdParams = Schema.Struct({ id: PathIdSchema });
export type IdParams = typeof IdParams.Type;

/** RFC 7644 §3.4.2: `startIndex` is 1-based; `count` may be 0. Both arrive as query strings. */
export const ListQuery = Schema.Struct({
  filter: Schema.optional(Schema.String),
  startIndex: Schema.optional(Schema.NumberFromString),
  count: Schema.optional(Schema.NumberFromString),
});
export type ListQuery = typeof ListQuery.Type;

// ---- group -------------------------------------------------------------------------------------

/** A body the directory may send as either content type. */
const requestBody = <S extends Schema.Top>(schema: S) =>
  [
    schema.pipe(HttpApiSchema.asJson()),
    schema.pipe(HttpApiSchema.asJson({ contentType: SCIM_CONTENT_TYPE })),
  ] as const;

/** A response, always `application/scim+json`. */
const scimResponse = <S extends Schema.Top>(schema: S) =>
  schema.pipe(HttpApiSchema.asJson({ contentType: SCIM_CONTENT_TYPE }));

const created = <S extends Schema.Top>(schema: S) =>
  scimResponse(schema).pipe(HttpApiSchema.status(201));

export const ScimGroup = HttpApiGroup.make("scim")
  // ---- discovery
  .add(
    HttpApiEndpoint.get("serviceProviderConfig", "/scim/v2/ServiceProviderConfig", {
      success: scimResponse(ServiceProviderConfig),
    }),
  )
  .add(
    HttpApiEndpoint.get("resourceTypes", "/scim/v2/ResourceTypes", {
      success: scimResponse(Schema.Array(ResourceTypeDescription)),
    }),
  )
  .add(
    HttpApiEndpoint.get("schemas", "/scim/v2/Schemas", {
      success: scimResponse(Schema.Array(SchemaDescription)),
    }),
  )
  // ---- Users
  .add(
    HttpApiEndpoint.get("listUsers", "/scim/v2/Users", {
      query: ListQuery,
      success: scimResponse(UserListResponse),
      error: [ScimBadRequest, ScimUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.post("createUser", "/scim/v2/Users", {
      payload: requestBody(UserInput),
      success: created(UserResource),
      error: [ScimBadRequest, ScimConflict, ScimForbidden, ScimUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.get("getUser", "/scim/v2/Users/:id", {
      params: IdParams,
      success: scimResponse(UserResource),
      error: [ScimNotFound, ScimUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.put("replaceUser", "/scim/v2/Users/:id", {
      params: IdParams,
      payload: requestBody(UserInput),
      success: scimResponse(UserResource),
      error: [ScimBadRequest, ScimNotFound, ScimConflict, ScimUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.patch("patchUser", "/scim/v2/Users/:id", {
      params: IdParams,
      payload: requestBody(PatchRequest),
      success: scimResponse(UserResource),
      error: [ScimBadRequest, ScimNotFound, ScimConflict, ScimUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteUser", "/scim/v2/Users/:id", {
      params: IdParams,
      success: HttpApiSchema.Empty(204),
      error: [ScimNotFound, ScimForbidden, ScimUnavailable],
    }),
  )
  // ---- Groups (organization teams)
  .add(
    HttpApiEndpoint.get("listGroups", "/scim/v2/Groups", {
      query: ListQuery,
      success: scimResponse(GroupListResponse),
      error: [ScimBadRequest, ScimUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.post("createGroup", "/scim/v2/Groups", {
      payload: requestBody(GroupInput),
      success: created(GroupResource),
      error: [ScimBadRequest, ScimConflict, ScimForbidden, ScimUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.get("getGroup", "/scim/v2/Groups/:id", {
      params: IdParams,
      success: scimResponse(GroupResource),
      error: [ScimNotFound, ScimUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.put("replaceGroup", "/scim/v2/Groups/:id", {
      params: IdParams,
      payload: requestBody(GroupInput),
      success: scimResponse(GroupResource),
      error: [ScimBadRequest, ScimNotFound, ScimConflict, ScimForbidden, ScimUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.patch("patchGroup", "/scim/v2/Groups/:id", {
      params: IdParams,
      payload: requestBody(PatchRequest),
      success: scimResponse(GroupResource),
      error: [ScimBadRequest, ScimNotFound, ScimConflict, ScimForbidden, ScimUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteGroup", "/scim/v2/Groups/:id", {
      params: IdParams,
      success: HttpApiSchema.Empty(204),
      error: [ScimNotFound, ScimConflict, ScimUnavailable],
    }),
  )
  .middleware(ScimAuthentication);

export const ScimApi = HttpApi.make("auth").add(ScimGroup);
