// CWM-004/SFS-003: the SSRF floor for administrator-supplied URLs (OutboundUrl) and its
// resolution half (HostResolver.refusal).
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HostResolver from "../src/HostResolver.ts";
import * as OutboundUrl from "../src/OutboundUrl.ts";

const refused = (value: string, options?: OutboundUrl.OutboundUrlOptions) =>
  Option.isSome(OutboundUrl.problem("url", value, options));

describe("OutboundUrl.problem", () => {
  it("accepts an https URL on a public host, with a port and path", () => {
    assert.isFalse(refused("https://hooks.example.com/awthaq"));
    assert.isFalse(refused("https://hooks.example.com:8443/a?b=c"));
    assert.isFalse(refused("https://93.184.216.34/hook"));
    assert.isFalse(refused("https://[2606:2800:220:1:248:1893:25c8:1946]/hook"));
  });

  it("refuses non-https, credentials, and non-URLs", () => {
    assert.isTrue(refused("http://hooks.example.com/"));
    assert.isTrue(refused("https://user:pass@hooks.example.com/"));
    assert.isTrue(refused("ftp://hooks.example.com/"));
    assert.isTrue(refused("hooks.example.com"));
    assert.isTrue(refused("javascript:alert(1)"));
  });

  it("refuses localhost and internal names, and single-label hosts", () => {
    for (const host of [
      "localhost",
      "a.localhost",
      "db.internal",
      "printer.local",
      "x.home.arpa",
      "intranet",
    ]) {
      assert.isTrue(refused(`https://${host}/`), host);
    }
  });

  it("refuses private, loopback, link-local and reserved IPv4 literals, in every spelling the parser accepts", () => {
    for (const host of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1",
      "0.0.0.0",
      "255.255.255.255",
      "224.0.0.1",
      "198.18.0.1",
      "2130706433", // decimal 127.0.0.1
      "0x7f.1", // hex + short form
      "017700000001", // octal
    ]) {
      assert.isTrue(refused(`https://${host}/`), host);
    }
    // The edges of the private ranges are public.
    assert.isFalse(refused("https://172.15.0.1/"));
    assert.isFalse(refused("https://172.32.0.1/"));
    assert.isFalse(refused("https://100.63.0.1/"));
  });

  it("refuses private, loopback, mapped and embedded IPv6 literals", () => {
    for (const host of [
      "[::1]",
      "[::]",
      "[fc00::1]",
      "[fd12:3456::1]",
      "[fe80::1]",
      "[ff02::1]",
      "[::ffff:127.0.0.1]", // IPv4-mapped loopback
      "[::ffff:7f00:1]",
      "[::ffff:a00:1]", // IPv4-mapped 10.0.0.1
      "[::ffff:169.254.169.254]",
      "[64:ff9b::a00:1]", // NAT64 to 10.0.0.1
      "[2001:db8::1]",
    ]) {
      assert.isTrue(refused(`https://${host}/`), host);
    }
    assert.isFalse(refused("https://[::ffff:8.8.8.8]/"));
  });

  it("does not mistake a host NAME that starts like an IPv6 prefix for an address", () => {
    // `startsWith("fc")` is not a unique-local test for a hostname (a corrected false positive).
    assert.isFalse(refused("https://fcm.example.com/"));
    assert.isFalse(refused("https://fd.example.com/"));
    assert.isFalse(refused("https://fe80.example.com/"));
  });

  it("allowPrivate (development) lifts the host and scheme rules but never the credentials rule", () => {
    assert.isFalse(refused("http://localhost:3000/hook", { allowPrivate: true }));
    assert.isFalse(refused("https://10.0.0.5/hook", { allowPrivate: true }));
    assert.isTrue(refused("http://user:pw@localhost/", { allowPrivate: true }));
    assert.isTrue(refused("ftp://localhost/", { allowPrivate: true }));
  });
});

describe("HostResolver.refusal", () => {
  const withTable = (table: Record<string, ReadonlyArray<string>>) =>
    Effect.provide(HostResolver.layerStatic(table));

  it.effect("accepts a name whose every address is public", () =>
    Effect.gen(function* () {
      const result = yield* HostResolver.refusal("https://hooks.example.com/x");
      assert.isTrue(Option.isNone(result));
    }).pipe(withTable({ "hooks.example.com": ["93.184.216.34", "2606:2800:220:1::1"] })),
  );

  it.effect("refuses a public-looking name that resolves to a private address", () =>
    Effect.gen(function* () {
      const result = yield* HostResolver.refusal("https://rebind.example.com/x");
      assert.isTrue(Option.isSome(result));
    }).pipe(withTable({ "rebind.example.com": ["169.254.169.254"] })),
  );

  it.effect("refuses when ANY of several answers is private", () =>
    Effect.gen(function* () {
      const result = yield* HostResolver.refusal("https://mixed.example.com/x");
      assert.isTrue(Option.isSome(result));
    }).pipe(withTable({ "mixed.example.com": ["93.184.216.34", "10.0.0.7"] })),
  );

  it.effect("refuses a name that does not resolve, and never assumes public", () =>
    Effect.gen(function* () {
      const result = yield* HostResolver.refusal("https://nx.example.com/x");
      assert.isTrue(Option.isSome(result));
    }).pipe(withTable({})),
  );

  it.effect("judges an IP literal as written, without a lookup", () =>
    Effect.gen(function* () {
      assert.isTrue(Option.isSome(yield* HostResolver.refusal("https://10.0.0.1/x")));
      assert.isTrue(Option.isNone(yield* HostResolver.refusal("https://93.184.216.34/x")));
    }).pipe(withTable({})),
  );
});
