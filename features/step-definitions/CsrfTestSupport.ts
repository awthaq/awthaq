// features/step-definitions — CSRF test support
//
// CSS-001/CDS-001/APS-001/NHS-001/PIL-001/TMS-001: every mutating
// production group now carries `Api.CsrfProtection` (see each plugin's own
// `*Api.ts`). These BDD worlds call their composed app's real HTTP handler
// directly (`HttpRouter.toWebHandler`), never through `@awthaq/client`'s
// generated `CsrfClientLive` — so a world posting to a CSRF-protected group
// has to play the double-submit role a real browser client would, or every
// existing mutating scenario starts failing with `CsrfRejected`.
//
// Mirrors `packages/server/test/Csrf.test.ts`'s own `validCookieValue()`:
// an HMAC-SHA256 computed independently (Node's `node:crypto`, not
// `Csrf.ts`'s own implementation), so a passing scenario run exercises RFC
// 2104 compatibility, not just self-consistency with the code under test.

import * as Redacted from "effect/Redacted";
import { createHmac, randomBytes } from "node:crypto";

const CSRF_TEST_SECRET = "features-bdd-csrf-test-secret-padded-to-thirty-two-bytes";

/** The `CsrfConfig` every world's `CsrfProtectionLive` is built against. */
export const CsrfConfigForTests = {
  secret: Redacted.make(CSRF_TEST_SECRET),
  allowedOrigins: [] as ReadonlyArray<string>,
};

const CSRF_COOKIE_NAME = "__Host-csrf";

/**
 * One signed double-submit token, valid against `CsrfConfigForTests`'s
 * secret for the lifetime of the test process — `CsrfProtectionLive` never
 * rotates a cookie it already considers valid, so a single fixed value
 * reused across every request in every scenario is exactly what a real
 * client that bootstrapped the cookie once would also do.
 */
export const CSRF_TEST_COOKIE_VALUE: string = (() => {
  // CDS-006: `<iat>.<random>.<hmac(iat.random)>`. The handler under test runs on the real clock here (a web handler).
  const signed = `${Math.floor(Date.now() / 1000)}.${randomBytes(32).toString("hex")}`;
  const signature = createHmac("sha256", CSRF_TEST_SECRET).update(signed).digest("hex");
  return `${signed}.${signature}`;
})();

/** Appends the double-submit CSRF cookie to an existing `cookie` header value, if any. */
export const withCsrfCookie = (cookie?: string): string =>
  cookie
    ? `${cookie}; ${CSRF_COOKIE_NAME}=${CSRF_TEST_COOKIE_VALUE}`
    : `${CSRF_COOKIE_NAME}=${CSRF_TEST_COOKIE_VALUE}`;
