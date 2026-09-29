// See src/ClientAddress.ts's own header comment for what this port is
// grounded in — AGA-001/NHS-003's trusted-proxy-aware client-IP design.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as ClientAddress from "../src/ClientAddress.ts";

const requestWith = (options: {
  readonly headers?: Record<string, string>;
  readonly remoteAddress?: string;
}): HttpServerRequest.HttpServerRequest =>
  HttpServerRequest.fromWeb(
    new Request("http://localhost/whatever", { headers: options.headers ?? {} }),
  ).modify({
    remoteAddress:
      options.remoteAddress === undefined ? Option.none() : Option.some(options.remoteAddress),
  });

describe("ClientAddress.layerDirect", () => {
  it.effect("resolves to the raw remoteAddress, untouched", () =>
    Effect.gen(function* () {
      const clientAddress = yield* ClientAddress.ClientAddress;
      const resolved = yield* clientAddress.resolve(
        requestWith({
          remoteAddress: "203.0.113.9",
          headers: { "x-forwarded-for": "9.9.9.9" },
        }),
      );
      assert.deepStrictEqual(resolved, Option.some("203.0.113.9"));
    }).pipe(Effect.provide(ClientAddress.layerDirect)),
  );

  it.effect("resolves to None when the request carries no remoteAddress", () =>
    Effect.gen(function* () {
      const clientAddress = yield* ClientAddress.ClientAddress;
      const resolved = yield* clientAddress.resolve(requestWith({}));
      assert.deepStrictEqual(resolved, Option.none());
    }).pipe(Effect.provide(ClientAddress.layerDirect)),
  );
});

