// @awthaq/test — TestEncryption
//
// Plan 02 (ADR-EA-041): `Persistence.sql()` requires `Encryption` (the accounts repository seals a
// federated provider's tokens at rest), so every SQL composition in a test needs one. This is the one a
// test uses: a fixed key, read through a `ConfigProvider` rather than the process environment, so the
// real `process.env` can neither leak in nor be touched.

import { Encryption, KeyProvider } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Layer from "effect/Layer";

/** A fixed-key `Encryption`: stable across runs, never a real secret. */
export const layer = Encryption.layer.pipe(
  Layer.provide(
    KeyProvider.layerEnv.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { AWTHAQ_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") },
          }),
        ),
      ),
    ),
  ),
  Layer.provide(NodeCrypto.layer),
);
