// Test support (plan 05): an `Encryption` whose current key a test can rotate or retire, so the
// re-seal paths of `SealedColumn` run against a real key change.
import { Encryption, KeyProvider } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export const rotatingKeys = (initial = "k1") => {
  let current = initial;
  const retired = new Set<string>();
  const material = (kid: string): KeyProvider.KeyMaterial => ({
    kid,
    key: Redacted.make(new Uint8Array(32).fill(kid.charCodeAt(kid.length - 1) % 251)),
  });
  const provider = KeyProvider.KeyProvider.of({
    currentKey: Effect.sync(() => material(current)),
    getKey: (kid) =>
      retired.has(kid)
        ? Effect.fail(new KeyProvider.UnknownKeyId({ kid }))
        : Effect.succeed(material(kid)),
  });
  return {
    /** The key new ciphertext is written under from now on. */
    rotateTo: (kid: string) => {
      current = kid;
    },
    /** The key can no longer be fetched: envelopes under it fail `UnknownKeyId`. */
    retire: (kid: string) => {
      retired.add(kid);
    },
    layer: Encryption.layer.pipe(
      Layer.provide(Layer.succeed(KeyProvider.KeyProvider, provider)),
      Layer.provide(NodeCrypto.layer),
    ),
  };
};
