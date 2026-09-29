// @awthaq/admin — AdminAccountsApi
//
// BAM-005/BAM-009 (BEH-EA-221, BEH-EA-225): the destructive and credential half of user
// administration — delete a user, set a user's email (verified by its owner), set a user's
// password. One group, `admin.accounts`: a dotted sub-id of the admin plugin family, so it is
// admin-tier by construction (AR-003) and rides `Api.AdminAuthentication` like `admin` and
// `admin.tenants`. Each endpoint is behind its own fail-closed predicate (`canDeleteUsers`,
// `canManageCredentials`); a caller who fails it learns nothing about which user ids exist.
//
// A separate plugin (`AdminAccounts`), not more endpoints on `Admin`: it needs the erasure
// cascade, the password hasher and the mailer, and `Admin` must keep composing without them
// (`AdminTenants` next to `Admin` is the same shape).

import { Api, EmailContract } from "@awthaq/api";
import { HookPoint } from "@awthaq/core";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import { AdminActionDenied, AdminTargetNotFound, UserIdParams } from "./AdminApi.ts";

/** BAM-005: an administrator may not delete their own account, or overwrite their own password through the admin surface (the user's own endpoints, with their current password, exist for that). */
export class AdminSelfActionRefused extends Schema.TaggedError<AdminSelfActionRefused>()(
  "AdminSelfActionRefused",
  {},
  { httpApiStatus: 400 },
) {}

/** BAM-009: the user has no email identity to replace, or (for `setUserPassword`) no address to sign in with. */
export class AdminNoEmailIdentity extends Schema.TaggedError<AdminNoEmailIdentity>()(
  "AdminNoEmailIdentity",
  {},
  { httpApiStatus: 409 },
) {}

/** BAM-009: the requested address already belongs to another account (an administrator may be told; a user's own request may not). */
export class AdminEmailAlreadyExists extends Schema.TaggedError<AdminEmailAlreadyExists>()(
  "AdminEmailAlreadyExists",
  {},
  { httpApiStatus: 409 },
) {}

/** BAM-009: the confirmation mail could not be delivered; nothing was changed and asking again mints a new token. `502`, like `InvitationDeliveryFailed`. */
export class AdminEmailDeliveryFailed extends Schema.TaggedError<AdminEmailDeliveryFailed>()(
  "AdminEmailDeliveryFailed",
  {},
  { httpApiStatus: 502 },
) {}

/** BAM-005: the password violates `AdminConfig.passwordPolicy`; `hints` say how. */
export class AdminWeakPassword extends Schema.TaggedError<AdminWeakPassword>()(
  "AdminWeakPassword",
  { hints: Schema.Array(Schema.String) },
  { httpApiStatus: 422 },
) {}

/** `POST /admin/users/:userId/email`: the address the confirmation mail goes to; nothing changes until its owner confirms. */
export const SetUserEmailPayload = Schema.Struct({ email: EmailContract.Email });
export type SetUserEmailPayload = typeof SetUserEmailPayload.Type;

/** Same ceiling `@awthaq/password` puts on a submitted password (ESS-006): the hasher's cost is linear in it. */
const MAX_PASSWORD_LENGTH = 1024;

/** `POST /admin/users/:userId/password`. */
export const SetUserPasswordPayload = Schema.Struct({
  password: Schema.Redacted(Schema.String.check(Schema.isMaxLength(MAX_PASSWORD_LENGTH))),
});
export type SetUserPasswordPayload = typeof SetUserPasswordPayload.Type;

export const AdminAccountsGroup = HttpApiGroup.make("admin.accounts")
  .add(
    // 204. `HookAborted`: a `BeforeUserDelete` tap (an Invite-purge veto, say) refused.
    HttpApiEndpoint.delete("deleteUser", "/admin/users/:userId", {
      params: UserIdParams,
      error: [
        AdminActionDenied,
        AdminTargetNotFound,
        AdminSelfActionRefused,
        HookPoint.HookAborted,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("setUserEmail", "/admin/users/:userId/email", {
      params: UserIdParams,
      payload: SetUserEmailPayload,
      success: HttpApiSchema.Empty(202),
      error: [
        AdminActionDenied,
        AdminTargetNotFound,
        AdminNoEmailIdentity,
        AdminEmailAlreadyExists,
        AdminEmailDeliveryFailed,
      ],
    }),
  )
  .add(
    // 204. Revokes every session of the user; the response says nothing about the old credential.
    HttpApiEndpoint.post("setUserPassword", "/admin/users/:userId/password", {
      params: UserIdParams,
      payload: SetUserPasswordPayload,
      error: [
        AdminActionDenied,
        AdminTargetNotFound,
        AdminSelfActionRefused,
        AdminNoEmailIdentity,
        AdminWeakPassword,
      ],
    }),
  )
  // Same tier and CSRF posture as `AdminGroup`: `CsrfProtection` declared last so it runs first.
  .middleware(Api.AdminAuthentication)
  .middleware(Api.CsrfProtection);

export const AdminAccountsApi = HttpApi.make("auth").add(AdminAccountsGroup);
