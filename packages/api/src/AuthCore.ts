// @effect-auth/api — AuthCore
//
// The one top-level `HttpApi` id ("auth") core's own groups mount under
// (BEH-EA-031: "its groups sit at the root of `/auth`"). `session`
// (BEH-EA-031) and `account` (shipping-gap map, tickets 09/10) today;
// `Auth.make`'s eventual plugin-contract merge (BEH-EA-032) will fold
// plugin groups into an api built the same way, under the same "auth"
// id — that composition is separate, later work (see `Auth.ts`'s own
// header comment in `@effect-auth/core`), not something this value needs
// to anticipate.

import { HttpApi } from "effect/unstable/httpapi";
import { AccountGroup } from "./Account.ts";
import { SessionGroup } from "./Session.ts";

export const AuthCoreApi = HttpApi.make("auth").add(SessionGroup).add(AccountGroup);
