// What a host owns, for `AuthHost`'s suites (plan 15): the ports and the HTTP platform. Everything else (records,
// hook points, core services, registries, middleware, migrations) is `AuthHost`'s to derive, so it is not here.
import {
  ClientAddress,
  Encryption,
  KeyProvider,
  Mailer,
  PasswordHasher,
  RateLimiter,
} from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";

const env = (values: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: values }));

/** argon2id at the smallest legal cost (the algorithm and format are the real ones). */
const Hasher = PasswordHasher.layerArgon2id.pipe(
  Layer.provide(env({ AUTH_ARGON2_MEMORY_KIB: "1024", AUTH_ARGON2_ITERATIONS: "1" })),
  Layer.orDie,
);

/** A fixed-key `Encryption`, never a real secret. */
const FixedEncryption = Encryption.layer.pipe(
  Layer.provide(
    KeyProvider.layerEnv.pipe(
      Layer.provide(env({ AWTHAQ_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") })),
    ),
  ),
  Layer.provide(NodeCrypto.layer),
);

/** The platform crypto services (`SecureRandom`, `Digest`, `Mac`, ...). */
export const Crypto = NodeCrypto.layer;

/** The ports: a cheap real hasher, a capturing mailer, a permissive limiter, the socket peer, a fixed key, crypto. */
export const Ports = Layer.mergeAll(
  Hasher,
  Mailer.layerMemory,
  RateLimiter.layerPermissive,
  ClientAddress.layerDirect,
  FixedEncryption,
).pipe(Layer.provideMerge(Crypto));

/** The platform services `HttpRouter.toWebHandler` would otherwise not have: the router and its file/etag helpers. */
export const Platform = Layer.mergeAll(HttpServer.layerServices, HttpRouter.layer);