describe("ClientAddress.layerTrustedProxy — X-Forwarded-For, hopCount", () => {
  const layer = ClientAddress.layerTrustedProxy({ strategy: { _tag: "hopCount", count: 1 } });

  it.effect("strips exactly hopCount trusted hops from the right, returns the next one inward", () =>
    Effect.gen(function* () {
      const clientAddress = yield* ClientAddress.ClientAddress;
      // client, then our one trusted edge proxy.
      const resolved = yield* clientAddress.resolve(
        requestWith({
          remoteAddress: "10.0.0.1",
          headers: { "x-forwarded-for": "198.51.100.7, 10.0.0.1" },
        }),
      );
      assert.deepStrictEqual(resolved, Option.some("198.51.100.7"));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("falls back to remoteAddress when the header is absent", () =>
    Effect.gen(function* () {
      const clientAddress = yield* ClientAddress.ClientAddress;
      const resolved = yield* clientAddress.resolve(requestWith({ remoteAddress: "10.0.0.1" }));
      assert.deepStrictEqual(resolved, Option.some("10.0.0.1"));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("falls back to remoteAddress when the header has fewer hops than hopCount trusts", () =>
    Effect.gen(function* () {
      const clientAddress = yield* ClientAddress.ClientAddress;
      const resolved = yield* clientAddress.resolve(
        requestWith({
          remoteAddress: "10.0.0.1",
          headers: { "x-forwarded-for": "10.0.0.1" },
        }),
      );
      assert.deepStrictEqual(resolved, Option.some("10.0.0.1"));
    }).pipe(Effect.provide(layer)),
  );
});

describe("ClientAddress.layerTrustedProxy — X-Forwarded-For, CIDR allowlist", () => {
  const layer = ClientAddress.layerTrustedProxy({
    strategy: { _tag: "cidr", trusted: ["10.0.0.0/8"] },
  });

  it.effect("walks right-to-left past every hop inside the trusted range", () =>
    Effect.gen(function* () {
      const clientAddress = yield* ClientAddress.ClientAddress;
      const resolved = yield* clientAddress.resolve(
        requestWith({
          remoteAddress: "10.0.0.1",
          headers: { "x-forwarded-for": "198.51.100.7, 10.0.0.5, 10.0.0.1" },
        }),
      );
      assert.deepStrictEqual(resolved, Option.some("198.51.100.7"));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a spoofed hop outside the trusted range stops the walk there", () =>
    Effect.gen(function* () {
      const clientAddress = yield* ClientAddress.ClientAddress;
      // An attacker directly behind our one real trusted proxy (10.0.0.1)
      // can prepend anything to X-Forwarded-For — the walk must stop at
      // the first untrusted hop from the right, not skip past it.
      const resolved = yield* clientAddress.resolve(
        requestWith({
          remoteAddress: "10.0.0.1",
          headers: { "x-forwarded-for": "198.51.100.7, 203.0.113.66, 10.0.0.1" },
        }),
      );
      assert.deepStrictEqual(resolved, Option.some("203.0.113.66"));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("falls back to remoteAddress when every hop is inside the trusted range", () =>
    Effect.gen(function* () {
      const clientAddress = yield* ClientAddress.ClientAddress;
      const resolved = yield* clientAddress.resolve(
        requestWith({
          remoteAddress: "10.0.0.1",
          headers: { "x-forwarded-for": "10.0.0.9, 10.0.0.5, 10.0.0.1" },
        }),
      );
      assert.deepStrictEqual(resolved, Option.some("10.0.0.1"));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("supports IPv6 CIDR ranges too", () =>
    Effect.gen(function* () {
      const clientAddress = yield* ClientAddress.ClientAddress;
      const resolved = yield* clientAddress.resolve(
        requestWith({
          remoteAddress: "2001:db8:1::1",
          headers: { "x-forwarded-for": "2001:db8:2::9, 2001:db8:1::1" },
        }),
      );
      assert.deepStrictEqual(resolved, Option.some("2001:db8:2::9"));
    }).pipe(
      Effect.provide(
        ClientAddress.layerTrustedProxy({ strategy: { _tag: "cidr", trusted: ["2001:db8:1::/48"] } }),
      ),
    ),
  );

  // Prefix lengths that are not a multiple of 16 split a 16-bit group: /33
  // keeps the first bit of the third group, so 2001:db8:8000:: is outside
  // 2001:db8::/33 while 2001:db8:7fff:: is inside it.
  it.effect("honours IPv6 prefixes that fall inside a 16-bit group", () =>
    Effect.gen(function* () {
      const clientAddress = yield* ClientAddress.ClientAddress;
      const resolved = yield* clientAddress.resolve(
        requestWith({
          remoteAddress: "2001:db8:7fff::1",
          headers: { "x-forwarded-for": "2001:db8:8000::1, 2001:db8:7fff::1" },
        }),
      );
      assert.deepStrictEqual(resolved, Option.some("2001:db8:8000::1"));
    }).pipe(
      Effect.provide(ClientAddress.layerTrustedProxy({ strategy: { _tag: "cidr", trusted: ["2001:db8::/33"] } })),
    ),
  );
});

describe("ClientAddress.layerTrustedProxy — Forwarded header", () => {
  const layer = ClientAddress.layerTrustedProxy({
    strategy: { _tag: "hopCount", count: 1 },
    header: "forwarded",
  });

  it.effect("parses the for= parameter of each hop", () =>
    Effect.gen(function* () {
      const clientAddress = yield* ClientAddress.ClientAddress;
      const resolved = yield* clientAddress.resolve(
        requestWith({
          remoteAddress: "10.0.0.1",
          headers: { forwarded: "for=198.51.100.7, for=10.0.0.1" },
        }),
      );
      assert.deepStrictEqual(resolved, Option.some("198.51.100.7"));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("strips a quoted, bracketed IPv6 literal's port", () =>
    Effect.gen(function* () {
      const clientAddress = yield* ClientAddress.ClientAddress;
      const resolved = yield* clientAddress.resolve(
        requestWith({
          remoteAddress: "10.0.0.1",
          headers: { forwarded: 'for="[2001:db8::7]:4711", for=10.0.0.1' },
        }),
      );
      assert.deepStrictEqual(resolved, Option.some("2001:db8::7"));
    }).pipe(Effect.provide(layer)),
  );
});
