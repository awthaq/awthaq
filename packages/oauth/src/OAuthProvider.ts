// @awthaq/oauth — OAuthProvider
//
// spec/behaviors/16-oauth.md, BEH-EA-121, BEH-EA-126, BEH-EA-127.
// spec/models/02-oauth-oidc.md's `OAuthProvider.oidc({...})` sketch, made
// runnable. Two factories — `oidc`/`oauth2` — are the whole mechanism
// (structural PKCE, the documented `quirks.skipPkce` escape hatch, generic
// discovery); nothing in BEH-EA-121 through 128 needs more. IC-003's vendor
// presets (`google`/`github`/`microsoft`/`gitlab`/`discord`, in the
// `@awthaq/oauth/presets` subpath) are *data only* on top of them — they call
// these two factories with a vendor's issuer/endpoints/claim mapping, so the
// factories remain the escape hatch for any provider not listed.

import * as Config from "effect/Config";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as Jwt from "./Jwt.ts";
import * as ProviderHttp from "./ProviderHttp.ts";

export interface OAuthEndpoints {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri?: string;
  /** BEH-EA-121-adjacent: a plain `"oauth2"` provider's only source of profile claims (no `id_token` exists to carry them). */
  readonly userinfoEndpoint?: string;
}

/**
 * AP-006 (RFC 6749 §2.3.1, RFC 8414 `token_endpoint_auth_methods_supported`):
 * how the client authenticates at the token endpoint. `"none"` is a public
 * client (no secret). Chosen at boot — see `resolve`.
 */
export type TokenEndpointAuthMethod = "client_secret_basic" | "client_secret_post" | "none";

/** BEH-EA-121: a provider that rejects PKCE outright (documented per-provider, never a general escape hatch). */
export interface OAuthProviderQuirks {
  readonly skipPkce?: boolean;
}

/**
 * NAM-004: when a provider's discovery document is fetched.
 *
 * - `"boot"` (the default): resolved once while the plugin's layer builds —
 *   an unreachable or mismatching document fails startup (BEH-EA-127), after
 *   the discovery GET's own retries.
 * - `"lazy"`: resolved on first use and refreshed every `refresh` (default
 *   one hour). While discovery is unreachable the provider answers
 *   `ProviderUnavailable` (503) without blocking the rest of the auth
 *   runtime; a fetched issuer that mismatches (or a malformed document)
 *   disables the provider permanently with a logged defect — BEH-EA-127
 *   still fails closed, just at first use instead of boot.
 */
export interface OAuthDiscoveryPolicy {
  readonly mode: "boot" | "lazy";
  readonly refresh?: Duration.Duration;
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
  readonly issuer?: string | Config.Config<string>;
  /** BEH-EA-127: when given, `discoveryUrl`'s fetched `issuer` MUST exact-match `issuer` above. */
  readonly discoveryUrl?: string | Config.Config<string>;
  /** Required when `discoveryUrl` is absent. */
  readonly endpoints?: OAuthEndpoints;
  readonly clientId: string | Config.Config<string>;
  /** BEH-EA-126: read via `Config.Redacted` — absent only for a fully public client. */
  readonly clientSecret?: Config.Config<Redacted.Redacted<string>>;
  readonly scopes: ReadonlyArray<string>;
  readonly pkce: true;
  readonly quirks?: OAuthProviderQuirks;
  /**
   * AP-006: leave unset to let `resolve` pick — `client_secret_basic` (the
   * RFC 6749 default) unless the discovery document advertises only
   * `client_secret_post`; `"none"` when there is no `clientSecret`. Set it
   * for a provider that documents one method without advertising it (Apple,
   * for instance, wants the secret in the body).
   */
  readonly tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
  /** NAM-004: only meaningful with a `discoveryUrl`. */
  readonly discovery?: OAuthDiscoveryPolicy;
  /**
   * AOMS-005: the `id_token` signature algorithms this provider may use — an allowlist the token
   * header can select within but never widen. Unset: the discovery document's
   * `id_token_signing_alg_values_supported` intersected with what `Jwt.SIGNING_ALGS` verifies, or
   * `["RS256"]` when discovery does not advertise any. An empty effective list dies at boot.
   */
  readonly idTokenSigningAlgs?: ReadonlyArray<Jwt.SigningAlg>;
  readonly mapProfile: (claims: Record<string, unknown>) => OAuthProfile;
}

/**
 * BO-009: a non-secret field may be a plain string (no `Config.succeed(...)`
 * ceremony for a literal) or a `Config` read from the environment. The
 * secret is deliberately *not* lifted this way: `clientSecret` stays
 * `Config<Redacted>` only, so a literal secret cannot type-check (BEH-EA-126).
 */
export const liftConfig = (value: string | Config.Config<string>): Config.Config<string> =>
  typeof value === "string" ? Config.succeed(value) : value;

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
  readonly tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  /** AOMS-005: the effective `id_token` algorithm allowlist (never empty for an `oidc` provider). */
  readonly idTokenSigningAlgs: ReadonlyArray<Jwt.SigningAlg>;
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
  token_endpoint_auth_methods_supported: Schema.optional(Schema.Array(Schema.String)),
  id_token_signing_alg_values_supported: Schema.optional(Schema.Array(Schema.String)),
});

/**
 * NAM-004: the discovery endpoint could not be *reached* (transport failure,
 * deadline overrun, 5xx after retries) — as opposed to reached and wrong,
 * which is a defect. The one failure `resolve` returns typed, so the caller
 * chooses between failing boot (`"boot"` mode) and answering 503 (`"lazy"`).
 */
