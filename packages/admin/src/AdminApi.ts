// @awthaq/admin — AdminApi
//
// spec/behaviors/27-admin-impersonation.md, BEH-EA-209 through BEH-EA-220.
// This plugin's own contract — one group, `admin` (BEH-EA-004), all four
// endpoints behind `.middleware(Api.Authentication)`: every operation here
// (including `list`) requires a real, already-authenticated caller, gated
// again by `AdminConfig.canImpersonate` inside the handler itself.

import { Api, SessionContract } from "@awthaq/api";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

/** BEH-EA-212: the config predicate rejected the caller. */
export class AdminImpersonationDenied extends Schema.TaggedError<AdminImpersonationDenied>()(
  "AdminImpersonationDenied",
  {},
  { httpApiStatus: 403 },
) {}

/** BEH-EA-214: a caller may never impersonate themselves. */
export class AdminSelfImpersonationRefused extends Schema.TaggedError<AdminSelfImpersonationRefused>()(
  "AdminSelfImpersonationRefused",
  {},
  { httpApiStatus: 400 },
) {}

/** BEH-EA-214: a session already carrying `actingAs` cannot start a further, nested impersonation. */
export class AdminAlreadyImpersonating extends Schema.TaggedError<AdminAlreadyImpersonating>()(
  "AdminAlreadyImpersonating",
  {},
  { httpApiStatus: 409 },
) {}

/** BEH-EA-216/217: an unknown, or already-ended, impersonation session/episode. */
export class AdminImpersonationNotFound extends Schema.TaggedError<AdminImpersonationNotFound>()(
  "AdminImpersonationNotFound",
  {},
  { httpApiStatus: 404 },
) {}

/** IDS-003/BEH-EA-218: a gate-passing caller named a user id that does not exist — an ordinary validation failure, never `impersonationDenied`. */
export class AdminTargetNotFound extends Schema.TaggedError<AdminTargetNotFound>()(
  "AdminTargetNotFound",
  {},
  { httpApiStatus: 404 },
) {}

/**
 * BAM-005: a non-impersonation admin capability (`AdminConfig.canManageUsers`) refused the
 * caller. Distinct from `AdminImpersonationDenied` so the two signals stay separable.
 */
export class AdminActionDenied extends Schema.TaggedError<AdminActionDenied>()(
  "AdminActionDenied",
  {},
  { httpApiStatus: 403 },
) {}

/** BAM-005: the named session is not one of the named user's own, revocable sessions (an unknown id, another user's, or an impersonation session, which `forceStop` owns). */
export class AdminSessionNotFound extends Schema.TaggedError<AdminSessionNotFound>()(
  "AdminSessionNotFound",
  {},
  { httpApiStatus: 404 },
) {}

/** BEH-EA-213: non-empty after trimming, capped at 1000 characters (`archive/PRD.md` §18's "reason required"). */
export const ReasonSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) =>
      value.trim().length > 0 && value.trim().length <= 1000
        ? undefined
        : "a non-empty (after trimming) reason of at most 1000 characters",
    ),
  ),
);

export const ImpersonatePayload = Schema.Struct({ reason: ReasonSchema });
export type ImpersonatePayload = typeof ImpersonatePayload.Type;

/** IDS-003/APS-009: non-empty and bounded; no UUID shape assumed since `UserId` is application-supplied. */
const PathIdSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) =>
      value.length > 0 && value.length <= 255
        ? undefined
        : "a non-empty id of at most 255 characters",
    ),
  ),
);

export const UserIdParams = Schema.Struct({ userId: PathIdSchema });
export type UserIdParams = typeof UserIdParams.Type;

export const SessionIdParams = Schema.Struct({ sessionId: PathIdSchema });
export type SessionIdParams = typeof SessionIdParams.Type;

/** BAM-005: `DELETE /admin/users/:userId/sessions/:sessionId`. */
export const UserSessionParams = Schema.Struct({ userId: PathIdSchema, sessionId: PathIdSchema });
export type UserSessionParams = typeof UserSessionParams.Type;

