// @awthaq/next — GetSession
//
// spec/behaviors/24-nextjs-ssr.md, BEH-EA-185.
//
// BO-004: the database-verified `getSession`, `applyRotatedSession` and the
// `Session` shape are framework-neutral and live in `@awthaq/web`
// (`Session.ts`, where the full contract is documented). The one Next-specific
// piece stays here: the per-render dedup.
import { applyRotatedSession, makeGetSession, verifySessionToken } from "@awthaq/web";
import { cache } from "react";

export type { HeadersLike, Session } from "@awthaq/web";
export { applyRotatedSession };

/**
 * NSA-002: `React.cache()` — the framework-idiomatic per-request/per-render
 * dedup mechanism Next.js itself documents, scoped to exactly one render
 * pass or one Server Action invocation, never spanning across them (so it
 * doesn't relitigate BEH-EA-190's "a server action MUST call getSession
 * fresh on every invocation"). Two `getSession` calls against the same
 * cookie within one render/action hit `sessions.verify` exactly once —
 * closing the "second call loses the rotation race" scenario structurally,
 * the same way ticket 03's `Authentication.ts` cache closed it for the HTTP
 * path (a `WeakMap` keyed on `HttpServerRequest` identity, which a Server
 * Component/Server Action never has — that mechanism doesn't reach here).
 *
 * BEH-EA-185: verifies the incoming request's session cookie against the
 * database. Resolves `undefined` — never throws, never rejects — for a
 * missing, malformed, expired, or unknown-session cookie; only a genuine
 * backing-store outage propagates as a rejection.
 */
export const getSession = makeGetSession(cache(verifySessionToken));
