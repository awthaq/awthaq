// @effect-auth/next — HasSessionCookie
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
// renders; the real boundary is `GetSession.ts`'s `getSession`, which every
// page and server action reached past `proxy.ts` must still call itself.
// Treating a passing `hasSessionCookie` check as authentication is exactly
// the mistake this module's own existence is meant to make hard to make.

import { Api } from "@effect-auth/api";
import { hasCookie } from "./CookieHeader.ts";
import type { HeadersLike } from "./GetSession.ts";

/**
 * BEH-EA-188: does the request carry a session cookie at all? Not whether
 * it is valid — see this module's header comment. `request` only needs a
 * `headers` object shaped like `HeadersLike` (both a Web platform
 * `NextRequest`/`Request` and Next's `ReadonlyHeaders` already qualify).
 */
export const hasSessionCookie = (request: { readonly headers: HeadersLike }): boolean =>
  hasCookie(request.headers.get("cookie"), Api.SessionCookie.key);
