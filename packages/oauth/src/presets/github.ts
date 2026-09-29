import * as OAuthProvider from "../OAuthProvider.ts";
import { idClaim, profileOf, stringClaim, type PresetInput } from "./Claims.ts";

/**
 * GitHub: plain OAuth2 (no `id_token`), claims from `GET /user`.
 *
 * - `id` is a JSON *number*; the subject is its string form.
 * - `/user`'s `email` is the public profile address (often `null`) and GitHub
 *   does not assert it verified, so no `emailVerified` is reported — the
 *   preset never enables trusted-email auto-linking on its own.
 * - The secret goes in the request body (`client_secret_post`), GitHub's
 *   documented form.
 */
export const github = (input: PresetInput) =>
  OAuthProvider.oauth2({
    id: input.id ?? "github",
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    scopes: input.scopes ?? ["read:user", "user:email"],
    endpoints: {
      authorizationEndpoint: "https://github.com/login/oauth/authorize",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
      userinfoEndpoint: "https://api.github.com/user",
    },
    tokenEndpointAuthMethod: "client_secret_post",
    mapProfile:
      input.mapProfile ??
      ((claims) =>
        profileOf({
          subject: idClaim(claims, "id"),
          email: stringClaim(claims, "email"),
          name: stringClaim(claims, "name") ?? stringClaim(claims, "login"),
        })),
  });
