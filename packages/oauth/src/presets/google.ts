import * as OAuthProvider from "../OAuthProvider.ts";
import { booleanClaim, idClaim, profileOf, stringClaim, type PresetInput } from "./Claims.ts";

/**
 * Google: OIDC via discovery. `email_verified` is asserted by Google, so this
 * preset is the usual candidate for `linking: { trustedProviders: ["google"] }`.
 */
export const google = (input: PresetInput) =>
  OAuthProvider.oidc({
    id: input.id ?? "google",
    issuer: "https://accounts.google.com",
    discoveryUrl: "https://accounts.google.com/.well-known/openid-configuration",
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
          name: stringClaim(claims, "name"),
        })),
  });
