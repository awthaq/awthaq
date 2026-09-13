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
import { NodeCrypto } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { getSession } from "../src/index.ts";
import type { HeadersLike } from "../src/index.ts";

const TestLayer = Layer.mergeAll(
  Users.layerMemory,
  Sessions.layerMemory,
  Authentication.PrincipalResolverLive,
  TestClock.layer(),
).pipe(Layer.provideMerge(NodeCrypto.layer));

const runtime = ManagedRuntime.make(TestLayer);

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
});
