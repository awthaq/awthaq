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
import { Authentication, CsrfProtection } from "./Api.ts";

/**
 * FAMS-002: the wire shape of `@awthaq/core`'s `UserIdentity` — a tagged union,
 * so a client cannot read a verified flag for an identity kind that has none.
 * Shared with the admin surface's `UserDto`.
 */
export const IdentityDto = Schema.Union([
  Schema.TaggedStruct("Email", { email: Schema.String, emailVerified: Schema.Boolean }),
  Schema.TaggedStruct("Phone", { phone: Schema.String, phoneVerified: Schema.Boolean }),
  Schema.TaggedStruct("Anonymous", {}),
]);
export type IdentityDto = typeof IdentityDto.Type;

/** The wire shape of `@awthaq/core`'s `UserRecord`, minus internal ids/timestamps a caller has no use for. */
export class AccountDto extends Schema.Class<AccountDto>("AccountDto")({
  id: Schema.String,
  identity: IdentityDto,
  name: Schema.String,
  image: Schema.NullOr(Schema.String),
}) {}

/**
 * BAM-009/NAM-009: `image` is client-writable like `name`, so it is bounded and
 * limited to `http(s)` URLs — a stored `javascript:`/`data:` value would be an
 * XSS vector for any frontend that renders it as a link.
 */
export const ImageUrl = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.isPattern(/^https?:\/\//i),
);

export const UpdateProfilePayload = Schema.Struct({
  name: Schema.String,
  image: Schema.optional(Schema.NullOr(ImageUrl)),
});
export type UpdateProfilePayload = typeof UpdateProfilePayload.Type;

export const AccountGroup = HttpApiGroup.make("account")
  .add(
    HttpApiEndpoint.patch("updateProfile", "/user", {
      payload: UpdateProfilePayload,
      success: AccountDto,
    }),
  )
  .add(HttpApiEndpoint.delete("deleteUser", "/user"))
  // See Session.ts's identical comment: `CsrfProtection` declared last so
  // it runs first.
  .middleware(Authentication)
  .middleware(CsrfProtection);
