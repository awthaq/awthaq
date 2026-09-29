// @awthaq/next — Client
//
// Next.js adapter: server/client boundary, cookie forwarding.
//
// spec/behaviors/24-nextjs-ssr.md, BEH-EA-185/188/189.
// See .scratch/next-package/spec.md for the implementation decisions this
// package follows, and spec/overview.md for the full package map.

// RRS-002/NF-11-2: `applyRotatedSession` is half of the ticket-16 rotation design —
// without it a Server Action has no way to deliver `Session.rotated`.
export { applyRotatedSession, getSession } from "./GetSession.ts";
export type { HeadersLike, Session } from "./GetSession.ts";
export { hasSessionCookie } from "./HasSessionCookie.ts";
export { withNextCookies } from "./WithNextCookies.ts";
export type { CookieJarLike, CookieSetOptions } from "./WithNextCookies.ts";
