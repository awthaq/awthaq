// ETVS-002: property tests for the `id.secret` session token (BEH-EA-049/050, PIL-007).
// `Sessions.verify` parses a value an attacker fully controls (the cookie), so the parse is
// checked against arbitrary strings, not a handful of hand-picked malformed examples.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as AuditLog from "../src/AuditLog.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import * as Sessions from "../src/Sessions.ts";
import * as Users from "../src/Users.ts";

const MemoryLayer = Sessions.layerMemory.pipe(
  Layer.provide(NodeCrypto.layer),
  Layer.provide(AuthEvents.layer),
  Layer.provide(AuditLog.layerMemory),
);

const userId = Users.UserId("11111111-1111-1111-1111-111111111111");

describe("Sessions.verify token parsing properties", () => {
  it.effect.prop(
    "BEH-EA-050: any presented string that is not a live session's token fails with the typed NotFound, never a defect",
    { presented: Schema.String },
    ({ presented }) =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const failure = yield* sessions.verify(Redacted.make(presented)).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "Sessions/NotFound");
      }).pipe(Effect.provide(MemoryLayer)),
  );

  it.effect.prop(
    "PIL-007: presenting <live id>.<anything else> never verifies and never disturbs the live session",
    { guess: Schema.String },
    ({ guess }) =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { session, token } = yield* sessions.issue({ userId });
        const raw = Redacted.value(token);
        const secret = raw.slice(raw.indexOf(".") + 1);
        if (guess === secret) return;
        const failure = yield* sessions
          .verify(Redacted.make(`${session.id}.${guess}`))
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "Sessions/NotFound");
        // The id is public (cookies, JWT sid): a wrong secret must not revoke or rotate anything.
        const stillLive = yield* sessions.verify(token);
        assert.strictEqual(stillLive.session.id, session.id);
      }).pipe(Effect.provide(MemoryLayer)),
  );

  it.effect.prop(
    "BEH-EA-049: an issued token is exactly `<session id>.<secret>`, and neither half alone verifies",
    { pad: Schema.String },
    ({ pad }) =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { session, token } = yield* sessions.issue({ userId });
        const raw = Redacted.value(token);
        const separator = raw.indexOf(".");
        assert.strictEqual(raw.slice(0, separator), session.id);
        assert.notInclude(session.id, ".");
        const secret = raw.slice(separator + 1);
        assert.isAbove(secret.length, 0);
        const verified = yield* sessions.verify(token);
        assert.strictEqual(verified.session.id, session.id);
        for (const half of [session.id, secret, `${pad}${secret}`, `${session.id}${pad}`]) {
          if (half === raw) continue;
          const failure = yield* sessions.verify(Redacted.make(half)).pipe(Effect.flip);
          assert.strictEqual(failure._tag, "Sessions/NotFound");
        }
      }).pipe(Effect.provide(MemoryLayer)),
  );

  it.effect.prop(
    "BEH-EA-049: every issued token is unique, and no secret repeats across sessions",
    { count: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 12 })) },
    ({ count }) =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const tokens: Array<string> = [];
        for (let i = 0; i < count; i++) {
          const { token } = yield* sessions.issue({ userId });
          tokens.push(Redacted.value(token));
        }
        assert.strictEqual(new Set(tokens).size, count);
        assert.strictEqual(
          new Set(tokens.map((raw) => raw.slice(raw.indexOf(".") + 1))).size,
          count,
        );
      }).pipe(Effect.provide(MemoryLayer)),
  );
});
