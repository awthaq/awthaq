// ERAS-002: core's session store runs on the edge-safe `WebCrypto` layer, with no
// `node:crypto` involved — the parity proof for a Workers/Edge composition.
import { WebCrypto } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as AuditLog from "../src/AuditLog.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import * as Sessions from "../src/Sessions.ts";
import { UserId } from "../src/Users.ts";

const EdgeLive = Sessions.layerMemory.pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(WebCrypto.layer),
);

describe("Sessions over WebCrypto.layer (ERAS-002)", () => {
  it.effect("issue and verify round-trip, and a wrong secret is refused", () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.Sessions;
      const { session, token } = yield* sessions.issue({
        userId: UserId("11111111-1111-1111-1111-111111111111"),
      });
      const verified = yield* sessions.verify(token);
      assert.strictEqual(verified.session.id, session.id);
      const wrong = yield* sessions
        .verify(Redacted.make(`${session.id}.${"0".repeat(64)}`))
        .pipe(Effect.flip);
      assert.strictEqual(wrong._tag, "Sessions/NotFound");
    }).pipe(Effect.provide(EdgeLive)),
  );
});
