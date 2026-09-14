// spec/behaviors/24-nextjs-ssr.md, BEH-EA-188.
//
// Proves `hasSessionCookie` is presence-only: it returns `true` for an
// *expired* session's still-present cookie just as readily as a valid
// one — the whole point being that it performs no verification at all, not
// merely that it happens to tolerate expired sessions.
import { Api } from "@awthaq/api";
import { Sessions, Users } from "@awthaq/core";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { hasSessionCookie } from "../src/HasSessionCookie.ts";
import type { HeadersLike } from "../src/index.ts";

const requestWithCookie = (cookieHeader: string | null): { readonly headers: HeadersLike } => ({
  headers: { get: (name) => (name.toLowerCase() === "cookie" ? cookieHeader : null) },
});

describe("hasSessionCookie (BEH-EA-188)", () => {
  it("returns false when the session cookie is absent", () => {
    assert.isFalse(hasSessionCookie(requestWithCookie(null)));
  });

  it("returns false when other cookies are present but not the session cookie", () => {
    assert.isFalse(hasSessionCookie(requestWithCookie("theme=dark; lang=en")));
  });

  it("returns true when the session cookie is present, valid, and unexpired", () => {
    assert.isTrue(hasSessionCookie(requestWithCookie(`${Api.SessionCookie.key}=whatever-value`)));
  });

  it("returns true even when the cookie names a session that has since expired — proving no verification happens", async () => {
    const TestLayer = Layer.mergeAll(
      Users.layerMemory,
      Sessions.layerMemory,
      TestClock.layer(),
    ).pipe(Layer.provideMerge(NodeCrypto.layer));
    const runtime = ManagedRuntime.make(TestLayer);
    const token = await runtime.runPromise(
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;
        const user = yield* users.create({ email: "stale@example.com", name: "Stale" });
        const { token } = yield* sessions.issue({ userId: user.id });
        return token;
      }),
    );
    await runtime.runPromise(TestClock.adjust(Duration.days(31)));

    assert.isTrue(
      hasSessionCookie(requestWithCookie(`${Api.SessionCookie.key}=${Redacted.value(token)}`)),
    );
  });
});
