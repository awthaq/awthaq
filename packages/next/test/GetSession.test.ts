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
import { AuditLog, Hooks, AuthEvents, Sessions, Users } from "@awthaq/core";
import { Authentication } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
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
).pipe(
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
);

/**
 * ETVS-006: a fresh runtime per case, disposed in `finally` — the clock-
 * mutating cases (`TestClock.adjust`) must not leak simulated time into
 * their neighbours, so the suite passes under `--sequence.shuffle`.
 */
const withRuntime = async <R, A>(
  layer: Layer.Layer<R>,
  body: (runtime: ManagedRuntime.ManagedRuntime<R, never>) => Promise<A>,
): Promise<A> => {
  const runtime = ManagedRuntime.make(layer);
  try {
    return await body(runtime);
  } finally {
    await runtime.dispose();
  }
};

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
      AuthEvents.layer.pipe(Layer.provideMerge(AuditLog.layerMemory)),
      Hooks.HooksLive,
      Layer.succeed(Sessions.SessionConfig, {
        absolute: Duration.days(30),
        idle: Duration.days(7),
        touchEvery: Duration.minutes(1),
      }),
    ),
  ),
);

const headersWithCookie = (cookieHeader: string | null): HeadersLike => ({
  get: (name) => (name.toLowerCase() === "cookie" ? cookieHeader : null),
});

const cookieHeaderFor = (token: Redacted.Redacted<string>): string =>
  `${Api.SessionCookie.key}=${Redacted.value(token)}`;

describe("@awthaq/next public entry (RRS-002)", () => {
  // Dynamic import: the lint config forbids static barrel imports in tests,
  // and this is the one place the barrel itself is the subject.
  it("exports the whole ticket-16 rotation pair, so a Server Action can deliver session.rotated", async () => {
    const entry = await import("../src/index.ts");
    assert.strictEqual(entry.getSession, getSession);
    assert.strictEqual(entry.applyRotatedSession, applyRotatedSession);
  });
});

describe("getSession — impersonation precedence (APS-006)", () => {
  it("APS-006: an impersonation cookie shadows the session cookie; an ordinary session planted in it is ignored", () =>
    withRuntime(TestLayer, async (runtime) => {
      const { own, planted, impersonation, target } = await runtime.runPromise(
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const sessions = yield* Sessions.Sessions;
          const admin = yield* users.create({
            identity: { _tag: "Email", email: "aps006-admin@example.com" },
            name: "Admin",
          });
          const targetUser = yield* users.create({
            identity: { _tag: "Email", email: "aps006-target@example.com" },
            name: "Target",
          });
          return {
            target: targetUser,
            own: yield* sessions.issue({ userId: admin.id }),
            planted: yield* sessions.issue({ userId: admin.id }),
            impersonation: yield* sessions.issue({
              userId: targetUser.id,
              actingAs: { type: "user", id: admin.id },
            }),
          };
        }),
      );
      const cookie = (impersonationToken: Redacted.Redacted<string>) =>
        `${Api.ImpersonationCookie.key}=${Redacted.value(impersonationToken)}; ${cookieHeaderFor(own.token)}`;

      const shadowed = await getSession(headersWithCookie(cookie(impersonation.token)), runtime);
      assert.strictEqual(shadowed?.user.id, target.id);

      const ignored = await getSession(headersWithCookie(cookie(planted.token)), runtime);
      assert.strictEqual(ignored?.session.id, own.session.id);
    }));
});

