// CSS-004: the cookie helpers read a raw `Set-Cookie` (with `@awthaq/web`'s parser, tested there) and pin its
// attributes on the wire. They are exercised by other packages through the built `lib`, so this suite drives
// `src` directly: every violation message, the `__Host-` rules, and a cookie an agent holds.
import { assert, describe, it } from "@effect/vitest";
import { makeCookieStore } from "@awthaq/web/cookies";
import * as CookieAssertions from "../src/CookieAssertions.ts";

/** The one cookie of a response carrying exactly `raw`. */
const parsed = (raw: string) =>
  CookieAssertions.findSetCookie(responseWith(raw), raw.split("=")[0] ?? "");

const responseWith = (...cookies: ReadonlyArray<string>) => {
  const headers = new Headers();
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { headers });
};

describe("findSetCookie and setCookiesOf", () => {
  it("finds the named cookie among several", () => {
    const response = responseWith("a=1; Path=/", "b=2; Path=/");
    assert.strictEqual(CookieAssertions.setCookiesOf(response).length, 2);
    assert.strictEqual(CookieAssertions.findSetCookie(response, "b").value, "2");
  });

  it("an absent cookie throws, listing the names it did find", () => {
    assert.throws(
      () => CookieAssertions.findSetCookie(responseWith("a=1"), "missing"),
      'expected a Set-Cookie for "missing", got [a]',
    );
  });
});

describe("assertHostPrefixedCookie", () => {
  const good = parsed("__Host-session=x; Path=/; Secure; HttpOnly; SameSite=Lax");

  it("passes a conforming cookie", () => {
    CookieAssertions.assertHostPrefixedCookie(good, { httpOnly: true, sameSite: "lax" });
  });

  it("names every violated rule at once", () => {
    const bad = parsed("session=x; Path=/a; Domain=example.com");
    assert.throws(
      () => CookieAssertions.assertHostPrefixedCookie(bad, { httpOnly: true, sameSite: "none" }),
      /lacks __Host-.*missing Secure.*Path is \/a, must be \/.*Domain=example\.com must be absent.*HttpOnly is false, expected true.*SameSite is absent, expected none/,
    );
  });

  it("a cookie with no Path reads as absent", () => {
    const noPath = parsed("__Host-a=x; Secure");
    assert.throws(
      () => CookieAssertions.assertHostPrefixedCookie(noPath, { httpOnly: false, sameSite: "lax" }),
      /Path is absent, must be \//,
    );
  });
});

describe("assertHostPrefixedCookie over a cookie an agent holds", () => {
  it("reads a host-only stored cookie as having no Domain", () => {
    const store = makeCookieStore({ policy: "trusted", now: () => 0 });
    const internal = new URL("http://internal/");
    store.receive(internal, "__Host-session=x; Path=/; Secure; HttpOnly; SameSite=Strict");
    store.receive(
      internal,
      "__Host-wide=x; Path=/; Secure; HttpOnly; SameSite=Strict; Domain=example.com",
    );
    const held = store.get("__Host-session");
    const wide = store.get("__Host-wide");
    assert.isDefined(held);
    assert.isDefined(wide);
    if (held === undefined || wide === undefined) return;
    CookieAssertions.assertHostPrefixedCookie(held, { httpOnly: true, sameSite: "strict" });
    assert.throws(
      () => CookieAssertions.assertHostPrefixedCookie(wide, { httpOnly: true, sameSite: "strict" }),
      /Domain=example\.com must be absent/,
    );
  });
});

describe("assertExpiredCookie", () => {
  it("passes a Max-Age=0 directive and refuses anything else", () => {
    CookieAssertions.assertExpiredCookie(parsed("a=; Max-Age=0"));
    assert.throws(
      () => CookieAssertions.assertExpiredCookie(parsed("a=1; Max-Age=60")),
      'cookie "a" should expire (Max-Age=0), got 60',
    );
    assert.throws(() => CookieAssertions.assertExpiredCookie(parsed("a=1")), "got undefined");
  });
});
