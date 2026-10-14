// CSS-004: the cookie helpers parse a raw `Set-Cookie` and pin its attributes on the wire. They are exercised
// by other packages through the built `lib`, so this suite drives `src` directly: every attribute, every
// violation message, and the `__Host-` rules.
import { assert, describe, it } from "@effect/vitest";
import * as CookieAssertions from "../src/CookieAssertions.ts";

const responseWith = (...cookies: ReadonlyArray<string>) => {
  const headers = new Headers();
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { headers });
};

describe("parseSetCookie", () => {
  it("reads the name, the value and every attribute", () => {
    const parsed = CookieAssertions.parseSetCookie(
      "__Host-session=abc=def; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=60; Domain=example.com",
    );
    assert.deepStrictEqual(parsed, {
      name: "__Host-session",
      value: "abc=def",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      domain: "example.com",
      maxAge: 60,
    });
  });

  it("a bare pair has no attributes, and a pair without `=` is a name with an empty value", () => {
    assert.deepStrictEqual(CookieAssertions.parseSetCookie("a=b"), {
      name: "a",
      value: "b",
      secure: false,
      httpOnly: false,
      sameSite: undefined,
      path: undefined,
      domain: undefined,
      maxAge: undefined,
    });
    const bare = CookieAssertions.parseSetCookie("flag");
    assert.strictEqual(bare.name, "flag");
    assert.strictEqual(bare.value, "");
  });
});

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
  const good = CookieAssertions.parseSetCookie(
    "__Host-session=x; Path=/; Secure; HttpOnly; SameSite=Lax",
  );

  it("passes a conforming cookie", () => {
    CookieAssertions.assertHostPrefixedCookie(good, { httpOnly: true, sameSite: "lax" });
  });

  it("names every violated rule at once", () => {
    const bad = CookieAssertions.parseSetCookie("session=x; Path=/a; Domain=example.com");
    assert.throws(
      () => CookieAssertions.assertHostPrefixedCookie(bad, { httpOnly: true, sameSite: "none" }),
      /lacks __Host-.*missing Secure.*Path is \/a, must be \/.*Domain=example\.com must be absent.*HttpOnly is false, expected true.*SameSite is absent, expected none/,
    );
  });

  it("a cookie with no Path reads as absent", () => {
    const noPath = CookieAssertions.parseSetCookie("__Host-a=x; Secure");
    assert.throws(
      () => CookieAssertions.assertHostPrefixedCookie(noPath, { httpOnly: false, sameSite: "lax" }),
      /Path is absent, must be \//,
    );
  });
});

describe("assertExpiredCookie", () => {
  it("passes a Max-Age=0 directive and refuses anything else", () => {
    CookieAssertions.assertExpiredCookie(CookieAssertions.parseSetCookie("a=; Max-Age=0"));
    assert.throws(
      () =>
        CookieAssertions.assertExpiredCookie(CookieAssertions.parseSetCookie("a=1; Max-Age=60")),
      'cookie "a" should expire (Max-Age=0), got 60',
    );
    assert.throws(
      () => CookieAssertions.assertExpiredCookie(CookieAssertions.parseSetCookie("a=1")),
      "got undefined",
    );
  });
});
