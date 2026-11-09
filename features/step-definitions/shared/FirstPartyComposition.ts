// ADR-EA-049: a composition of every first-party plugin that declares events, with what they depend on, in
// link order. Its `events` is the registry a scenario about "every tag the library can publish" reads: core's
// definitions plus every first-party plugin's. Built on demand (`Auth.make` runs its linker each call).
import { Admin, AdminAccounts } from "@awthaq/admin";
import { ApiKey } from "@awthaq/api-key";
import { Auth } from "@awthaq/core";
import { DeviceAuthorization } from "@awthaq/device-authorization";
import { Jwt } from "@awthaq/jwt";
import { EmailOtp, MagicLink } from "@awthaq/magic-link";
import { OAuth } from "@awthaq/oauth";
import { Organization } from "@awthaq/organization";
import { Passkey } from "@awthaq/passkey";
import { Password } from "@awthaq/password";
import { UserClaims } from "@awthaq/qadi";
import { Roles } from "@awthaq/roles";
import { Saml } from "@awthaq/saml";
import { Scim } from "@awthaq/scim";
import { TwoFactor } from "@awthaq/two-factor";
import { Webhooks } from "@awthaq/webhooks";

export const everyFirstPartyPlugin = () =>
  Auth.make([
    Password.Password,
    Jwt.Jwt,
    Admin.Admin,
    AdminAccounts.AdminAccounts,
    ApiKey.ApiKey,
    DeviceAuthorization.DeviceAuthorization,
    UserClaims.UserClaims,
    Roles.Roles,
    Organization.Organization,
    Scim.Scim,
    Saml.Saml,
    TwoFactor.TwoFactor,
    Webhooks.Webhooks,
    MagicLink.MagicLink,
    EmailOtp.EmailOtp,
    OAuth.OAuth,
    Passkey.Passkey,
  ]);
