// @awthaq/oauth — Plugin (M4)
//
// spec/behaviors/16-oauth.md, BEH-EA-121 through BEH-EA-128.
// `OAuth`/`OAuth.layer` (generic authorization-code + PKCE + OIDC `id_token`
// flow, explicit-by-default account linking, `Config.Redacted` provider
// secrets, discovery with exact issuer match), `OAuthProvider` (the
// provider descriptor + `oidc`/`oauth2` factories + boot-time `resolve`),
// `OAuthTokenAccess` (BE-002: the scoped provider-token-refresh port), and
// `OAuthApi` (this plugin's own contract, mounted under the shared `"auth"`
// id, group `"oauth"`) — see `OAuth.ts`'s own header comment for exactly
// what is and isn't built (RS256-only `id_token` verification, no vendor
// presets).
//
// See spec/overview.md for the full package map.

export * as OAuth from "./OAuth.ts";
export * as OAuthApi from "./OAuthApi.ts";
export * as OAuthConnections from "./OAuthConnections.ts";
export * as OAuthProvider from "./OAuthProvider.ts";
export * as OAuthTokenAccess from "./OAuthTokenAccess.ts";
