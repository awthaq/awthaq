// @awthaq/web — HasSessionCookie
//
// spec/behaviors/24-nextjs-ssr.md, BEH-EA-188.
//
// The optimistic, `proxy.ts`-only check: presence of the session cookie,
// nothing more. `proxy.ts` is Next.js's own renamed convention (Next 16.3
// deprecated `middleware.ts` in favor of `proxy.ts`), and its own
// documentation states it "should not be used as a full session management
// or authorization solution" — CVE-2025-29927 is the concrete incident that
// made the point expensively (a crafted `x-middleware-subrequest` header
// could skip middleware entirely).
//
// This function performs no verification, no database call, and no
// principal resolution — it returns `true` for a forged or expired cookie
// just as readily as a valid one. It exists only so `proxy.ts` can redirect
// an obviously-anonymous visitor away from an app shell before a page even
// renders; the real boundary is `Session.ts`'s `getSession`, which every
// page and server action reached past `proxy.ts` must still call itself.
// Treating a passing `hasSessionCookie` check as authentication is exactly
// the mistake this module's own existence is meant to make hard to make.

import { Api } from "@awthaq/api";
import type { SessionCookie } from "@awthaq/core"; // type-only: erased, so the edge bundle stays free of core
import { hasCookie } from "./CookieHeader.ts";
import type { HeadersLike } from "./CookieHeader.ts";

/**
 * BEH-EA-188/IC-007: does the request carry the session cookie at all? Not
 * whether it is valid — see this module's header comment. `request` only needs
 * a `headers` object shaped like `HeadersLike` (both a Web platform
 * `NextRequest`/`Request` and Next's `ReadonlyHeaders` already qualify).
 *
 * `cookie` is the same partial a host gives `SessionCookie.config(...)` (`{}`
 * for the default): the cookie's name follows its mode (`__Secure-session`
 * under `SecureDomain`), and the argument is required so a `SecureDomain` host
 * cannot forget it.
 */
export const hasSessionCookie = (
  request: { readonly headers: HeadersLike },
  cookie: { readonly mode?: SessionCookie.Mode },
): boolean =>
  hasCookie(
    request.headers.get("cookie"),
    Api.sessionCookieName(cookie.mode ?? { _tag: "Host" }, "session"),
  );
