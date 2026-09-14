// @awthaq/api — Account
//
// Shipping-gap map (.scratch/shipping-gaps), tickets 09/10. Core's own
// `account` `HttpApiGroup` — reserved, root-level, needing no plugin to
// exist at all, the same "core-owned, mounted under `/auth`" shape
// `Session.ts`'s own `session` group already establishes. Top-level
// routes (`/user`, not `/account/user`) — an authenticated user's own
// profile update/delete applies regardless of which auth method they
// signed up with, so this group's own name is never part of the URL.

import * as Schema from "effect/Schema";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Authentication } from "./Api.ts";

/** The wire shape of `@awthaq/core`'s `UserRecord`, minus internal ids/timestamps a caller has no use for. */
export class AccountDto extends Schema.Class<AccountDto>("AccountDto")({
  id: Schema.String,
  email: Schema.String,
  emailVerified: Schema.Boolean,
  name: Schema.String,
}) {}

export const UpdateProfilePayload = Schema.Struct({ name: Schema.String });
export type UpdateProfilePayload = typeof UpdateProfilePayload.Type;

export const AccountGroup = HttpApiGroup.make("account")
  .add(
    HttpApiEndpoint.patch("updateProfile", "/user", {
      payload: UpdateProfilePayload,
      success: AccountDto,
    }),
  )
  .add(HttpApiEndpoint.delete("deleteUser", "/user"))
  .middleware(Authentication);
