// @awthaq/api — AuthCore
//
// The one top-level `HttpApi` id ("auth") core's own groups mount under
// (BEH-EA-031: "its groups sit at the root of `/auth`"). `session`
// (BEH-EA-031) and `account` (shipping-gap map, tickets 09/10).
// MW-002: `Auth.make` seeds its composed `api` with these groups, so this is
// the typed input `HttpApiBuilder.group` builds core's handlers against
// (`AuthHttp.coreHandlers`), not a second document a host serves beside the
// composed one. Its "auth" id is the composed api's own, which is what keys a
// group's handler service.

import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import { AccountGroup } from "./Account.ts";
import { SessionGroup } from "./Session.ts";

export const AuthCoreApi = HttpApi.make("auth").add(SessionGroup).add(AccountGroup);
