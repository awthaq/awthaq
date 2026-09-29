// spec/behaviors/24-nextjs-ssr.md, BEH-EA-185.
//
// The database-verified `getSession` contract is tested where it lives, in
// `@awthaq/web` (`packages/web/test/Session.test.ts`, BO-004). What is
// Next-specific is asserted here: the public entry, and that the `React.cache`
// wrapped `getSession` still resolves a real session.
import { Api } from "@awthaq/api";
import { AuditLog, Hooks, AuthEvents, Sessions, Users } from "@awthaq/core";
import { Authentication } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Redacted from "effect/Redacted";
import { applyRotatedSession, getSession } from "../src/GetSession.ts";

const TestLayer = Layer.mergeAll(
  Users.layerMemory,
  Sessions.layerMemory,
  Authentication.PrincipalResolverLive,
).pipe(
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
);

describe("@awthaq/next public entry (RRS-002)", () => {
  // Dynamic import: the lint config forbids static barrel imports in tests,
  // and this is the one place the barrel itself is the subject.
  it("exports the whole ticket-16 rotation pair, so a Server Action can deliver session.rotated", async () => {
    const entry = await import("../src/index.ts");
    assert.strictEqual(entry.getSession, getSession);
    assert.strictEqual(entry.applyRotatedSession, applyRotatedSession);
  });

  it("BO-004: the framework-neutral core is re-exported from @awthaq/web, not forked", async () => {
    const entry = await import("../src/index.ts");
    const web = await import("@awthaq/web");
    assert.strictEqual(entry.applyRotatedSession, web.applyRotatedSession);
    assert.strictEqual(entry.hasSessionCookie, web.hasSessionCookie);
    assert.strictEqual(entry.withNextCookies, web.applyResponseCookies);
    assert.strictEqual(entry.serverActionClient, web.inProcessClient);
    assert.strictEqual(entry.makeServerActionClient, web.makeInProcessClient);
  });
});

describe("getSession — the React.cache wrapped verify (BEH-EA-185, NSA-002)", () => {
  it("resolves a valid session cookie and undefined without one", async () => {
    const runtime = ManagedRuntime.make(TestLayer);
    try {
      const issued = await runtime.runPromise(
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const sessions = yield* Sessions.Sessions;
          const user = yield* users.create({
            identity: { _tag: "Email", email: "next-get-session@example.com" },
            name: "Next",
          });
          return yield* sessions.issue({ userId: user.id });
        }),
      );
      const withCookie = {
        get: (name: string) =>
          name.toLowerCase() === "cookie"
            ? `${Api.SessionCookie.key}=${Redacted.value(issued.token)}`
            : null,
      };
      const resolved = await getSession(withCookie, runtime);
      assert.strictEqual(resolved?.session.id, issued.session.id);
      assert.isUndefined(await getSession({ get: () => null }, runtime));
    } finally {
      await runtime.dispose();
    }
  });
});
