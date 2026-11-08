// Hand-wired on purpose: `getSession` over exactly the services it needs, without a router (plan 08 exemption).
// spec/behaviors/24-nextjs-ssr.md, BEH-EA-185, NSA-002.
//
// `React.cache` only memoizes inside a React server render, so this file stands in a faithful memoizing `cache`
// (keyed on argument identity, as React's is) to pin what `getSession` hands it: the WHOLE cookie-header resolution
// (ADR-EA-042), not each token, so two calls in one render verify once.
import { TestAuth } from "@awthaq/test";
import { AuditLog, AuthEvents, Hooks, Persistence, Sessions, Users } from "@awthaq/core";
import { Credentials } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Redacted from "effect/Redacted";

vi.mock("react", () => ({
  cache: <A extends ReadonlyArray<unknown>, B>(fn: (...args: A) => B) => {
    const memo = new Map<unknown, Map<unknown, B>>();
    return (...args: A): B => {
      const [first, second] = args;
      const inner = memo.get(first) ?? new Map<unknown, B>();
      memo.set(first, inner);
      const hit = inner.get(second);
      if (hit !== undefined) return hit;
      const fresh = fn(...args);
      inner.set(second, fresh);
      return fresh;
    };
  },
}));

const TestLayer = Layer.mergeAll(
  Users.layer.pipe(Layer.provide(Persistence.memory)),
  Sessions.layer.pipe(Layer.provide(Persistence.memory)),
  Credentials.PrincipalResolverLive,
).pipe(
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layer.pipe(Layer.provide(Persistence.memory))),
  Layer.provideMerge(Hooks.HooksLive),
);

describe("getSession: the React.cache unit is the whole cookie-header resolution (NSA-002)", () => {
  it("two getSession calls in one render resolve once and share the result", async () => {
    const { getSession } = await import("../src/GetSession.ts");
    const runtime = ManagedRuntime.make(TestLayer);
    try {
      const issued = await runtime.runPromise(
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const sessions = yield* Sessions.Sessions;
          const user = yield* users.create({
            identity: { _tag: "Email", email: "next-dedupe@example.com" },
            name: "Dedupe",
          });
          return yield* sessions.issue({ userId: user.id }).pipe(TestAuth.withoutRequest);
        }),
      );
      // One render: `headers().get("cookie")` is the same string and the runtime the same object.
      const cookie = `__Host-session=${Redacted.value(issued.token)}`;
      const headers = { get: (name: string) => (name.toLowerCase() === "cookie" ? cookie : null) };
      const first = await getSession(headers, runtime);
      const second = await getSession(headers, runtime);
      assert.strictEqual(first?.session.id, issued.session.id);
      assert.strictEqual(second, first);
    } finally {
      await runtime.dispose();
    }
  });
});
