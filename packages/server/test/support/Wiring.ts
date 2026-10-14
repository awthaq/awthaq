// The wiring the server package's own suites share (plan 08 follow-up). `@awthaq/server` sits below `@awthaq/test` in
// the package graph, so these suites cannot use `TestAuth`; what they repeated instead lives here once: the principal
// resolver, the CSRF configuration and protection, and the double-submit token mint. Anything a suite is *about* (an
// authentication scheme, a CORS origin list, a CSRF origin rule) stays in that suite.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { createHmac, randomBytes } from "node:crypto";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Authentication from "../../src/Authentication.ts";
import * as Csrf from "../../src/Csrf.ts";

/** At least 32 bytes, as `Csrf.layerConfig` requires. */
const TEST_CSRF_SECRET = "server-test-csrf-secret-padded-to-thirty-two-bytes";

/** The resolver every suite here uses: `Sessions` -> `PrincipalResolver`, no user facts. */
export const resolver = Authentication.PrincipalResolverLive;

/** A fixed `CsrfConfig`; `allowedOrigins` is what the origin check (and `AuthHttp.cors`) reads. */
export const csrfConfig = (
  allowedOrigins: ReadonlyArray<string> = [],
  extra: Partial<Csrf.CsrfConfigShape> = {},
) =>
  Layer.succeed(Csrf.CsrfConfig, {
    secret: Redacted.make(TEST_CSRF_SECRET),
    allowedOrigins,
    ...extra,
  });

/** `CsrfProtection` over `csrfConfig(allowedOrigins)`; the platform `Crypto` is provided, `CsrfConfig` is not left in the output. */
export const csrfLive = (allowedOrigins: ReadonlyArray<string> = []) =>
  Csrf.CsrfProtectionLive.pipe(
    Layer.provide(csrfConfig(allowedOrigins)),
    Layer.provide(NodeCrypto.layer),
  );

/**
 * A signed double-submit token (`<iat>.<random>.<hmac(iat.random)>`) computed with `node:crypto`, independently of
 * `Csrf.ts`'s own implementation, so a passing request proves RFC 2104 compatibility and not mere self-consistency.
 * `issuedAt` is in seconds; `it.effect` runs under a `TestClock` that starts at 0, so the default is "minted now".
 */
export const mintCsrfToken = (issuedAt = 0, secret: string = TEST_CSRF_SECRET): string => {
  const signed = `${issuedAt}.${randomBytes(32).toString("hex")}`;
  return `${signed}.${createHmac("sha256", secret).update(signed).digest("hex")}`;
};
