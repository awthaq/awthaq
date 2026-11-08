// spec/behaviors/24-nextjs-ssr.md, BEH-EA-344: the user agent's cookie store, as an RFC 6265bis §5.3–§5.4
// subset. Pure: no handler, a clock the test moves.
import { assert, describe, it } from "@effect/vitest";
import { makeCookieStore, type Outgoing } from "../src/CookieStore.ts";

const store = (policy: "browser" | "trusted" = "browser") => {
  let now = 1_000_000;
  const cookies = makeCookieStore({ policy, now: () => now });
  return {
    ...cookies,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

const at = (url: string, init: Partial<Omit<Outgoing, "url">> = {}): Outgoing => ({
  url: new URL(url),
  method: init.method ?? "GET",
  site: init.site ?? "same-origin",
  navigation: init.navigation ?? false,
});

const origin = new URL("https://app.example.com/");

describe("CookieStore (BEH-EA-344)", () => {
  it("sends a cookie to a matching path and not to a sibling; the default path is the request's directory", () => {
    const cookies = store();
    cookies.receive(origin, "scoped=1; Path=/app");
    assert.strictEqual(cookies.header(at("https://app.example.com/app")), "scoped=1");
    assert.strictEqual(cookies.header(at("https://app.example.com/app/deeper")), "scoped=1");
    assert.isUndefined(cookies.header(at("https://app.example.com/session")));
    assert.isUndefined(cookies.header(at("https://app.example.com/application")));

    cookies.receive(new URL("https://app.example.com/x/y"), "defaulted=1");
    assert.strictEqual(cookies.get("defaulted")?.path, "/x");
    cookies.receive(new URL("https://app.example.com/top"), "top=1");
    assert.strictEqual(cookies.get("top")?.path, "/");
  });

  it("expiry: Max-Age=0 and a past Expires remove, Max-Age wins over Expires, a session cookie never lapses", () => {
    const cookies = store();
    cookies.receive(origin, "a=1");
    assert.deepStrictEqual(cookies.receive(origin, "a=; Max-Age=0"), {
      _tag: "Removed",
      name: "a",
    });
    assert.isUndefined(cookies.get("a"));

    cookies.receive(origin, "b=1");
    cookies.receive(origin, "b=; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    assert.isUndefined(cookies.get("b"));

    // A past Expires beside a live Max-Age: Max-Age wins.
    cookies.receive(origin, "c=1; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    assert.strictEqual(cookies.get("c")?.value, "1");

    cookies.receive(origin, "session=1");
    assert.isUndefined(cookies.get("session")?.expiresAt);

    cookies.advance(61_000);
    assert.isUndefined(cookies.get("c"));
    assert.strictEqual(cookies.header(at("https://app.example.com/")), "session=1");
  });

  it("refuses a `__Host-` cookie with a Domain, a narrowed Path or no Secure, and a `__Secure-` one without Secure", () => {
    const cookies = store();
    const refusal = (header: string) => {
      const received = cookies.receive(origin, header);
      return received._tag === "Refused" ? received.refusal : received._tag;
    };
    assert.strictEqual(refusal("__Host-a=1; Secure; Path=/; Domain=example.com"), "HostPrefix");
    assert.strictEqual(refusal("__Host-b=1; Secure; Path=/a"), "HostPrefix");
    assert.strictEqual(refusal("__Host-c=1; Path=/"), "HostPrefix");
    assert.strictEqual(refusal("__Secure-d=1; Path=/"), "SecurePrefix");
    assert.strictEqual(refusal("__Host-ok=1; Secure; Path=/"), "Stored");
    assert.strictEqual(refusal("__Secure-ok=1; Secure; Domain=example.com"), "Stored");
    assert.deepStrictEqual(
      cookies.all().map((cookie) => cookie.name),
      ["__Host-ok", "__Secure-ok"],
    );
  });

  it("refuses a Secure cookie from an insecure origin; a loopback host and https are secure", () => {
    const cookies = store();
    const insecure = cookies.receive(new URL("http://example.test/"), "s=1; Secure");
    assert.strictEqual(
      insecure._tag === "Refused" ? insecure.refusal : undefined,
      "InsecureOrigin",
    );
    assert.strictEqual(cookies.receive(new URL("http://localhost/"), "s=1; Secure")._tag, "Stored");
    assert.strictEqual(cookies.receive(new URL("http://127.0.0.1/"), "t=1; Secure")._tag, "Stored");
    assert.strictEqual(cookies.receive(origin, "u=1; Secure")._tag, "Stored");
    // ...and a Secure cookie is not sent back over an insecure origin.
    cookies.receive(new URL("http://example.test/"), "plain=1");
    assert.strictEqual(cookies.header(at("http://example.test/")), "plain=1");
  });

  it("refuses SameSite=None without Secure", () => {
    const received = store().receive(origin, "n=1; SameSite=None");
    assert.strictEqual(
      received._tag === "Refused" ? received.refusal : undefined,
      "SameSiteNoneWithoutSecure",
    );
  });

  it("a Domain cookie reaches the domain's subdomains; a mismatched Domain is refused; a host-only cookie stays on its host", () => {
    const cookies = store();
    assert.strictEqual(cookies.receive(origin, "wide=1; Domain=example.com")._tag, "Stored");
    assert.strictEqual(cookies.receive(origin, "narrow=1")._tag, "Stored");
    assert.strictEqual(cookies.header(at("https://api.example.com/")), "wide=1");
    assert.strictEqual(cookies.header(at("https://example.com/")), "wide=1");
    assert.strictEqual(cookies.header(at("https://app.example.com/")), "wide=1; narrow=1");
    assert.isUndefined(cookies.header(at("https://other.test/")));

    const mismatch = cookies.receive(new URL("https://other.test/"), "x=1; Domain=example.com");
    assert.strictEqual(
      mismatch._tag === "Refused" ? mismatch.refusal : undefined,
      "DomainMismatch",
    );
  });

  it("cross-site: Strict is withheld, Lax travels only on a GET navigation, None travels, no SameSite is Lax", () => {
    const cookies = store();
    cookies.receive(origin, "strict=1; Secure; SameSite=Strict");
    cookies.receive(origin, "lax=1; Secure; SameSite=Lax");
    cookies.receive(origin, "none=1; Secure; SameSite=None");
    cookies.receive(origin, "unset=1; Secure");
    const url = "https://app.example.com/landing";
    assert.strictEqual(cookies.header(at(url, { site: "cross-site" })), "none=1");
    assert.strictEqual(
      cookies.header(at(url, { site: "cross-site", navigation: true })),
      "lax=1; none=1; unset=1",
    );
    assert.strictEqual(
      cookies.header(at(url, { site: "cross-site", navigation: true, method: "POST" })),
      "none=1",
    );
    assert.strictEqual(
      cookies.header(at(url, { site: "same-site" })),
      "strict=1; lax=1; none=1; unset=1",
    );
  });

  it("orders longer paths first, then earlier creation; an overwrite keeps its creation time", () => {
    const cookies = store();
    cookies.receive(origin, "first=1; Path=/");
    cookies.advance(1);
    cookies.receive(origin, "deep=1; Path=/app");
    cookies.advance(1);
    cookies.receive(origin, "second=1; Path=/");
    cookies.advance(1);
    cookies.receive(origin, "first=2; Path=/");
    assert.strictEqual(
      cookies.header(at("https://app.example.com/app")),
      "deep=1; first=2; second=1",
    );
  });

  it("scriptVisible omits HttpOnly cookies", () => {
    const cookies = store();
    cookies.receive(origin, "__Host-session=s; Secure; HttpOnly; Path=/");
    cookies.receive(origin, "__Host-csrf=c; Secure; Path=/");
    cookies.receive(origin, "theme=dark");
    assert.strictEqual(cookies.scriptVisible(origin), "__Host-csrf=c; theme=dark");
  });

  it("trusted: a Secure Domain cookie from http://internal is stored and sent; expiry and Path still apply", () => {
    const cookies = store("trusted");
    const internal = new URL("http://internal/");
    assert.strictEqual(
      cookies.receive(internal, "__Secure-session=s; Secure; Domain=example.com; Path=/")._tag,
      "Stored",
    );
    cookies.receive(internal, "scoped=1; Path=/app");
    cookies.receive(internal, "brief=1; Max-Age=1");
    assert.strictEqual(
      cookies.header(at("http://internal/session", { site: "cross-site" })),
      "__Secure-session=s; brief=1",
    );
    cookies.advance(1_000);
    assert.strictEqual(cookies.header(at("http://internal/session")), "__Secure-session=s");
  });

  it("seed stores a Cookie header's values raw, so they round-trip byte for byte", () => {
    const cookies = store("trusted");
    const internal = new URL("http://internal/");
    cookies.seed(internal, "a=x%2By; b=%E2%9C%93; malformed; =nameless");
    assert.strictEqual(cookies.header(at("http://internal/any")), "a=x%2By; b=%E2%9C%93");
    assert.strictEqual(cookies.get("a")?.value, "x%2By");
  });
});
