// @awthaq/saml — SamlApi
//
// spec/behaviors/29-saml-sp.md, BEH-EA-238 through 245; spec/models/10-saml.md ("The contract"). One group, `saml`
// (BEH-EA-004): the SP metadata document, the login redirect, and the Assertion Consumer Service.
//
// Every validation failure at the ACS is ONE uniform `SamlAssertionRejected` with no fields (BEH-EA-238): which
// check failed is logged and audited (`auth.user.signInFailed` with reason `assertionInvalid`), never answered, so
// the endpoint is no oracle for probing the chain.
//
// No `CsrfProtection`: the ACS is a cross-site POST from the IdP by construction, and the request is bound to the
// browser that started it by the `__Host-saml-request` cookie plus a single-consume request id, which is what
// CSRF defence is FOR here (login CSRF is the attack this class of endpoint has).

import { Api } from "@awthaq/api";
import { HookPoint, Hooks, Users } from "@awthaq/core";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

/** No such connection — or its organization is suspended or gone (indistinguishable, BEH-EA-237). */
export class SamlConnectionNotFound extends Schema.TaggedError<SamlConnectionNotFound>()(
  "SamlConnectionNotFound",
  {},
  { httpApiStatus: 404 },
) {}

/** BEH-EA-238: the one answer to every reason a `SAMLResponse` can be refused. */
export class SamlAssertionRejected extends Schema.TaggedError<SamlAssertionRejected>()(
  "SamlAssertionRejected",
  {},
  { httpApiStatus: 400 },
) {}

export const ConnectionQuery = Schema.Struct({
  connection: Schema.String.pipe(
    Schema.check(
      Schema.makeFilter((value: string) =>
        value.length > 0 && value.length <= 255 ? undefined : "a connection id of 1 to 255 characters",
      ),
    ),
  ),
});
export type ConnectionQuery = typeof ConnectionQuery.Type;

export const LoginQuery = Schema.Struct({
  ...ConnectionQuery.fields,
  /** Where the browser lands after sign-in: a relative path, or an origin in `SamlConfig.trustedOrigins`; anything else is the default. */
  callbackURL: Schema.optional(Schema.String),
});
export type LoginQuery = typeof LoginQuery.Type;

/** The form the IdP's browser posts. `RelayState` is accepted and ignored: the return path is held server-side. */
export const AcsPayload = Schema.Struct({
  SAMLResponse: Schema.String,
  RelayState: Schema.optional(Schema.String),
}).pipe(HttpApiSchema.asFormUrlEncoded());
export type AcsPayload = typeof AcsPayload.Type;

export const SamlGroup = HttpApiGroup.make("saml")
  .add(
    HttpApiEndpoint.get("metadata", "/auth/saml/metadata", {
      query: ConnectionQuery,
      success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "application/samlmetadata+xml" })),
      error: SamlConnectionNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("login", "/auth/saml/login", {
      query: LoginQuery,
      success: HttpApiSchema.Empty(302),
      error: [SamlConnectionNotFound, Api.RateLimited, Api.StoreUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.post("acs", "/auth/saml/acs", {
      payload: AcsPayload,
      success: HttpApiSchema.Empty(302),
      error: [
        SamlAssertionRejected,
        // SCP-001: `Users.assertCanSignIn` refused a suspended user.
        Users.UserSuspended,
        Api.RateLimited,
        Api.StoreUnavailable,
        HookPoint.HookAborted,
        Hooks.TwoFactorRequired,
      ],
    }),
  );

export const SamlApi = HttpApi.make("auth").add(SamlGroup);
