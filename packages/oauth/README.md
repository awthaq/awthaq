# @awthaq/oauth

The OAuth/OIDC plugin: authorization-code + PKCE flows over provider descriptors (`OAuthProvider.oidc` / `.oauth2`, discovery with exact issuer match), `id_token` verification, explicit-by-default account linking, `Encryption`-protected flow state and `OAuthTokenAccess` (scoped provider-token refresh). Mounted under `"auth"`, group `"oauth"`.

Known limits are documented in `OAuth.ts`'s header (RS256-only `id_token` verification, no vendor presets).

See [`spec/behaviors/16-oauth.md`](../../spec/behaviors/16-oauth.md) (BEH-EA-121–128).
