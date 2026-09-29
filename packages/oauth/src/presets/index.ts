// @awthaq/oauth/presets
//
// IC-003: data-only vendor presets built on `OAuthProvider.oidc`/`oauth2` —
// zero new mechanism, so every BEH-EA-121 through 128 guarantee applies
// unchanged and the two factories remain the escape hatch for any provider
// not listed here. Discovery-based presets rely on BEH-EA-127's exact issuer
// match, so a stale preset fails loudly at boot instead of silently trusting
// a moved endpoint. Each preset takes the app's credentials plus optional
// overrides (`scopes`, `id`, `mapProfile`) and returns an ordinary
// `OAuthProviderConfig`.
//
// Deliberately absent: Apple. Its `name`/`email` scopes require
// `response_mode=form_post`, i.e. a *POST* callback, and this plugin's
// callback is a GET-only contract; a preset that could not complete a real
// sign-in would be worse than none. (`quirks.skipPkce` exists for it — see
// BEH-EA-121 — once a POST callback does.)

export * as Claims from "./Claims.ts";
export type { PresetInput } from "./Claims.ts";
export { discord } from "./discord.ts";
export { github } from "./github.ts";
export { gitlab } from "./gitlab.ts";
export { google } from "./google.ts";
export { microsoft } from "./microsoft.ts";
