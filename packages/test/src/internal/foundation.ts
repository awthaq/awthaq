// @awthaq/test — the memory foundation, shared by `TestAuth` and `RecordsContract` (plan 25) without
// either importing the other.

import {
  AuditChain,
  AuditLog,
  AuthEvents,
  type DataExport,
  type Erasure,
  Hooks,
  Persistence,
  type Retention,
} from "@awthaq/core";
import type { Encryption } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as TestEncryption from "../TestEncryption.ts";

/**
 * Named so the foundation's inferred type can be emitted (declaration emit needs the namespaces in scope).
 * @public
 */
export type FoundationRegistries =
  | DataExport.DataExportRegistry
  | Erasure.ErasureRegistry
  | Retention.RetentionRegistry
  | Encryption.Encryption;

/**
 * ELC-004: what every memory layer (`Users`/`Accounts`/`Sessions`/`Verification`, each plugin's
 * record stores) needs beneath it, as one layer: the platform crypto services (ids, secrets, hashes, MACs),
 * `AuthEvents` over an in-memory `AuditLog`, and every hook point's default (no-tap) layer.
 * `Users.layer.pipe(Layer.provideMerge(TestAuth.memoryFoundation))` replaces the four
 * `Layer.provideMerge(NodeCrypto.layer | AuthEvents.layer | AuditLog.layer |
 * Hooks.HooksLive)` lines each suite used to repeat. The services stay in the output, so a test
 * can `yield*` the very instances the stores were built over. Raw layers stay available for a
 * suite that injects its own crypto services or hook taps. It is the low-level seam for a store suite
 * that builds one store alone; a whole composition goes through `TestAuth.layer`.
 */
export const memoryFoundation = AuthEvents.layer.pipe(
  // BEH-EA-100: `AuthEvents.layer` needs `AuditLog` — see its own header comment.
  Layer.provideMerge(AuditLog.layer.pipe(Layer.provide(Persistence.memory))),
  // AOMS-006/BCR-004/CSG-002/THS-002 (wayfinder ticket 03): every hook point's own default
  // (no-tap) layer — `Users.layer` and every plugin's own `make` consult one directly. See
  // `Hooks.HooksLive`'s own doc comment.
  Layer.provideMerge(Hooks.HooksLive),
  // Plan 08: the hash chain `Admin`'s impersonation records link their rows with (unkeyed unless a test
  // provides `AuditChain.config`); it needs only `Digest` and `Mac`, so it rides here, beside the other things stores read.
  Layer.provideMerge(AuditChain.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

/**
 * Plan 25: what every adapter `RecordsContract` builds sits on, and what a case may read besides the
 * stores: the memory foundation, the test `Encryption`, and a `TestClock` (a case fixes time with
 * `TestClock.adjust`; nothing reads the wall clock).
 */
export const recordsFoundation = Layer.mergeAll(
  memoryFoundation,
  TestEncryption.layer,
  TestClock.layer(),
);
