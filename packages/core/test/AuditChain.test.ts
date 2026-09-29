// ALF-005: the shared tamper-evidence primitive `@awthaq/admin`'s impersonation
// ledger (and, later, `AuditLog`) chains its rows with.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as AuditChain from "../src/AuditChain.ts";

// `Layer.fresh`: layers are memoized by reference within one memo map, so the nested
// `Effect.provide`s below would otherwise all share the first-built (unkeyed) instance.
const Unkeyed = Layer.fresh(AuditChain.layer).pipe(Layer.provide(NodeCrypto.layer));
const Keyed = (key: string) =>
  Layer.fresh(AuditChain.layer).pipe(
    Layer.provide(AuditChain.config({ key: Redacted.make(key) })),
    Layer.provide(NodeCrypto.layer),
  );

/** Builds a valid chain of `payloads`, returning the links exactly as a store would hold them. */
const buildChain = (chain: AuditChain.AuditChainShape, payloads: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const links: Array<AuditChain.ChainLink> = [];
    let prevHash = AuditChain.GENESIS_HASH;
    for (const payload of payloads) {
      const rowHash = yield* chain.link(prevHash, payload);
      links.push({ prevHash, payload, rowHash });
      prevHash = rowHash;
    }
    return links;
  });

describe("AuditChain", () => {
  it.effect("canonicalize is an unambiguous, ordered encoding", () =>
    Effect.sync(() => {
      assert.notStrictEqual(
        AuditChain.canonicalize(["a", "bc"]),
        AuditChain.canonicalize(["ab", "c"]),
      );
      assert.notStrictEqual(AuditChain.canonicalize([null]), AuditChain.canonicalize([""]));
    }),
  );

  it.effect("link is deterministic and depends on prevHash, payload and the key", () =>
    Effect.gen(function* () {
      const chain = yield* AuditChain.AuditChain;
      const a = yield* chain.link(AuditChain.GENESIS_HASH, "payload");
      assert.strictEqual(a, yield* chain.link(AuditChain.GENESIS_HASH, "payload"));
      assert.notStrictEqual(a, yield* chain.link(AuditChain.GENESIS_HASH, "payload2"));
      assert.notStrictEqual(a, yield* chain.link("1".repeat(64), "payload"));
      assert.match(a, /^[0-9a-f]{64}$/);

      const keyed = yield* Effect.provide(
        Effect.flatMap(AuditChain.AuditChain, (c) => c.link(AuditChain.GENESIS_HASH, "payload")),
        Keyed("k1"),
      );
      assert.notStrictEqual(a, keyed);
      const otherKey = yield* Effect.provide(
        Effect.flatMap(AuditChain.AuditChain, (c) => c.link(AuditChain.GENESIS_HASH, "payload")),
        Keyed("k2"),
      );
      assert.notStrictEqual(keyed, otherKey);
    }).pipe(Effect.provide(Unkeyed)),
  );

  it.effect("verify accepts an intact chain and reports the first broken link", () =>
    Effect.gen(function* () {
      const chain = yield* AuditChain.AuditChain;
      const links = yield* buildChain(chain, ["one", "two", "three", "four"]);
      assert.isTrue(Option.isNone(yield* chain.verify(links)));
      assert.isTrue(Option.isNone(yield* chain.verify([])));

      // A rewritten payload breaks the link it sits on.
      const rewritten = links.map((link, i) => (i === 1 ? { ...link, payload: "forged" } : link));
      assert.deepStrictEqual(yield* chain.verify(rewritten), Option.some(1));

      // A deleted middle link breaks the one after it (its prevHash no longer matches).
      const removed = [links[0]!, links[2]!, links[3]!];
      assert.deepStrictEqual(yield* chain.verify(removed), Option.some(1));

      // A forger who recomputes a rewritten row's own hash still breaks the next link.
      const recomputed = yield* chain.link(links[1]!.prevHash, "forged");
      const forged = links.map((link, i) =>
        i === 1 ? { ...link, payload: "forged", rowHash: recomputed } : link,
      );
      assert.deepStrictEqual(yield* chain.verify(forged), Option.some(2));

      // A chain must start at the genesis hash.
      assert.deepStrictEqual(yield* chain.verify(links.slice(1)), Option.some(0));
    }).pipe(Effect.provide(Unkeyed)),
  );

  it.effect("a keyed chain cannot be recomputed by someone without the key", () =>
    Effect.gen(function* () {
      const chain = yield* AuditChain.AuditChain;
      const links = yield* buildChain(chain, ["one", "two"]);
      assert.isTrue(Option.isNone(yield* chain.verify(links)));
      // Same payloads chained with a different key do not verify under this key.
      const foreign = yield* Effect.provide(
        Effect.flatMap(AuditChain.AuditChain, (c) => buildChain(c, ["one", "two"])),
        Keyed("attacker-key"),
      );
      assert.deepStrictEqual(yield* chain.verify(foreign), Option.some(0));
    }).pipe(Effect.provide(Keyed("real-key"))),
  );
});
