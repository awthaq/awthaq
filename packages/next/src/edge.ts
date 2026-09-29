// @awthaq/next/edge — the stateless edge tier
//
// spec/behaviors/24-nextjs-ssr.md, BEH-EA-188 (BO-006, decision D1 option C).
//
// For `proxy.ts`/`middleware.ts` running at the edge, where a database lookup
// is not on offer: verify the opt-in, short-lived JWT session-mirror cookie
// (`JwtConfig.sessionCookie`) with `@awthaq/jwt`'s lite verifier instead of only
// checking that the opaque session cookie exists (`hasSessionCookie`). A forged
// or expired mirror is rejected without a database call.
//
// It is a better redirect signal, never the authorization boundary. The
// mirror is a *copy*: a revoked session's mirror keeps verifying for at most the
// configured `ttl`, and only a database-verified `getSession` (BEH-EA-185)
// decides access to anything that matters.
//
// Edge-safe by construction: this module imports only `effect`, the lite
// verifier (`@awthaq/jwt/verify` — checkably free of `@awthaq/core`/
// `@awthaq/server`) and `@awthaq/web/cookies`. Never import
// `getSession`/`serverActionClient` from a file that also runs at the edge.
import { SESSION_MIRROR_COOKIE_NAME, makeVerifier } from "@awthaq/jwt/verify";
import type { Verifier, VerifierOptions } from "@awthaq/jwt/verify";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { findCookieValue } from "@awthaq/web/cookies";
import type { HeadersLike } from "@awthaq/web/cookies";

/**
 * Builds the verifier once (module scope in `proxy.ts`): JWKS is fetched lazily
 * with `fetch`, cached, and refetched on an unknown `kid` (`@awthaq/jwt/verify`).
 * `algorithms` is required — an allowlist, never the token's own say-so — and
 * must match `JwtConfig.algorithm` (default `"EdDSA"`).
 */
export const makeSessionVerifier = (options: VerifierOptions): Promise<Verifier> =>
  Effect.runPromise(makeVerifier(options).pipe(Effect.provide(FetchHttpClient.layer)));

/**
 * The verified claims (`sub`, `sid`, `exp`, ...) of the request's session-mirror
 * cookie, or `undefined` when the cookie is missing, malformed, forged, expired
 * or issued for another audience. Never throws.
 *
 * ```ts
 * // proxy.ts
 * const verifier = await makeSessionVerifier({ jwksUrl, issuer, audience, algorithms: ["EdDSA"] });
 * export async function proxy(request: NextRequest) {
 *   if ((await verifySessionJwt(request, verifier)) === undefined) {
 *     return NextResponse.redirect(new URL("/sign-in", request.url));
 *   }
 * }
 * ```
 */
export const verifySessionJwt = async (
  request: { readonly headers: HeadersLike },
  verifier: Verifier,
  options?: { readonly cookieName?: string },
): Promise<Record<string, unknown> | undefined> => {
  const raw = findCookieValue(
    request.headers.get("cookie"),
    options?.cookieName ?? SESSION_MIRROR_COOKIE_NAME,
  );
  if (raw === undefined) return undefined;
  let token: string;
  try {
    token = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  return Effect.runPromise(
    Effect.match(verifier.verify(token), {
      onFailure: () => undefined,
      onSuccess: (claims) => claims,
    }),
  );
};
