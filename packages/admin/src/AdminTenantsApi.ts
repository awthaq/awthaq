// @awthaq/admin — AdminTenantsApi
//
// EP-003 (wayfinder ticket 19 §3, ADR-EA-018, BEH-EA-237): the platform
// administrator's tenant-administration contract. One group, `admin.tenants` — a
// dotted sub-id of the admin plugin family, so it is admin-tier by construction
// (AR-003: any segment named `admin`) and rides `Api.AdminAuthentication` like
// the user-administration group does. Every endpoint is gated by
// `AdminConfig.canAdministerTenants` (fail-closed by default); a caller who fails
// the gate learns nothing about which organization ids exist.
//
// A separate plugin (`AdminTenants`), not more endpoints on `Admin`: it needs the
// organization records, and `Admin` must keep composing without the organization
// plugin (`RolesAdmin` next to `Roles` is the same shape).

import { Api } from "@awthaq/api";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { AdminActionDenied, LimitSchema, ReasonSchema } from "./AdminApi.ts";

/** An organization id that names no organization — only ever reported to a caller who passed the gate. */
export class AdminOrganizationNotFound extends Schema.TaggedError<AdminOrganizationNotFound>()(
  "AdminOrganizationNotFound",
  {},
  { httpApiStatus: 404 },
) {}

const PathIdSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) =>
      value.length > 0 && value.length <= 255
        ? undefined
        : "a non-empty id of at most 255 characters",
    ),
  ),
);

export const OrganizationIdParams = Schema.Struct({ organizationId: PathIdSchema });
export type OrganizationIdParams = typeof OrganizationIdParams.Type;

/** `POST /admin/organizations/:organizationId/suspend`: the operator's note, never shown to the organization's members. */
export const SuspendOrganizationPayload = Schema.Struct({ reason: Schema.optional(ReasonSchema) });
export type SuspendOrganizationPayload = typeof SuspendOrganizationPayload.Type;

/** The keyset position `(createdAt, id)`, opaque on the wire like the other admin cursors. */
export const OrganizationCursorSchema = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(
    Schema.fromJsonString(
      Schema.Struct({ createdAt: Schema.DateTimeUtcFromString, id: Schema.String }),
    ),
  ),
);

export const ListOrganizationsQuery = Schema.Struct({
  cursor: Schema.optional(OrganizationCursorSchema),
  limit: Schema.optional(LimitSchema),
});
export type ListOrganizationsQuery = typeof ListOrganizationsQuery.Type;

/** The wire shape of an organization as the platform sees it — presentation data (`logo`, `metadata`) is the tenant's own and is not included. */
export class TenantOrganizationDto extends Schema.Class<TenantOrganizationDto>(
  "TenantOrganizationDto",
)({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  homeRegion: Schema.NullOr(Schema.String),
  suspended: Schema.Boolean,
  /** ISO instant the suspension began; null while active. */
  suspendedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
}) {}

export class TenantOrganizationPageDto extends Schema.Class<TenantOrganizationPageDto>(
  "TenantOrganizationPageDto",
)({
  items: Schema.Array(TenantOrganizationDto),
  nextCursor: Schema.NullOr(OrganizationCursorSchema),
}) {}

export const AdminTenantsGroup = HttpApiGroup.make("admin.tenants")
  .add(
    HttpApiEndpoint.get("listOrganizations", "/admin/organizations", {
      query: ListOrganizationsQuery,
      success: TenantOrganizationPageDto,
      error: AdminActionDenied,
    }),
  )
  .add(
    HttpApiEndpoint.get("getOrganization", "/admin/organizations/:organizationId", {
      params: OrganizationIdParams,
      success: TenantOrganizationDto,
      error: [AdminActionDenied, AdminOrganizationNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.post("suspendOrganization", "/admin/organizations/:organizationId/suspend", {
      params: OrganizationIdParams,
      payload: SuspendOrganizationPayload,
      success: TenantOrganizationDto,
      error: [AdminActionDenied, AdminOrganizationNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.post(
      "unsuspendOrganization",
      "/admin/organizations/:organizationId/unsuspend",
      {
        params: OrganizationIdParams,
        success: TenantOrganizationDto,
        error: [AdminActionDenied, AdminOrganizationNotFound],
      },
    ),
  )
  // Same tier and CSRF posture as `AdminGroup`: `CsrfProtection` declared last so it runs first.
  .middleware(Api.AdminAuthentication)
  .middleware(Api.CsrfProtection);

export const AdminTenantsApi = HttpApi.make("auth").add(AdminTenantsGroup);
