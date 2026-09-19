// spec/behaviors/24-nextjs-ssr.md, BEH-EA-185.
//
// `getSession` is a plain `Promise`-returning function, the shape a Next.js
// Server Component/server action actually calls — so these tests build a
// real `ManagedRuntime` (over memory `Sessions`/`Users` and the real
// `PrincipalResolverLive`, the same services `getSession` itself needs) and
// call it directly, rather than wrapping it in `@effect/vitest`'s
// `it.effect`. `TestClock.layer` is included explicitly in that runtime's
// own composed `Layer` (unlike `it.effect`'s ambient auto-provided
// `TestClock`, which only applies inside that Effect's own execution, not a
// separately-constructed `ManagedRuntime`) so the expiry test can advance
// simulated time and have `Sessions.layerMemory`'s own `DateTime.now` reads
// see it.
import { Api } from "@awthaq/api";
import { Sessions, Users } from "@awthaq/core";
import { Authentication } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { applyRotatedSession, getSession } from "../src/GetSession.ts";
import type { HeadersLike } from "../src/index.ts";

const TestLayer = Layer.mergeAll(
  Users.layerMemory,
  Sessions.layerMemory,
  Authentication.PrincipalResolverLive,
  TestClock.layer(),
).pipe(Layer.provideMerge(NodeCrypto.layer));

const runtime = ManagedRuntime.make(TestLayer);

/** BO-001/IC-001: a short `touchEvery` so a rotation is reachable without an implausibly long `TestClock.adjust`. */
const ShortTouchLayer = Layer.mergeAll(
  Users.layerMemory,
  Sessions.layerMemory,
  Authentication.PrincipalResolverLive,
  TestClock.layer(),
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      NodeCrypto.layer,
      Layer.succeed(Sessions.SessionConfig, {
        absolute: Duration.days(30),
        idle: Duration.days(7),
        touchEvery: Duration.minutes(1),
      }),
    ),
  ),
);

const rotationRuntime = ManagedRuntime.make(ShortTouchLayer);

const headersWithCookie = (cookieHeader: string | null): HeadersLike => ({
  get: (name) => (name.toLowerCase() === "cookie" ? cookieHeader : null),
});

const cookieHeaderFor = (token: Redacted.Redacted<string>): string =>
  `${Api.SessionCookie.key}=${Redacted.value(token)}`;

describe("getSession (BEH-EA-185)", () => {
  it("resolves undefined when the Cookie header is absent", async () => {
    const session = await getSession(headersWithCookie(null), runtime);
    assert.isUndefined(session);
  });

  it("resolves undefined for a malformed Cookie header", async () => {
    const session = await getSession(
      headersWithCookie("this is not a cookie header at all; ===;;"),
      runtime,
    );
    assert.isUndefined(session);
  });

  it("resolves undefined for a well-formed cookie naming a session that doesn't exist", async () => {
    const session = await getSession(
      headersWithCookie(`${Api.SessionCookie.key}=nonexistent.secret`),
      runtime,
    );
    assert.isUndefined(session);
  });

  it("resolves {principal, user, session} for a valid, unexpired session cookie", async () => {
    const { user, token } = await runtime.runPromise(
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;
        const user = yield* users.create({ email: "getsession@example.com", name: "Getter" });
        const { token } = yield* sessions.issue({ userId: user.id });
        return { user, token };
      }),
    );

    const session = await getSession(headersWithCookie(cookieHeaderFor(token)), runtime);

    assert.isDefined(session);
    if (session === undefined) return;
    assert.strictEqual(session.user.id, user.id);
    assert.strictEqual(session.session.userId, user.id);
    assert.strictEqual(session.principal._tag, "User");
    if (session.principal._tag === "User") {
      assert.strictEqual(session.principal.ref.id, user.id);
      assert.strictEqual(session.principal.sessionId, session.session.id);
    }
  });

  it("resolves undefined once the session has expired", async () => {
    const token = await runtime.runPromise(
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;
        const user = yield* users.create({ email: "expired@example.com", name: "Expired" });
        const { token } = yield* sessions.issue({ userId: user.id });
        return token;
      }),
    );

    // Default `SessionConfig` (`Sessions.ts`): 30-day absolute expiry.
    await runtime.runPromise(TestClock.adjust(Duration.days(31)));

    const session = await getSession(headersWithCookie(cookieHeaderFor(token)), runtime);
    assert.isUndefined(session);
  });

  it("BO-001/IC-001: a throttled touch's rotated token rides on session.rotated, and the old cookie stops verifying", async () => {
    const token = await rotationRuntime.runPromise(
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;
        const user = yield* users.create({ email: "rotate@example.com", name: "Rotator" });
        const { token } = yield* sessions.issue({ userId: user.id });
        return token;
      }),
    );

    // Past `ShortTouchLayer`'s own 1-minute `touchEvery`, well short of the
    // 7-day idle/30-day absolute expiry — this call's own throttled touch
    // rotates the secret.
    await rotationRuntime.runPromise(TestClock.adjust(Duration.minutes(2)));
    const rotated = await getSession(headersWithCookie(cookieHeaderFor(token)), rotationRuntime);
    assert.isDefined(rotated);
    if (rotated === undefined) return;
    assert.isDefined(rotated.rotated);

    // The old cookie's own secret no longer verifies — matching
    // `Sessions.ts`'s own "stops verifying immediately, no grace window."
    const staleSession = await getSession(
      headersWithCookie(cookieHeaderFor(token)),
      rotationRuntime,
    );
    assert.isUndefined(staleSession);

    // The freshly rotated token, once delivered, verifies on its own.
    if (rotated.rotated === undefined) return;
    const freshSession = await getSession(
      headersWithCookie(cookieHeaderFor(rotated.rotated)),
      rotationRuntime,
    );
    assert.isDefined(freshSession);
    assert.isUndefined(freshSession?.rotated);
  });

  it("BO-001/IC-001: applyRotatedSession writes the rotated cookie into the jar, and is a no-op otherwise", async () => {
    const token = await rotationRuntime.runPromise(
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;
        const user = yield* users.create({ email: "apply-rotate@example.com", name: "Applier" });
        const { token } = yield* sessions.issue({ userId: user.id });
        return token;
      }),
    );

    const written: Array<{ readonly name: string; readonly value: string }> = [];
    const jar = { set: (name: string, value: string) => written.push({ name, value }) };

    // No rotation yet — a no-op.
    const fresh = await getSession(headersWithCookie(cookieHeaderFor(token)), rotationRuntime);
    applyRotatedSession(fresh, jar);
    assert.strictEqual(written.length, 0);

    await rotationRuntime.runPromise(TestClock.adjust(Duration.minutes(2)));
    const rotated = await getSession(headersWithCookie(cookieHeaderFor(token)), rotationRuntime);
    applyRotatedSession(rotated, jar);
    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0]?.name, Api.SessionCookie.key);
    if (rotated?.rotated === undefined) throw new Error("expected a rotated token");
    assert.strictEqual(written[0]?.value, Redacted.value(rotated.rotated));

    // undefined session — also a no-op, not a throw.
    applyRotatedSession(undefined, jar);
    assert.strictEqual(written.length, 1);
  });
});
