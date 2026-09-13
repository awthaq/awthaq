// @awthaq/admin — AdminApi
//
// spec/behaviors/27-admin-impersonation.md, BEH-EA-209 through BEH-EA-220.
// This plugin's own contract — one group, `admin` (BEH-EA-004), all four
// endpoints behind `.middleware(Api.Authentication)`: every operation here
// (including `list`) requires a real, already-authenticated caller, gated
// again by `AdminConfig.canImpersonate` inside the handler itself.

import { Api, SessionContract } from "@awthaq/api";
import * as Schema from "effect/Schema";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";

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

export const UserIdParams = Schema.Struct({ userId: Schema.String });
export type UserIdParams = typeof UserIdParams.Type;

export const SessionIdParams = Schema.Struct({ sessionId: Schema.String });
export type SessionIdParams = typeof SessionIdParams.Type;

/** `GET /admin`'s own query params. */
export const ListQuery = { active: Schema.optional(Schema.Literals(["true", "false"])) };
export type ListQuery = { readonly active?: "true" | "false" | undefined };

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
  endedAt: Schema.NullOr(Schema.String),
  endedBy: Schema.NullOr(Schema.Literals(["self", "forcedByAdmin", "expired"])),
}) {}

export const AdminGroup = HttpApiGroup.make("admin")
  .add(
    HttpApiEndpoint.post("impersonate", "/admin/impersonate/:userId", {
      params: UserIdParams,
      payload: ImpersonatePayload,
      success: SessionContract.SessionDto,
      error: [AdminImpersonationDenied, AdminSelfImpersonationRefused, AdminAlreadyImpersonating],
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
      success: Schema.Array(ImpersonationRecordDto),
      error: AdminImpersonationDenied,
    }),
  )
  .middleware(Api.Authentication);

export const AdminApi = HttpApi.make("auth").add(AdminGroup);