export class DiscoveryUnavailable extends Data.TaggedError("DiscoveryUnavailable")<{
  readonly providerId: string;
  readonly message: string;
}> {}

/**
 * BEH-EA-127: a mismatched discovery document, a malformed one, or a
 * provider missing endpoints it needed is a deployment defect, not a
 * request-level condition, so those die rather than returning a typed
 * error — exactly BEH-EA-127's "registration fails ... no request-serving
 * code path is ever reached". Only an *unreachable* discovery endpoint is a
 * typed `DiscoveryUnavailable` (NAM-004). `httpClient` should be the
 * retrying client (ERS-003); `discoveryTimeout` bounds the GET (ECF-001).
 */
export const resolve = (
  httpClient: HttpClient.HttpClient,
  config: OAuthProviderConfig,
  options: { readonly discoveryTimeout: Duration.Duration },
): Effect.Effect<ResolvedProvider, DiscoveryUnavailable> =>
  Effect.gen(function* () {
    const clientId = yield* liftConfig(config.clientId).pipe(Effect.orDie);
    const clientSecret =
      config.clientSecret === undefined
        ? Option.none()
        : Option.some(yield* config.clientSecret.pipe(Effect.orDie));
    const configuredIssuer =
      config.issuer === undefined
        ? Option.none()
        : Option.some(yield* liftConfig(config.issuer).pipe(Effect.orDie));

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
    let advertisedAuthMethods: ReadonlyArray<string> | undefined;
    let advertisedIdTokenAlgs: ReadonlyArray<string> | undefined;

    if (config.discoveryUrl !== undefined) {
      const discoveryUrl = yield* liftConfig(config.discoveryUrl).pipe(Effect.orDie);
      const document = yield* httpClient.get(discoveryUrl).pipe(
        Effect.flatMap(ProviderHttp.decodeBody(DiscoveryDocumentSchema)),
        Effect.timeout(options.discoveryTimeout),
        Effect.catch((error) =>
          ProviderHttp.isUnavailable(error)
            ? Effect.fail(
                new DiscoveryUnavailable({
                  providerId: config.id,
                  message: `awthaq/oauth: provider "${config.id}" discovery is unreachable: ${error.message}`,
                }),
              )
            : Effect.die(
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
      advertisedAuthMethods = document.token_endpoint_auth_methods_supported;
      advertisedIdTokenAlgs = document.id_token_signing_alg_values_supported;
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

    // AP-006: the client-authentication method is decided once, here, so a
    // mismatch with what the provider advertises surfaces at boot instead of
    // as a `invalid_client` at the first sign-in.
    const hasSecret = Option.isSome(clientSecret);
    const configuredMethod = config.tokenEndpointAuthMethod;
    const methodProblem = (problem: string) =>
      Effect.die(new Error(`awthaq/oauth: provider "${config.id}" ${problem}`));
    let tokenEndpointAuthMethod: TokenEndpointAuthMethod;
    if (configuredMethod !== undefined) {
      if (configuredMethod === "none" && hasSecret) {
        return yield* methodProblem(
          'sets tokenEndpointAuthMethod "none" but has a clientSecret it would never send',
        );
      }
      if (configuredMethod !== "none" && !hasSecret) {
        return yield* methodProblem(
          `sets tokenEndpointAuthMethod "${configuredMethod}" but has no clientSecret`,
        );
      }
      if (
        configuredMethod !== "none" &&
        advertisedAuthMethods !== undefined &&
        !advertisedAuthMethods.includes(configuredMethod)
      ) {
        return yield* methodProblem(
          `sets tokenEndpointAuthMethod "${configuredMethod}" but its discovery document ` +
            `advertises only [${advertisedAuthMethods.join(", ")}]`,
        );
      }
      tokenEndpointAuthMethod = configuredMethod;
    } else if (!hasSecret) {
      tokenEndpointAuthMethod = "none";
    } else if (
      advertisedAuthMethods === undefined ||
      advertisedAuthMethods.includes("client_secret_basic")
    ) {
      tokenEndpointAuthMethod = "client_secret_basic";
    } else if (advertisedAuthMethods.includes("client_secret_post")) {
      tokenEndpointAuthMethod = "client_secret_post";
    } else {
      return yield* methodProblem(
        `advertises only [${advertisedAuthMethods.join(", ")}] at its token endpoint; ` +
          "this plugin supports client_secret_basic and client_secret_post",
      );
    }

    // AOMS-005: explicit list, else what discovery advertises (only the algorithms this plugin can
    // verify), else the RS256 every provider supports. Nothing verifiable is a boot defect, not a
    // first-sign-in surprise.
    const idTokenSigningAlgs =
      config.idTokenSigningAlgs ??
      (advertisedIdTokenAlgs === undefined
        ? Jwt.SIGNING_ALGS.filter((alg) => alg === "RS256")
        : Jwt.SIGNING_ALGS.filter((alg) => advertisedIdTokenAlgs.includes(alg)));
    if (config.kind === "oidc" && idTokenSigningAlgs.length === 0) {
      return yield* Effect.die(
        new Error(
          `awthaq/oauth: provider "${config.id}" advertises id_token signing algorithms ` +
            `[${(advertisedIdTokenAlgs ?? []).join(", ")}], none of which this plugin verifies ` +
            `(${Jwt.SIGNING_ALGS.join(", ")}); set idTokenSigningAlgs explicitly or use another provider`,
        ),
      );
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
      tokenEndpointAuthMethod,
      idTokenSigningAlgs,
      mapProfile: config.mapProfile,
    };
  });

// Re-exported so a caller validating an `id_token` doesn't need its own
// import of the internal verifier module.
export { Jwt };
