// @awthaq/core — SessionCookie
//
// spec/behaviors/07-sessions.md, BEH-EA-055. IC-007/AGA-004/BO-005 (decision
// recorded in `.plan/DECISIONS.md`, option B): the session cookie's
// attributes are one `SessionCookieConfig` with a secure default and a
// closed union of typed opt-in modes, and EVERY issuance site — password,
// passkey, OAuth, admin, the Next adapter, the server's rotation delivery —
// renders its `Set-Cookie` through `render` below, so no site can drift from
// another and illegal combinations (a `__Host-` cookie with a `Domain`) are
// unrepresentable by construction: only `SecureDomain` carries a `domain`,
// and it renders the `__Secure-` prefix instead.

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Api } from "@awthaq/api";

/** BEH-EA-055 modes. The default is `Host`; the others are explicit, typed opt-ins. */
export type Mode =
  /** `__Host-session`, `SameSite=Strict`, no `Domain` — the secure default. */
  | { readonly _tag: "Host" }
  /**
   * AGA-004: for a deployment embedded in a third-party iframe. `__Host-` is
   * kept (CHIPS recommends it for `Partitioned` cookies) but `SameSite=None;
   * Partitioned` replaces `Strict`, which makes the CSRF double-submit
   * middleware the only cross-site defence — it is mandatory for cookie auth
   * regardless (BEH-EA-073–078).
   */
  | { readonly _tag: "HostEmbedded" }
  /**
   * A multi-subdomain app: `__Secure-session` with a `Domain`, since the
   * `__Host-` prefix forbids one. `sameSite` is required, not defaulted — the
   * caller states the cross-site trade-off.
   */
  | {
      readonly _tag: "SecureDomain";
      readonly domain: string;
      readonly sameSite: "strict" | "lax" | "none";
    };

export const Host: Mode = { _tag: "Host" };
export const HostEmbedded: Mode = { _tag: "HostEmbedded" };
export const SecureDomain = (options: {
  readonly domain: string;
  readonly sameSite: "strict" | "lax" | "none";
}): Mode => ({ _tag: "SecureDomain", domain: options.domain, sameSite: options.sameSite });

export interface SessionCookieConfigShape {
  readonly mode: Mode;
  /**
   * BO-005: `absolute` (default) gives the cookie a `Max-Age` equal to the
   * session's remaining absolute lifetime, recomputed at every issuance and
   * rotation, so closing the browser does not log a user out of a 30-day
   * session; `browserSession` omits it (a session cookie).
   */
  readonly persistence: "absolute" | "browserSession";
}

const defaultConfig: SessionCookieConfigShape = { mode: Host, persistence: "absolute" };

/** BEH-EA-017's `Context.Reference`-with-default pattern: the secure default is byte-for-byte today's attribute set (plus `Max-Age`). */
export const SessionCookieConfig: Context.Reference<SessionCookieConfigShape> = Context.Reference(
  "awthaq/core/SessionCookieConfig",
  { defaultValue: () => defaultConfig },
);

export const config = (partial: Partial<SessionCookieConfigShape>): Layer.Layer<never> =>
  Layer.succeed(SessionCookieConfig, { ...defaultConfig, ...partial });

/** The name every reader (Authentication, SubjectExtractor, adapters) must use for this config. */
export const cookieName = (cfg: SessionCookieConfigShape): string =>
  cfg.mode._tag === "SecureDomain" ? "__Secure-session" : Api.SESSION_COOKIE_NAME;

export interface CookieOptions {
  readonly secure: true;
  readonly httpOnly: true;
  readonly path: "/";
  readonly sameSite: "strict" | "lax" | "none";
  readonly partitioned?: true;
  readonly domain?: string;
  readonly maxAge?: Duration.Duration;
}

export interface RenderedCookie {
  readonly name: string;
  readonly value: string;
  readonly options: CookieOptions;
}

/** The mode-derived attributes shared by set and expire (no lifetime). */
const baseOptions = (cfg: SessionCookieConfigShape): CookieOptions => {
  switch (cfg.mode._tag) {
    case "Host":
      return { secure: true, httpOnly: true, path: "/", sameSite: "strict" };
    case "HostEmbedded":
      return { secure: true, httpOnly: true, path: "/", sameSite: "none", partitioned: true };
    case "SecureDomain":
      return {
        secure: true,
        httpOnly: true,
        path: "/",
        sameSite: cfg.mode.sameSite,
        domain: cfg.mode.domain,
      };
  }
};

/**
 * Pure: the cookie a session write carries. `Max-Age` is the session's
 * remaining absolute lifetime (never negative) when `persistence` is
 * `absolute`.
 */
export const renderAt = (
  cfg: SessionCookieConfigShape,
  token: string,
  absoluteExpiresAt: DateTime.Utc,
  now: DateTime.Utc,
): RenderedCookie => {
  const base = baseOptions(cfg);
  const remaining = DateTime.toEpochMillis(absoluteExpiresAt) - DateTime.toEpochMillis(now);
  return {
    name: cookieName(cfg),
    value: token,
    options:
      cfg.persistence === "absolute"
        ? { ...base, maxAge: Duration.millis(Math.max(0, remaining)) }
        : base,
  };
};

/** Renders under the ambient `SessionCookieConfig` and the current clock. */
export const render = (
  session: { readonly absoluteExpiresAt: DateTime.Utc },
  token: Redacted.Redacted<string>,
) =>
  Effect.gen(function* () {
    const cfg = yield* SessionCookieConfig;
    const now = yield* DateTime.now;
    return renderAt(cfg, Redacted.value(token), session.absoluteExpiresAt, now);
  });

/**
 * Registers the session cookie on whatever response this request ends with
 * (success or typed error), the way `HttpApiBuilder.securitySetCookie` does —
 * the one call every issuing handler makes. An unencodable cookie is a
 * defect: the name, attributes and token are all this library's own.
 */
export const set = (
  session: { readonly absoluteExpiresAt: DateTime.Utc },
  token: Redacted.Redacted<string>,
) =>
  render(session, token).pipe(
    Effect.flatMap((cookie) =>
      HttpEffect.appendPreResponseHandler((_request, response) =>
        HttpServerResponse.setCookie(response, cookie.name, cookie.value, cookie.options).pipe(
          Effect.orDie,
        ),
      ),
    ),
  );

/**
 * CSS-002: expires the session cookie on the response — same name, `Path`,
 * `Domain`, `Secure` and `SameSite` as the write (a mismatch and the browser
 * keeps the cookie). Best-effort: an encoding failure leaves the response as
 * it was, since expiry is hygiene and must never fail the request that
 * triggered it.
 */
export const expire = Effect.gen(function* () {
  const cfg = yield* SessionCookieConfig;
  yield* HttpEffect.appendPreResponseHandler((_request, response) =>
    HttpServerResponse.expireCookie(response, cookieName(cfg), baseOptions(cfg)).pipe(
      Effect.catch(() => Effect.succeed(response)),
    ),
  );
});

/**
 * AGA-004: the CSRF cookie's cross-site attributes follow the session
 * cookie's mode — an embedded (`SameSite=None`) session cookie is useless if
 * the double-submit cookie cannot be sent in the same embedded context.
 */
export const csrfCookieOptions = (
  cfg: SessionCookieConfigShape,
): { readonly sameSite: "strict" | "none"; readonly partitioned?: true } =>
  cfg.mode._tag === "HostEmbedded"
    ? { sameSite: "none", partitioned: true }
    : { sameSite: "strict" };
