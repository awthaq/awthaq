// ELC-004: `TestAuth.memoryFoundation` is the one-line way to satisfy every memory layer's shared
// requirements (`Crypto`, `AuthEvents`, `AuditLog`, the hook registries), instead of each suite
// repeating `Layer.provideMerge(NodeCrypto.layer)` and its three neighbours.
import { AuditLog, AuthEvents, Hooks, Sessions, Users } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestAuth from "../src/TestAuth.ts";

describe("TestAuth.memoryFoundation (ELC-004)", () => {
  it.effect(
    "satisfies the memory Users/Sessions layers and re-exports what they were built over",
    () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const created = yield* users.create({
          identity: { _tag: "Email", email: "found@example.com" },
          name: "Found",
        });
        const sessions = yield* Sessions.Sessions;
        const issued = yield* sessions.issue({ userId: created.id });
        assert.strictEqual(issued.session.userId, created.id);
        // The very services the memory layers consumed are in the output, so a test can use them.
        yield* AuthEvents.AuthEvents;
        yield* AuditLog.AuditLog;
        yield* Hooks.BeforeUserDelete;
        yield* Crypto.Crypto;
      }).pipe(
        Effect.provide(
          Layer.mergeAll(Users.layerMemory, Sessions.layerMemory).pipe(
            Layer.provideMerge(TestAuth.memoryFoundation),
          ),
        ),
      ),
  );
});
