// @awthaq/next — Client
//
// Next.js adapter: server/client boundary, cookie forwarding.
//
// spec/behaviors/24-nextjs-ssr.md, BEH-EA-185/188/189.
// See .scratch/next-package/spec.md for the implementation decisions this
// package follows, and spec/overview.md for the full package map.

export { getSession } from "./GetSession.ts";
export type { HeadersLike, Session } from "./GetSession.ts";
export { hasSessionCookie } from "./HasSessionCookie.ts";
export { withNextCookies } from "./WithNextCookies.ts";
export type { CookieJarLike, CookieSetOptions } from "./WithNextCookies.ts";
