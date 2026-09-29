// P20a/AH-003: serves an `Auth.make` composition over `@awthaq/test`'s memory `TestAuth.layer`,
// so a foundations scenario can observe that a group added to the tuple really answers requests
// (BEH-EA-009/013), not only that the composed value mentions it.
import { Authentication, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { CsrfConfigForTests } from "./CsrfTestSupport.ts";
import * as Layer from "effect/Layer";

// `AuthHttp.coreHandlers` serves core's session/account groups, whose CsrfProtection and
// Authentication middleware are the host's to provide.
const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, CsrfConfigForTests),
  ),
  Layer.provide(NodeCrypto.layer),
);

const hostServices = Layer.mergeAll(
  Authentication.AuthenticationLive.pipe(Layer.provide(Authentication.PrincipalResolverLive)),
  CsrfProtectionLive,
);

/** The host services (`Authentication`, `CsrfProtection`) core's groups need — pass as `TestAuth.layer`'s second argument. */
export const services = hostServices;
