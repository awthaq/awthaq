// P20a follow-up (BEH-EA-048/254): a toy plugin, "profile", that contributes three typed user fields
// (SAM-004, ADR-EA-035) and a data-export section, so the users/accounts feature can prove the
// write-gate and the export guarantee against the real `Users`/`Account`/`AccountExport` code.
//
// Real plugins ship no user field today, and BEH-EA-048's whole point is what a *plugin* does to a
// shared table — so a stand-in with the exact shape a real one would declare is the honest subject.
import { AuthPlugin } from "@awthaq/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { UserFields } from "@awthaq/core";

const ProfileApi = HttpApi.make("auth").add(
  HttpApiGroup.make("profile").add(
    HttpApiEndpoint.get("probe", "/profile/probe", { success: Schema.String }),
  ),
);

export class Profile extends AuthPlugin.Service<
  Profile,
  { readonly probe: () => Effect.Effect<string> }
>()("profile", {
  apiVersion: 1,
  contract: ProfileApi,
  userFields: {
    // The plugin left the write-gate at its default: client-writable (BEH-EA-048).
    nickname: UserFields.field(Schema.String),
    // A system-authority field the plugin correctly declared non-writable in its own schema.
    billingTier: UserFields.serverOnly(Schema.Literals(["free", "pro"])),
    // A system-authority field the plugin *forgot* to protect: the base system gives it nothing.
    isElevated: UserFields.field(Schema.Boolean),
  },
}) {
  static readonly layer = AuthPlugin.layer(Profile, {
    make: Effect.succeed({ probe: () => Effect.succeed("ok") }),
    handlers: HttpApiBuilder.group(ProfileApi, "profile", (handlers) =>
      handlers.handle("probe", () => Effect.succeed("ok")),
    ),
  });
}

/** The keys a plugin's declared field carries in the registry and on the wire: `<plugin id>_<field>`. */
export const fieldKey = (name: string) => `profile_${name}`;
