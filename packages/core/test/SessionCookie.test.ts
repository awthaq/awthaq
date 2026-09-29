// spec/behaviors/07-sessions.md, BEH-EA-055 (IC-007/AGA-004/BO-005).
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as SessionCookie from "../src/SessionCookie.ts";

const now = DateTime.makeUnsafe(1_000_000);
const in30Days = DateTime.addDuration(now, Duration.days(30));
const defaults = { mode: SessionCookie.Host, persistence: "absolute" } as const;

describe("SessionCookie.renderAt", () => {
  it("BEH-EA-055: the default renders exactly __Host-session; Secure; HttpOnly; SameSite=Strict; Path=/ plus Max-Age from absoluteExpiresAt", () => {
    const cookie = SessionCookie.renderAt(defaults, "id.secret", in30Days, now);
    assert.strictEqual(cookie.name, "__Host-session");
    assert.strictEqual(cookie.value, "id.secret");
    assert.deepStrictEqual(cookie.options, {
      secure: true,
      httpOnly: true,
      path: "/",
      sameSite: "strict",
      maxAge: Duration.days(30),
    });
    assert.notProperty(cookie.options, "domain");
    assert.notProperty(cookie.options, "partitioned");
  });

  it("BO-005: Max-Age shrinks toward the absolute expiry (recomputed at every write) and is never negative", () => {
    const later = DateTime.addDuration(now, Duration.days(29));
    assert.deepStrictEqual(
      SessionCookie.renderAt(defaults, "t", in30Days, later).options.maxAge,
      Duration.days(1),
    );
    const pastExpiry = DateTime.addDuration(in30Days, Duration.days(1));
    assert.deepStrictEqual(
      SessionCookie.renderAt(defaults, "t", in30Days, pastExpiry).options.maxAge,
      Duration.zero,
    );
  });

  it("BO-005: browserSession persistence omits Max-Age", () => {
    const cookie = SessionCookie.renderAt(
      { mode: SessionCookie.Host, persistence: "browserSession" },
      "t",
      in30Days,
      now,
    );
    assert.notProperty(cookie.options, "maxAge");
  });

  it("AGA-004: HostEmbedded keeps __Host- and renders SameSite=None; Partitioned", () => {
    const cookie = SessionCookie.renderAt(
      { mode: SessionCookie.HostEmbedded, persistence: "absolute" },
      "t",
      in30Days,
      now,
    );
    assert.strictEqual(cookie.name, "__Host-session");
    assert.strictEqual(cookie.options.sameSite, "none");
    assert.strictEqual(cookie.options.partitioned, true);
    assert.isTrue(cookie.options.secure);
    assert.notProperty(cookie.options, "domain");
  });

  it("IC-007: SecureDomain renders __Secure-session with the Domain (never __Host- + Domain)", () => {
    const cookie = SessionCookie.renderAt(
      {
        mode: SessionCookie.SecureDomain({ domain: "example.com", sameSite: "lax" }),
        persistence: "absolute",
      },
      "t",
      in30Days,
      now,
    );
    assert.strictEqual(cookie.name, "__Secure-session");
    assert.strictEqual(cookie.options.domain, "example.com");
    assert.strictEqual(cookie.options.sameSite, "lax");
    assert.isTrue(cookie.options.secure);
  });
});

describe("SessionCookie.cookieName / csrfCookieOptions", () => {
  it("only SecureDomain changes the name", () => {
    assert.strictEqual(SessionCookie.cookieName(defaults), "__Host-session");
    assert.strictEqual(
      SessionCookie.cookieName({ mode: SessionCookie.HostEmbedded, persistence: "absolute" }),
      "__Host-session",
    );
    assert.strictEqual(
      SessionCookie.cookieName({
        mode: SessionCookie.SecureDomain({ domain: "example.com", sameSite: "strict" }),
        persistence: "absolute",
      }),
      "__Secure-session",
    );
  });

  it("AGA-004: the CSRF cookie is Partitioned/None only in the embedded mode", () => {
    assert.deepStrictEqual(SessionCookie.csrfCookieOptions(defaults), { sameSite: "strict" });
    assert.deepStrictEqual(
      SessionCookie.csrfCookieOptions({
        mode: SessionCookie.HostEmbedded,
        persistence: "absolute",
      }),
      { sameSite: "none", partitioned: true },
    );
  });

  it("the default config is Host with absolute persistence", () => {
    assert.deepStrictEqual(SessionCookie.SessionCookieConfig.defaultValue(), defaults);
  });
});