/** BAM-005: bounds mirror `Users`' own profile (`name` non-blank, `metadata` an opaque string). */
export const UpdateUserPayload = Schema.Struct({
  name: Schema.String.pipe(
    Schema.check(
      Schema.makeFilter((value: string) =>
        value.trim().length > 0 && value.length <= 200
          ? undefined
          : "a non-blank name of at most 200 characters",
      ),
    ),
  ),
  /** Left out leaves the user's metadata untouched; `null` clears it. */
  metadata: Schema.optional(
    Schema.NullOr(
      Schema.String.pipe(
        Schema.check(
          Schema.makeFilter((value: string) =>
            value.length <= 10_000 ? undefined : "metadata of at most 10000 characters",
          ),
        ),
      ),
    ),
  ),
});
export type UpdateUserPayload = typeof UpdateUserPayload.Type;

/**
 * ESS-006: the opaque page cursor — base64url of the JSON `(startedAt, id)` keyset
 * position. Decoding is a plain Schema transform, so a malformed or tampered cursor
 * is an ordinary 400 rather than a value the handler has to trust.
 */
export const CursorSchema = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(
    Schema.fromJsonString(
      Schema.Struct({ startedAt: Schema.DateTimeUtcFromString, id: Schema.String }),
    ),
  ),
);

/** ESS-006: page size bounds on the wire; the server default (50) applies when omitted. */
export const MAX_PAGE_SIZE = 200;
export const LimitSchema = Schema.NumberFromString.pipe(
  Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: MAX_PAGE_SIZE })),
);

/** BAM-005: `Users.list`'s keyset position `(createdAt, id)`, opaque on the wire like `CursorSchema`. */
export const UserCursorSchema = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(
    Schema.fromJsonString(
      Schema.Struct({ createdAt: Schema.DateTimeUtcFromString, id: Schema.String }),
    ),
  ),
);

/** BAM-005: `GET /admin/users`'s query params. */
export const ListUsersQuery = Schema.Struct({
  cursor: Schema.optional(UserCursorSchema),
  limit: Schema.optional(LimitSchema),
});
export type ListUsersQuery = typeof ListUsersQuery.Type;

/** `GET /admin`'s own query params. */
export const ListQuery = Schema.Struct({
  active: Schema.optional(Schema.Literals(["true", "false"])),
  cursor: Schema.optional(CursorSchema),
  limit: Schema.optional(LimitSchema),
});
export type ListQuery = typeof ListQuery.Type;

/** One row of `list` — the wire shape of `ImpersonationRecords.ImpersonationRecord`. */
export class ImpersonationRecordDto extends Schema.Class<ImpersonationRecordDto>(
  "ImpersonationRecordDto",
)({
  id: Schema.String,
  adminUserId: Schema.String,
  targetUserId: Schema.String,
  sessionId: Schema.String,
  reason: Schema.String,
  startedAt: Schema.String,
  /** IDS-004: the impersonation session's hard expiry; null only for rows written before it was recorded. */
  expiresAt: Schema.NullOr(Schema.String),
  endedAt: Schema.NullOr(Schema.String),
  endedBy: Schema.NullOr(Schema.Literals(["self", "forcedByAdmin", "expired"])),
}) {}

/** BAM-005: the wire shape of `@awthaq/core`'s `UserRecord`. */
export class UserDto extends Schema.Class<UserDto>("AdminUserDto")({
  id: Schema.String,
  email: Schema.String,
  emailVerified: Schema.Boolean,
  name: Schema.String,
  metadata: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}) {}

/**
 * EP-009/BEH-EA-229: one leaf of an effective configuration value. `value` is `<redacted>` for a
 * secret — declared sensitive, or held in a `Redacted` — and never the secret itself.
 */
export class ConfigEntryDto extends Schema.Class<ConfigEntryDto>("AdminConfigEntryDto")({
  path: Schema.String,
  value: Schema.String,
  sensitive: Schema.Boolean,
}) {}

/** EP-009: one configuration descriptor's effective value: who owns it, whether it is the default or an override. */
export class ConfigItemDto extends Schema.Class<ConfigItemDto>("AdminConfigItemDto")({
  owner: Schema.String,
  key: Schema.String,
  source: Schema.Literals(["default", "override"]),
  entries: Schema.Array(ConfigEntryDto),
}) {}

