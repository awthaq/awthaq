// ERAS-002: the core services run on the edge-runtime `Crypto` provider, not only Node's.
import { WebCrypto } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AuditLog from "../src/AuditLog.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import * as Sessions from "../src/Sessions.ts";
import * as Users from "../src/Users.ts";

const EdgeLayer = Sessions.layerMemory.pipe(
  Layer.provide(WebCrypto.layer),
  Layer.provide(AuthEvents.layer),
  Layer.provide(AuditLog.layerMemory),
);

describe("Sessions over WebCrypto.layer (ERAS-002)", () => {
  it.effect("issue then verify round-trips with no Node crypto layer in the composition", () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.Sessions;
      const userId = Users.UserId("11111111-1111-1111-1111-111111111111");
      const { token, session } = yield* sessions.issue({ userId });
      const verified = yield* sessions.verify(token);
      assert.strictEqual(verified.session.id, session.id);
      assert.strictEqual(verified.session.userId, userId);
    }).pipe(Effect.provide(EdgeLayer)),
  );
});
