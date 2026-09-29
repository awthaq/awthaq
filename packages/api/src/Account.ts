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
import { Authentication, CsrfProtection, RateLimited } from "./Api.ts";

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

/**
 * SAM-004/BEH-EA-040/048: the scalar a plugin-declared user field carries on the wire — the
 * encoded side of every declared field is a string, a number or a boolean (`null` clears one).
 */
export const UserFieldValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean]);
export type UserFieldValue = typeof UserFieldValue.Type;

/**
 * SAM-004/BEH-EA-040: the wire shape of `@awthaq/core`'s `UserRecord`, minus internal ids/timestamps a
 * caller has no use for. `fields` is the bag of plugin-declared user fields the user holds a value for,
 * keyed `<plugin id>_<field>`; a composition that declares none answers `{}`. The keys and value types a
 * composition offers are `Auth.UserFieldsOf<typeof auth>`.
 */
export class AccountDto extends Schema.Class<AccountDto>("AccountDto")({
  id: Schema.String,
  identity: IdentityDto,
  name: Schema.String,
  image: Schema.NullOr(Schema.String),
  fields: Schema.Record(Schema.String, UserFieldValue),
}) {}

/**
 * CSG-005: the wire shape of `@awthaq/core`'s `AccountExportDocument` — a GDPR Art. 15/20
 * data-subject export. Never a secret (no password hash, provider token, session secret or
 * key); `sections` holds one entry per plugin that stores personal data, keyed by plugin id.
 */
export class AccountExportDto extends Schema.Class<AccountExportDto>("AccountExportDto")({
  generatedAt: Schema.String,
  user: Schema.Struct({
    id: Schema.String,
    identity: IdentityDto,
    name: Schema.String,
    image: Schema.NullOr(Schema.String),
    metadata: Schema.NullOr(Schema.String),
    status: Schema.Literals(["active", "suspended"]),
    createdAt: Schema.String,
    updatedAt: Schema.String,
  }),
  accounts: Schema.Array(
    Schema.Struct({
      providerId: Schema.String,
      subject: Schema.String,
      issuer: Schema.NullOr(Schema.String),
      createdAt: Schema.String,
    }),
  ),
  sessions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      createdAt: Schema.String,
      lastActiveAt: Schema.String,
      expiresAt: Schema.String,
      userAgent: Schema.NullOr(Schema.String),
      amr: Schema.Array(Schema.String),
    }),
  ),
  activity: Schema.Array(
    Schema.Struct({
      event: Schema.String,
      occurredAt: Schema.String,
      ip: Schema.NullOr(Schema.String),
      userAgent: Schema.NullOr(Schema.String),
    }),
  ),
  sections: Schema.Record(Schema.String, Schema.Json),
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

/** SAM-004/BEH-EA-048: naming a field no plugin declared. */
export class UnknownUserField extends Schema.TaggedError<UnknownUserField>()(
  "UnknownUserField",
  { field: Schema.String },
  { httpApiStatus: 422 },
) {}

/**
 * SAM-004/BEH-EA-048: the field is declared `clientWritable: false` by its plugin (a plan tier, an
 * elevation flag): only trusted server code may write it, never a request payload.
 */
export class UserFieldNotWritable extends Schema.TaggedError<UserFieldNotWritable>()(
  "UserFieldNotWritable",
  { field: Schema.String },
  { httpApiStatus: 403 },
) {}

/** SAM-004: the value does not satisfy the field's own schema. */
export class InvalidUserField extends Schema.TaggedError<InvalidUserField>()(
  "InvalidUserField",
  { field: Schema.String },
  { httpApiStatus: 422 },
) {}

export const UpdateProfilePayload = Schema.Struct({
  name: Schema.String,
  image: Schema.optional(Schema.NullOr(ImageUrl)),
  /**
   * SAM-004/BEH-EA-048: values for plugin-declared user fields (`null` clears one). Only fields
   * their plugin left `clientWritable` (the default) are accepted; a server-only field is
   * `UserFieldNotWritable`, an undeclared one `UnknownUserField`.
   */
  fields: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(UserFieldValue))),
});
export type UpdateProfilePayload = typeof UpdateProfilePayload.Type;

export const AccountGroup = HttpApiGroup.make("account")
  .add(
    HttpApiEndpoint.patch("updateProfile", "/user", {
      payload: UpdateProfilePayload,
      success: AccountDto,
      error: [UnknownUserField, UserFieldNotWritable, InvalidUserField],
    }),
  )
  .add(HttpApiEndpoint.delete("deleteUser", "/user"))
  // CSG-005: GDPR Art. 15/20 self-service export — one JSON document, rate limited, audited.
  .add(
    HttpApiEndpoint.get("exportData", "/user/export", {
      success: AccountExportDto,
      error: RateLimited,
    }),
  )
  // See Session.ts's identical comment: `CsrfProtection` declared last so
  // it runs first.
  .middleware(Authentication)
  .middleware(CsrfProtection);
