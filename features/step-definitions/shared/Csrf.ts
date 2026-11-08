// features/step-definitions/shared — the CSRF pair a hand-wired World posts with (plan 08: the token is `TestAuth.csrfToken`;
// a World built on `TestAuth.app` never needs this, `app.request` mints its own)
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

import { TestAuth, UserAgent } from "@awthaq/test";

/**
 * The `CsrfConfig` every world's `CsrfProtectionLive` is built against: `TestAuth`'s own default, so a world
 * that still hand-builds the middleware and a composition `TestAuth.layer` derives it for agree on the secret.
 */
export const CsrfConfigForTests = TestAuth.TestCsrfConfig;

export const CSRF_COOKIE_NAME = "__Host-csrf";
export const CSRF_HEADER_NAME = "x-csrf-token";

/**
 * Plan 20: a user agent over a hand-wired World's handler, already holding a `__Host-csrf` minted against
 * `CsrfConfigForTests` (as `TestAuth.app`'s agents do), so it keeps its own cookies (the session a sign-in
 * sets, a rotation, an expiry) and echoes the CSRF token on an unsafe `request` like a page script.
 */
export const agentOver = (
  handler: (request: Request) => Promise<Response>,
  options: Omit<UserAgent.UserAgentOptions, "handler"> = {},
) => {
  const agent = UserAgent.make({ ...options, handler });
  agent.cookies.receive(TestAuth.csrfSetCookie(CsrfConfigForTests.secret));
  return agent;
};
