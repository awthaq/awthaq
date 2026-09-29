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

/** The wire shape of `@awthaq/core`'s `UserRecord`, minus internal ids/timestamps a caller has no use for. */
export class AccountDto extends Schema.Class<AccountDto>("AccountDto")({
  id: Schema.String,
  email: Schema.String,
  emailVerified: Schema.Boolean,
  name: Schema.String,
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
    email: Schema.String,
    emailVerified: Schema.Boolean,
    name: Schema.String,
    metadata: Schema.NullOr(Schema.String),
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
