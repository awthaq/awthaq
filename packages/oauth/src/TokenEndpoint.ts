// @awthaq/oauth — TokenEndpoint
//
// AP-006: how a token-endpoint request authenticates the client — shared by
// `OAuth.ts`'s code exchange and `OAuthTokenAccess.ts`'s refresh grant so the
// two can never disagree. The method itself (`client_secret_basic`,
// `client_secret_post`, or `none` for a public client) is chosen and
// validated once, at boot, by `OAuthProvider.resolve`.

import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpBody from "effect/unstable/http/HttpBody";
import type * as OAuthProvider from "./OAuthProvider.ts";

/**
 * `application/x-www-form-urlencoded` encoding of one value (spaces as `+`,
 * reserved characters percent-encoded) — what RFC 6749 §2.3.1 requires the
 * client id and secret to go through *before* they are base64'd into a Basic
 * credential. `HttpClientRequest.basicAuth` would skip that step.
 */
export const formUrlEncode = (value: string): string =>
  new URLSearchParams({ v: value }).toString().slice(2);

/**
 * The body and headers of a token request whose grant-specific fields are
 * `grant`, with the client authenticated per the provider's resolved method:
 *
 * - `client_secret_basic` — an `Authorization: Basic` header (RFC 6749
 *   §2.3.1's default) and no `client_secret` in the body;
 * - `client_secret_post` — `client_secret` in the body, no header;
 * - `none` — a public client: `client_id` only.
 *
 * `client_id` is always in the body, which no method forbids.
 */
export const clientAuthentication = (
  provider: OAuthProvider.ResolvedProvider,
  grant: Record<string, string>,
) => {
  const fields: Record<string, string> = { ...grant, client_id: provider.clientId };
  const secret = Option.map(provider.clientSecret, Redacted.value);
  // RFC 6749 §5.1 token responses are JSON; some providers (GitHub) answer
  // form-encoded unless asked, so the request says what it can decode.
  const headers: Record<string, string> = { accept: "application/json" };
  if (Option.isSome(secret)) {
    if (provider.tokenEndpointAuthMethod === "client_secret_basic") {
      const credentials = `${formUrlEncode(provider.clientId)}:${formUrlEncode(secret.value)}`;
      headers["authorization"] = `Basic ${btoa(credentials)}`;
    } else if (provider.tokenEndpointAuthMethod === "client_secret_post") {
      fields["client_secret"] = secret.value;
    }
  }
  return { body: HttpBody.urlParams(fields), headers };
};
