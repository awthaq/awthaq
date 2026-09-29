import * as OAuthProvider from "../OAuthProvider.ts";
import { booleanClaim, idClaim, profileOf, stringClaim, type PresetInput } from "./Claims.ts";

/**
 * GitLab (gitlab.com or a self-managed instance): OIDC via discovery.
 * `baseUrl` is the instance's public URL with no trailing slash and is also
 * the expected issuer (default `https://gitlab.com`).
 */
export const gitlab = (input: PresetInput & { readonly baseUrl?: string }) => {
  const baseUrl = input.baseUrl ?? "https://gitlab.com";
  return OAuthProvider.oidc({
    id: input.id ?? "gitlab",
    issuer: baseUrl,
    discoveryUrl: `${baseUrl}/.well-known/openid-configuration`,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    scopes: input.scopes ?? ["openid", "email", "profile"],
    mapProfile:
      input.mapProfile ??
      ((claims) =>
        profileOf({
          subject: idClaim(claims, "sub"),
          email: stringClaim(claims, "email"),
          emailVerified: booleanClaim(claims, "email_verified"),
          name: stringClaim(claims, "name") ?? stringClaim(claims, "nickname"),
          image: stringClaim(claims, "picture"),
        })),
  });
};
