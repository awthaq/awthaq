// @awthaq/core — AuditChain
//
// ALF-005 (.issues/medium): tamper-evidence for durable audit tables. A DB
// trigger blocks the casual rewrite (`@awthaq/admin`'s migrations add one);
// this is the second layer — each row carries `rowHash = HMAC(key, prevHash ||
// payload)`, so editing, deleting or reordering a row is *detectable* by
// anyone holding the key, including a forger with raw SQL access who
// recomputes the edited row's own hash (the very next link no longer matches).
//
// A primitive, not a store: it knows nothing about tables. `@awthaq/admin`'s
// `ImpersonationRecords` is the first consumer; `AuditLog` (BEH-EA-100) is meant
// to reuse it verbatim — persisting `(prevHash, payload, rowHash)` per row and
// feeding the rows back in order to `verify`.
//
// The key is optional by design: with none configured the chain is an
// unkeyed SHA-256 chain, which still catches accidental or casual edits but can
// be recomputed end to end by someone who reads the algorithm — a host that
// wants forgery-evidence supplies `AuditChain.config({ key })` (a secret held
// outside the database). Detecting the *truncation* of the newest rows needs an
// external anchor (a periodically exported head hash), which this primitive
// deliberately leaves to the host.

import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

/** The `prevHash` of the first link of every chain. */
export const GENESIS_HASH = "0".repeat(64);

export interface AuditChainConfigShape {
  /** Secret the links are HMAC'd with; `None` falls back to unkeyed SHA-256 (see the module header). */
  readonly key: Option.Option<Redacted.Redacted<string>>;
}

/** BEH-EA-017's `Context.Reference`-with-default pattern, like `AdminConfig`. */
export const AuditChainConfig = Context.Reference<AuditChainConfigShape>(
  "awthaq/core/AuditChainConfig",
  { defaultValue: () => ({ key: Option.none() }) },
);

/** Supplies the chain key. */
export const config = (options: { readonly key: Redacted.Redacted<string> }) =>
  Layer.succeed(AuditChainConfig, { key: Option.some(options.key) });

/**
 * An unambiguous encoding of ordered fields: a JSON array, so `["a","bc"]` and
 * `["ab","c"]` (or `null` and `""`) can never collide. Callers own field order.
 */
export const canonicalize = (fields: ReadonlyArray<string | number | null>): string =>
  JSON.stringify(fields);

/** One stored link, exactly as persisted. */
export interface ChainLink {
  readonly prevHash: string;
  /** The canonical encoding that was hashed. */
  readonly payload: string;
  readonly rowHash: string;
}

export interface AuditChainShape {
  /** `rowHash` for a link following `prevHash` with content `payload`. */
  readonly link: (prevHash: string, payload: string) => Effect.Effect<string>;
  /**
   * Walks `links` in order and resolves to the 0-based index of the first one
   * that does not verify — wrong `prevHash` (deleted/reordered predecessor, or a
   * first link that is not at genesis) or a `rowHash` that does not match its
   * own content — or `None` when the whole chain is intact.
   */
  readonly verify: (links: ReadonlyArray<ChainLink>) => Effect.Effect<Option.Option<number>>;
}

export class AuditChain extends Context.Service<AuditChain, AuditChainShape>()(
  "awthaq/core/AuditChain",
) {}

// ---- hashing -----------------------------------------------------------------

const SHA256_BLOCK_SIZE = 64;

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const concatBytes = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

/**
 * HMAC-SHA256 (RFC 2104) from `Crypto.digest`, as `@awthaq/server`'s CSRF token
 * signing builds it — the platform-neutral `Crypto` service exposes only plain
 * digests, not a keyed-MAC primitive.
 */
const hmacSha256 = Effect.fnUntraced(function* (
  crypto: Crypto.Crypto,
  key: Uint8Array,
  message: Uint8Array,
) {
  let blockKey = key.length > SHA256_BLOCK_SIZE ? yield* crypto.digest("SHA-256", key) : key;
  if (blockKey.length < SHA256_BLOCK_SIZE) {
    const padded = new Uint8Array(SHA256_BLOCK_SIZE);
    padded.set(blockKey);
    blockKey = padded;
  }
  const ipad = new Uint8Array(SHA256_BLOCK_SIZE);
  const opad = new Uint8Array(SHA256_BLOCK_SIZE);
  for (let i = 0; i < SHA256_BLOCK_SIZE; i++) {
    const keyByte = blockKey[i] ?? 0;
    ipad[i] = keyByte ^ 0x36;
    opad[i] = keyByte ^ 0x5c;
  }
  const inner = yield* crypto.digest("SHA-256", concatBytes(ipad, message));
  return yield* crypto.digest("SHA-256", concatBytes(opad, inner));
});

export const layer = Layer.effect(
  AuditChain,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const { key } = yield* AuditChainConfig;
    const encoder = new TextEncoder();

    const link: AuditChainShape["link"] = (prevHash, payload) => {
      // `prevHash` is fixed-width hex, so a plain separator cannot be spoofed by moving
      // bytes between the two fields.
      const message = encoder.encode(`${prevHash}\n${payload}`);
      const digest = Option.match(key, {
        onNone: () => crypto.digest("SHA-256", message),
        onSome: (secret) => hmacSha256(crypto, encoder.encode(Redacted.value(secret)), message),
      });
      return digest.pipe(Effect.map(toHex), Effect.orDie);
    };

    const verify: AuditChainShape["verify"] = Effect.fnUntraced(function* (links) {
      let expectedPrev = GENESIS_HASH;
      for (const [index, entry] of links.entries()) {
        if (entry.prevHash !== expectedPrev) return Option.some(index);
        const recomputed = yield* link(entry.prevHash, entry.payload);
        if (recomputed !== entry.rowHash) return Option.some(index);
        expectedPrev = entry.rowHash;
      }
      return Option.none();
    });

    return AuditChain.of({ link, verify });
  }),
);
