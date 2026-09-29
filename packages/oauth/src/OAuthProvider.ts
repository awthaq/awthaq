// @awthaq/oauth — OAuthProvider
//
// spec/behaviors/16-oauth.md, BEH-EA-121, BEH-EA-126, BEH-EA-127.
// spec/models/02-oauth-oidc.md's `OAuthProvider.oidc({...})` sketch, made
// runnable. Two factories only — `oidc`/`oauth2` — not per-vendor presets
// (`google()`/`github()`/`apple()`): nothing in BEH-EA-121 through 128
// requires a shipped Google/GitHub/Apple integration, only the mechanism
// (structural PKCE, the documented `quirks.skipPkce` escape hatch, generic
// discovery). A real deployment builds `google`/`github`/`apple` values by
// calling `oidc`/`oauth2` with that provider's own issuer/endpoints, the
// same way this plugin's own tests do with synthetic ids ("okta", "acme").

import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage";
import * as Jwt from "./Jwt.ts";

export interface OAuthEndpoints {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri?: string;
  /** BEH-EA-121-adjacent: a plain `"oauth2"` provider's only source of profile claims (no `id_token` exists to carry them). */
  readonly userinfoEndpoint?: string;
}

/** BEH-EA-121: a provider that rejects PKCE outright (documented per-provider, never a general escape hatch). */
export interface OAuthProviderQuirks {
  readonly skipPkce?: boolean;
}

export interface OAuthProfile {
  readonly subject: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly name?: string;
}

/**
 * BEH-EA-121: `pkce: true` is a structural literal, not `boolean` — there is
 * no value a provider author can pass to turn PKCE off; `quirks.skipPkce`
 * is the one documented, per-provider, visible-in-the-quirk-table
 * exception (BEH-EA-121's own "apple" scenario).
 */
export interface OAuthProviderConfig {
  readonly id: string;
  readonly kind: "oauth2" | "oidc";
  /**
   * BEH-EA-125/127: the expected issuer — required for `"oidc"` (both the
   * discovery exact-match check and the `id_token`'s own `iss` claim
   * validation read it), absent for a plain `"oauth2"` provider with no
   * `id_token` at all (e.g. GitHub).
   */
  readonly issuer?: Config.Config<string>;
  /** BEH-EA-127: when given, `discoveryUrl`'s fetched `issuer` MUST exact-match `issuer` above. */
  readonly discoveryUrl?: Config.Config<string>;
  /** Required when `discoveryUrl` is absent. */
  readonly endpoints?: OAuthEndpoints;
  readonly clientId: Config.Config<string>;
  /** BEH-EA-126: read via `Config.Redacted` — absent only for a fully public client. */
  readonly clientSecret?: Config.Config<Redacted.Redacted<string>>;
  readonly scopes: ReadonlyArray<string>;
  readonly pkce: true;
  readonly quirks?: OAuthProviderQuirks;
  readonly mapProfile: (claims: Record<string, unknown>) => OAuthProfile;
}

type FactoryInput = Omit<OAuthProviderConfig, "kind" | "pkce">;

/** A discovery-driven or explicit-endpoint OIDC provider — `id_token` claims are validated, `issuer` is required. */
export const oidc = (config: FactoryInput): OAuthProviderConfig => ({
  ...config,
  kind: "oidc",
  pkce: true,
});

/** A plain OAuth2 provider (e.g. GitHub) — no `id_token`, `issuer` is unused. */
export const oauth2 = (config: FactoryInput): OAuthProviderConfig => ({
  ...config,
  kind: "oauth2",
  pkce: true,
});

export interface ResolvedProvider {
  readonly id: string;
  readonly kind: "oauth2" | "oidc";
  readonly issuer: Option.Option<string>;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: Option.Option<string>;
  readonly userinfoEndpoint: Option.Option<string>;
  readonly clientId: string;
  readonly clientSecret: Option.Option<Redacted.Redacted<string>>;
  readonly scopes: ReadonlyArray<string>;
  readonly skipPkce: boolean;
  readonly mapProfile: (claims: Record<string, unknown>) => OAuthProfile;
}

/**
 * ESS-002/TTE-003/AP-008/JR-010: the discovery document is untrusted,
 * network-fetched input — decoded, never cast. An endpoint that is present
 * must be an absolute URL, so a malformed one dies at boot instead of
 * surfacing as a `new URL()` throw inside a request handler. Members this
 * plugin doesn't read are ignored.
 */
const AbsoluteUrl = Schema.String.check(
  Schema.makeFilter((value) => URL.canParse(value) || "must be an absolute URL"),
);

const DiscoveryDocumentSchema = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.optional(AbsoluteUrl),
  token_endpoint: Schema.optional(AbsoluteUrl),
  jwks_uri: Schema.optional(AbsoluteUrl),
  userinfo_endpoint: Schema.optional(AbsoluteUrl),
});

