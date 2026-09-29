// @awthaq/server — SecurityHeaders
//
// PDR-004: an opt-in, global response-header middleware. Nothing in the
// library sends HSTS, `X-Content-Type-Options`, or clickjacking protection on
// its own — those are deployment-level concerns an edge/CDN usually owns — so
// this is a `Layer` an application merges in when it *is* the edge (see the
// README's "Deployment checklist"). The OAuth authorize/callback responses
// set their own `Referrer-Policy: no-referrer` regardless (their URLs carry
// the provider's `code`/`state`); this middleware never overrides a header a
// handler already set.

import * as Effect from "effect/Effect";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/** Each header is a value to send, or `false` to omit it (e.g. when the edge already sets it). */
export interface SecurityHeadersOptions {
  /** Default `max-age=31536000; includeSubDomains`. Only meaningful (and only honored) over HTTPS. */
  readonly strictTransportSecurity?: string | false;
  /** Default `nosniff`. */
  readonly contentTypeOptions?: string | false;
  /** Default `strict-origin-when-cross-origin`; a handler-set value (OAuth's `no-referrer`) wins. */
  readonly referrerPolicy?: string | false;
  /** Default `DENY`. Legacy counterpart of the CSP `frame-ancestors` below. */
  readonly frameOptions?: string | false;
  /** Default `frame-ancestors 'none'`: auth pages must never be framed. */
  readonly contentSecurityPolicy?: string | false;
}

const defaults = {
  strictTransportSecurity: "max-age=31536000; includeSubDomains",
  contentTypeOptions: "nosniff",
  referrerPolicy: "strict-origin-when-cross-origin",
  frameOptions: "DENY",
  contentSecurityPolicy: "frame-ancestors 'none'",
};

/** The `[header, value]` pairs `options` resolves to, with omitted (`false`) ones dropped. */
export const resolveHeaders = (
  options: SecurityHeadersOptions = {},
): ReadonlyArray<readonly [string, string]> => {
  const pairs: ReadonlyArray<readonly [string, string | false]> = [
    [
      "strict-transport-security",
      options.strictTransportSecurity ?? defaults.strictTransportSecurity,
    ],
    ["x-content-type-options", options.contentTypeOptions ?? defaults.contentTypeOptions],
    ["referrer-policy", options.referrerPolicy ?? defaults.referrerPolicy],
    ["x-frame-options", options.frameOptions ?? defaults.frameOptions],
    ["content-security-policy", options.contentSecurityPolicy ?? defaults.contentSecurityPolicy],
  ];
  const resolved: Array<readonly [string, string]> = [];
  for (const [name, value] of pairs) {
    if (value !== false) resolved.push([name, value]);
  }
  return resolved;
};

/**
 * A global `HttpRouter` middleware layer that adds the configured security
 * headers to every response, leaving any header a handler already set alone.
 */
export const layer = (options: SecurityHeadersOptions = {}) => {
  const headers = resolveHeaders(options);
  return HttpRouter.middleware(
    (httpEffect) =>
      Effect.map(httpEffect, (response) =>
        headers.reduce(
          (current, [name, value]) =>
            Headers.has(current.headers, name)
              ? current
              : HttpServerResponse.setHeader(current, name, value),
          response,
        ),
      ),
    { global: true },
  );
};
