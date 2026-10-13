// The signing-key records seal their private half (plan 05), so every composition that uses the in-memory
// records provides an `Encryption`: a real one over a fixed test key, the same mechanism as production.
import { Encryption, KeyProvider } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Layer from "effect/Layer";
import * as SigningKeyRecords from "../src/SigningKeyRecords.ts";

const EncryptionLive = Encryption.layer.pipe(
  Layer.provide(
    KeyProvider.layerEnv.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { AWTHAQ_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") },
          }),
        ),
      ),
    ),
  ),
  Layer.provide(NodeCrypto.layer),
);

/** `SigningKeyRecords.layerMemory` with its `Encryption` provided (it also exposes `MemoryEnvelopes`). */
export const SigningKeyRecordsLive = SigningKeyRecords.layerMemory.pipe(
  Layer.provide(EncryptionLive),
);