/**
 * BEH-EA-127: runs once, at plugin boot (this plugin's own `make`, per
 * provider) — never per-request. A mismatched or unfetchable discovery
 * document (or a provider missing endpoints it needed) is a deployment
 * defect, not a request-level condition, so this dies rather than
 * returning a typed error: exactly BEH-EA-127's "registration fails at
 * boot... no request-serving code path is ever reached."
 */
export const resolve = (
  httpClient: HttpClient.HttpClient,
  config: OAuthProviderConfig,
): Effect.Effect<ResolvedProvider> =>
  Effect.gen(function* () {
    const clientId = yield* config.clientId;
    const clientSecret =
      config.clientSecret === undefined ? Option.none() : Option.some(yield* config.clientSecret);
    const configuredIssuer =
      config.issuer === undefined ? Option.none() : Option.some(yield* config.issuer);

    if (config.kind === "oidc" && Option.isNone(configuredIssuer)) {
      return yield* Effect.die(
        new Error(`awthaq/oauth: provider "${config.id}" is oidc but declares no issuer`),
      );
    }

    // JR-009: an oidc provider that never asks for `openid` gets no
    // `id_token` back, which would otherwise surface only as an opaque
    // runtime 400 at the first callback.
    if (config.kind === "oidc" && !config.scopes.includes("openid")) {
      return yield* Effect.die(
        new Error(`awthaq/oauth: provider "${config.id}" is oidc but its scopes omit "openid"`),
      );
    }

    // OAP-005 (RFC 9700 §2.1.1): `skipPkce` is a per-vendor escape hatch for
    // *confidential* clients only — with no secret and no PKCE, the bare
    // authorization code is the whole credential.
    const skipPkce = config.quirks?.skipPkce ?? false;
    if (skipPkce) {
      if (Option.isNone(clientSecret)) {
        return yield* Effect.die(
          new Error(
            `awthaq/oauth: provider "${config.id}" sets quirks.skipPkce but has no clientSecret — ` +
              "a public client must use PKCE (RFC 9700 §2.1.1)",
          ),
        );
      }
      yield* Effect.logWarning(
        `awthaq/oauth: provider "${config.id}" runs the authorization-code flow without PKCE (quirks.skipPkce)`,
      );
    }

    let authorizationEndpoint = config.endpoints?.authorizationEndpoint;
    let tokenEndpoint = config.endpoints?.tokenEndpoint;
    let jwksUri = config.endpoints?.jwksUri;
    let userinfoEndpoint = config.endpoints?.userinfoEndpoint;

    if (config.discoveryUrl !== undefined) {
      const discoveryUrl = yield* config.discoveryUrl;
      const document = yield* httpClient.get(discoveryUrl).pipe(
        Effect.flatMap(HttpIncomingMessage.schemaBodyJson(DiscoveryDocumentSchema)),
        Effect.catch((error) =>
          Effect.die(
            new Error(
              `awthaq/oauth: provider "${config.id}" discovery document is invalid ` +
                `or unfetchable: ${error.message}`,
            ),
          ),
        ),
      );
      if (Option.isSome(configuredIssuer) && document.issuer !== configuredIssuer.value) {
        return yield* Effect.die(
          new Error(
            `awthaq/oauth: provider "${config.id}" discovery issuer "${document.issuer}" ` +
              `does not match configured issuer "${configuredIssuer.value}"`,
          ),
        );
      }
      authorizationEndpoint ??= document.authorization_endpoint;
      tokenEndpoint ??= document.token_endpoint;
      jwksUri ??= document.jwks_uri;
      userinfoEndpoint ??= document.userinfo_endpoint;
    }

    if (authorizationEndpoint === undefined || tokenEndpoint === undefined) {
      return yield* Effect.die(
        new Error(
          `awthaq/oauth: provider "${config.id}" has no authorizationEndpoint/tokenEndpoint ` +
            "(supply endpoints, or a discoveryUrl that publishes them)",
        ),
      );
    }

    // ESS-002: explicit endpoints get the same absolute-URL guarantee the
    // discovery schema gives fetched ones.
    for (const [field, value] of [
      ["authorizationEndpoint", authorizationEndpoint],
      ["tokenEndpoint", tokenEndpoint],
      ["jwksUri", jwksUri],
      ["userinfoEndpoint", userinfoEndpoint],
    ]) {
      if (value !== undefined && !URL.canParse(value)) {
        return yield* Effect.die(
          new Error(
            `awthaq/oauth: provider "${config.id}" ${field} "${value}" is not an absolute URL`,
          ),
        );
      }
    }

    return {
      id: config.id,
      kind: config.kind,
      issuer: configuredIssuer,
      authorizationEndpoint,
      tokenEndpoint,
      jwksUri: jwksUri === undefined ? Option.none<string>() : Option.some(jwksUri),
      userinfoEndpoint:
        userinfoEndpoint === undefined ? Option.none<string>() : Option.some(userinfoEndpoint),
      clientId,
      clientSecret,
      scopes: config.scopes,
      skipPkce,
      mapProfile: config.mapProfile,
    };
  }).pipe(Effect.orDie);

// Re-exported so a caller validating an `id_token` doesn't need its own
// import of the internal verifier module.
export { Jwt };
