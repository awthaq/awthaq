import * as OAuthProvider from "../OAuthProvider.ts";
import { booleanClaim, idClaim, profileOf, stringClaim, type PresetInput } from "./Claims.ts";

/**
 * Discord: plain OAuth2 (not an OIDC provider — no `id_token`), claims from
 * `GET /users/@me`. `id` is a snowflake string; `verified` is Discord's own
 * assertion about the account email.
 */
export const discord = (input: PresetInput) =>
  OAuthProvider.oauth2({
    id: input.id ?? "discord",
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    scopes: input.scopes ?? ["identify", "email"],
    endpoints: {
      authorizationEndpoint: "https://discord.com/oauth2/authorize",
      tokenEndpoint: "https://discord.com/api/oauth2/token",
      userinfoEndpoint: "https://discord.com/api/users/@me",
    },
    mapProfile:
      input.mapProfile ??
      ((claims) =>
        profileOf({
          subject: idClaim(claims, "id"),
          email: stringClaim(claims, "email"),
          emailVerified: booleanClaim(claims, "verified"),
          name: stringClaim(claims, "global_name") ?? stringClaim(claims, "username"),
        })),
  });