describe("getSession (BEH-EA-185)", () => {
  it("resolves undefined when the Cookie header is absent", () =>
    withRuntime(TestLayer, async (runtime) => {
      const session = await getSession(headersWithCookie(null), runtime);
      assert.isUndefined(session);
    }));

  it("resolves undefined for a malformed Cookie header", () =>
    withRuntime(TestLayer, async (runtime) => {
      const session = await getSession(
        headersWithCookie("this is not a cookie header at all; ===;;"),
        runtime,
      );
      assert.isUndefined(session);
    }));

  it("resolves undefined for a well-formed cookie naming a session that doesn't exist", () =>
    withRuntime(TestLayer, async (runtime) => {
      const session = await getSession(
        headersWithCookie(`${Api.SessionCookie.key}=nonexistent.secret`),
        runtime,
      );
      assert.isUndefined(session);
    }));

  it("resolves {principal, user, session} for a valid, unexpired session cookie", () =>
    withRuntime(TestLayer, async (runtime) => {
      const { user, token } = await runtime.runPromise(
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const sessions = yield* Sessions.Sessions;
          const user = yield* users.create({
            identity: { _tag: "Email", email: "getsession@example.com" },
            name: "Getter",
          });
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
    }));

  it("resolves undefined once the session has expired", () =>
    withRuntime(TestLayer, async (runtime) => {
      const token = await runtime.runPromise(
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const sessions = yield* Sessions.Sessions;
          const user = yield* users.create({
            identity: { _tag: "Email", email: "expired@example.com" },
            name: "Expired",
          });
          const { token } = yield* sessions.issue({ userId: user.id });
          return token;
        }),
      );

      // Default `SessionConfig` (`Sessions.ts`): 30-day absolute expiry.
      await runtime.runPromise(TestClock.adjust(Duration.days(31)));

      const session = await getSession(headersWithCookie(cookieHeaderFor(token)), runtime);
      assert.isUndefined(session);
    }));

  it("BO-001/IC-001: a throttled touch's rotated token rides on session.rotated, and the old cookie stops verifying", () =>
    withRuntime(ShortTouchLayer, async (rotationRuntime) => {
      const token = await rotationRuntime.runPromise(
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const sessions = yield* Sessions.Sessions;
          const user = yield* users.create({
            identity: { _tag: "Email", email: "rotate@example.com" },
            name: "Rotator",
          });
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
    }));

  it("BO-001/IC-001: applyRotatedSession writes the rotated cookie into the jar, and is a no-op otherwise", () =>
    withRuntime(ShortTouchLayer, async (rotationRuntime) => {
      const token = await rotationRuntime.runPromise(
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const sessions = yield* Sessions.Sessions;
          const user = yield* users.create({
            identity: { _tag: "Email", email: "apply-rotate@example.com" },
            name: "Applier",
          });
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
    }));

  it("RSC-007: the user and principal lookups run concurrently", () => {
    // `findById` blocks until the resolver has run: a sequential
    // findById-then-resolve deadlocks (the race below reports "deadlock"),
    // a concurrent one completes.
    const gate = Effect.runSync(Deferred.make<void>());
    const GatedUsers = Layer.effect(
      Users.Users,
      Effect.gen(function* () {
        const base = yield* Users.Users;
        return {
          ...base,
          findById: (id: Users.UserRecord["id"]) =>
            Deferred.await(gate).pipe(Effect.andThen(base.findById(id))),
        };
      }),
    ).pipe(Layer.provide(Users.layerMemory));
    const GatedResolver = Layer.succeed(Authentication.PrincipalResolver, {
      resolve: (session) =>
        Deferred.succeed(gate, undefined).pipe(
          Effect.as(
            new Api.UserPrincipal({
              ref: new Api.PrincipalRef({ type: "user", id: session.userId }),
              sessionId: session.id,
            }),
          ),
        ),
    });
    return withRuntime(
      Layer.mergeAll(GatedUsers, Sessions.layerMemory, GatedResolver).pipe(
        Layer.provideMerge(NodeCrypto.layer),
        Layer.provideMerge(AuthEvents.layer),
        Layer.provideMerge(AuditLog.layerMemory),
        Layer.provideMerge(Hooks.HooksLive),
      ),
      async (runtime) => {
        const token = await runtime.runPromise(
          Effect.gen(function* () {
            const base = yield* Users.Users;
            const sessions = yield* Sessions.Sessions;
            const user = yield* base.create({
              identity: { _tag: "Email", email: "concurrent@example.com" },
              name: "Conc",
            });
            const { token } = yield* sessions.issue({ userId: user.id });
            return token;
          }),
        );
        const outcome = await Promise.race([
          getSession(headersWithCookie(cookieHeaderFor(token)), runtime),
          new Promise<"deadlock">((resolve) => setTimeout(() => resolve("deadlock"), 500)),
        ]);
        assert.notStrictEqual(outcome, "deadlock");
      },
    );
  });
});