/** BAM-005: one page of `listUsers`; `nextCursor` is null on the last page. */
export class UserPageDto extends Schema.Class<UserPageDto>("AdminUserPageDto")({
  items: Schema.Array(UserDto),
  nextCursor: Schema.NullOr(UserCursorSchema),
}) {}

/** ESS-006: one page of `list`; `nextCursor` is null on the last page. */
export class ImpersonationPageDto extends Schema.Class<ImpersonationPageDto>(
  "ImpersonationPageDto",
)({
  items: Schema.Array(ImpersonationRecordDto),
  nextCursor: Schema.NullOr(CursorSchema),
}) {}

export const AdminGroup = HttpApiGroup.make("admin")
  .add(
    HttpApiEndpoint.post("impersonate", "/admin/impersonate/:userId", {
      params: UserIdParams,
      payload: ImpersonatePayload,
      success: SessionContract.SessionDto,
      error: [
        AdminImpersonationDenied,
        AdminSelfImpersonationRefused,
        AdminAlreadyImpersonating,
        AdminTargetNotFound,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("stopImpersonating", "/admin/stop-impersonating", {
      success: HttpApiSchema.Empty(204),
      error: AdminImpersonationNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("forceStop", "/admin/force-stop/:sessionId", {
      params: SessionIdParams,
      success: HttpApiSchema.Empty(204),
      error: [AdminImpersonationDenied, AdminImpersonationNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.get("list", "/admin", {
      query: ListQuery,
      success: ImpersonationPageDto,
    }),
  )
  // BAM-005 (wayfinder ticket 19 §1): user and session administration. Each endpoint is
  // gated by `AdminConfig.canManageUsers` (fail-closed), after which an unknown user is a
  // 404 — the gate first, so a caller who fails it learns nothing about which ids exist.
  .add(
    HttpApiEndpoint.get("listUsers", "/admin/users", {
      query: ListUsersQuery,
      success: UserPageDto,
      error: AdminActionDenied,
    }),
  )
  // EP-009/ECS-008 (BEH-EA-229): the running application's effective configuration, secrets
  // redacted, behind the same fail-closed `canManageUsers` gate (collection-level: no target).
  .add(
    HttpApiEndpoint.get("effectiveConfig", "/admin/config", {
      success: Schema.Array(ConfigItemDto),
      error: AdminActionDenied,
    }),
  )
  .add(
    HttpApiEndpoint.get("getUser", "/admin/users/:userId", {
      params: UserIdParams,
      success: UserDto,
      error: [AdminActionDenied, AdminTargetNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.patch("updateUser", "/admin/users/:userId", {
      params: UserIdParams,
      payload: UpdateUserPayload,
      success: UserDto,
      error: [AdminActionDenied, AdminTargetNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.get("listUserSessions", "/admin/users/:userId/sessions", {
      params: UserIdParams,
      success: Schema.Array(SessionContract.SessionDto),
      error: [AdminActionDenied, AdminTargetNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.delete("revokeUserSession", "/admin/users/:userId/sessions/:sessionId", {
      params: UserSessionParams,
      success: HttpApiSchema.Empty(204),
      error: [AdminActionDenied, AdminTargetNotFound, AdminSessionNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.delete("revokeUserSessions", "/admin/users/:userId/sessions", {
      params: UserIdParams,
      success: HttpApiSchema.Empty(204),
      error: [AdminActionDenied, AdminTargetNotFound],
    }),
  )
  // CSS-001/CDS-001/APS-001/NHS-001/PIL-001/TMS-001: `CsrfProtection`
  // declared last so it runs first (rejects a forgery before any
  // credential work) — see `@awthaq/api`'s `Session.ts` for the same
  // comment.
  // AR-003: the admin tier's own scheme (default: `Authentication`'s handlers) — see
  // `Api.AdminAuthentication` — so a host can firewall/re-authenticate this group alone.
  .middleware(Api.AdminAuthentication)
  .middleware(Api.CsrfProtection);

export const AdminApi = HttpApi.make("auth").add(AdminGroup);
