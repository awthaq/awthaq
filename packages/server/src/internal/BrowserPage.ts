// @awthaq/server — internal BrowserPage
//
// PV-016: the one text/html builder for browser navigations.
import * as HttpServerResponse from "effect/http/HttpServerResponse";

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** An HTML page answered to a navigation: never cached. */
const page = (html: string) =>
  HttpServerResponse.text(html, { contentType: "text/html; charset=utf-8" }).pipe(
    HttpServerResponse.setHeader("cache-control", "no-store"),
  );

/**
 * PV-016: the same-site interstitial. A `SameSite=Strict` session cookie set on the response of a
 * navigation the provider began cross-site is stored, but the browser withholds it from every
 * request in that redirect chain, so the landing page's first request looks signed out. Answering
 * a `200` page instead ends the chain: the browser follows the meta refresh as a fresh navigation
 * initiated by a document of this site, and that request carries the cookie. A meta refresh, not a
 * script, so a strict `script-src` CSP cannot block it; the anchor is the no-refresh fallback.
 */
export const bounce = (location: string) => {
  const target = escapeHtml(location);
  return page(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0;url=${target}"><title>Signing you in</title></head><body><p>Signing you in&hellip; <a href="${target}">Continue</a></p></body></html>`,
  );
};
