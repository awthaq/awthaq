// @awthaq/oauth — ProviderResponses
//
// ESS-003 (+JJS-005/OAP-004/OIT-005): every JSON body a provider's token or
// userinfo endpoint returns is untrusted, network-fetched input — decoded
// through these schemas at the boundary (`HttpIncomingMessage.schemaBodyJson`),
// shared by `OAuth.ts`'s code exchange and `OAuthTokenAccess.ts`'s refresh so
// the two can't drift, never asserted with `as`. A body that doesn't decode
// is a *typed* failure at each call site, not a defect.

import * as Schema from "effect/Schema";

/**
 * RFC 6749 §5.1's successful token response. `access_token` is the one
 * required member; `expires_in` tolerates the providers that send it as a
 * numeric string ("3600") instead of the spec's number.
 */
export const TokenResponseSchema = Schema.Struct({
  access_token: Schema.String,
  id_token: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Union([Schema.Number, Schema.NumberFromString])),
  scope: Schema.optional(Schema.String),
  token_type: Schema.optional(Schema.String),
});
export type TokenResponse = typeof TokenResponseSchema.Type;

/** A userinfo response is a JSON object of claims — never an array or a bare scalar. */
export const UserinfoSchema = Schema.Record(Schema.String, Schema.Unknown);
