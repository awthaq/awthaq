// @awthaq/server — internal SessionCookie
//
// CSS-002: a response that ends the caller's own session must also expire the
// session cookie — revoking the row server-side while the browser keeps
// presenting the dead credential leaves it forever `Unauthenticated` with no
// signal to clear it (and, for a Next.js adapter, no cookie for the bridge to
// clear). The expiry is `@awthaq/core`'s `SessionCookie.expire`, which renders
// the configured name/`Domain`/attributes so a mode other than the default
// still expires the cookie it wrote.
//
// Registered after the rotation-delivery handler (which runs at verify time),
// so the expiry wins over a rotated secret for a session that just ended.

import { SessionCookie } from "@awthaq/core";

export const expireSessionCookie = SessionCookie.expire;
