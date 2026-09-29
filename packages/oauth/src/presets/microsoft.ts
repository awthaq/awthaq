import * as OAuthProvider from "../OAuthProvider.ts";
import { idClaim, profileOf, stringClaim, type PresetInput } from "./Claims.ts";

/**
 * Microsoft Entra ID (v2.0 endpoint): OIDC via discovery, for **one tenant**.
 *
 * `tenant` must be that tenant's *ID* (the GUID), because Entra's discovery
 * document and its `id_token`s carry the tenant-id issuer
 * (`https://login.microsoftonline.com/<tenant-id>/v2.0`) and BEH-EA-127
 * matches the issuer exactly. The multi-tenant aliases (`common`,
 * `organizations`, `consumers`) publish a `{tenantid}` placeholder issuer and
 * therefore fail loudly at boot, by design. Entra's `email` claim is not a
 * verified-ownership assertion (Microsoft's own guidance forbids using it for
 * authorization), so no `emailVerified` is reported.
 */
export const microsoft = (input: PresetInput & { readonly tenant: string }) =>
  OAuthProvider.oidc({
    id: input.id ?? "microsoft",
    issuer: `https://login.microsoftonline.com/${input.tenant}/v2.0`,
    discoveryUrl: `https://login.microsoftonline.com/${input.tenant}/v2.0/.well-known/openid-configuration`,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    scopes: input.scopes ?? ["openid", "email", "profile"],
    mapProfile:
      input.mapProfile ??
      ((claims) =>
        profileOf({
          subject: idClaim(claims, "sub"),
          email: stringClaim(claims, "email"),
          name: stringClaim(claims, "name"),
        })),
  });
