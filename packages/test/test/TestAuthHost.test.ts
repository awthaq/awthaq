// BEH-EA-342 (plan 15): the harness and a production host share the wiring by construction. `TestAuth.layer` is
// `AuthHost.layer` over the test ports, the redaction guard and the HTTP platform, so building both for the same
// composition must give the same services except the guard's and the undeclared-event policy (ADR-EA-049). A hand-forked base in the harness fails this. Under
// `pnpm test:pg` the SQL case is the Postgres run of `AuthHost`'s SQL mode (through `TestSql`).
import { Auth, AuthEvents } from "@awthaq/core";
import { ClientAddress, Mailer, PasswordHasher, RateLimiter } from "@awthaq/ports";
import { AuthHost, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as RedactionGuard from "../src/RedactionGuard.ts";
import * as TestAuth from "../src/TestAuth.ts";
import * as TestEncryption from "../src/TestEncryption.ts";
import * as TestSql from "../src/TestSql.ts";
import { Pins } from "./support/Pins.ts";

const built = Auth.make([Pins]);

/** The same port set `TestAuth` provides (only the keys matter here), and the HTTP platform. */
const hostOwned = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        PasswordHasher.layerArgon2id.pipe(Layer.orDie),
        Mailer.layerMemory,
        RateLimiter.layerPermissive,
        ClientAddress.layerDirect,
        TestEncryption.layer,
      ).pipe(Layer.provideMerge(NodeCrypto.layer)),
    ),
    Layer.provideMerge(HttpServer.layerServices),
    Layer.provideMerge(HttpRouter.layer),
  );

const csrf = Layer.succeed(Csrf.CsrfConfig, TestAuth.TestCsrfConfig);
/** What the harness serves without, on purpose: the body limit (the request context is derived, ADR-EA-047). */
const dials: { readonly bodyLimit: false } = { bodyLimit: false };

const keysOf = <A, E>(layer: Layer.Layer<A, E>) =>
  Effect.runPromise(
    Layer.build(layer).pipe(
      Effect.map((context: Context.Context<A>) => new Set(context.mapUnsafe.keys())),
      Effect.scoped,
    ),
  );

describe("TestAuth.layer over AuthHost (BEH-EA-342)", () => {
  for (const records of TestAuth.recordModes) {
    it(`TestAuth.layer(built) is AuthHost.layer(built) plus exactly the test-only services (${records})`, async () => {
      const harness = await keysOf(
        records === "sql"
          ? TestAuth.layer(built, { records: "sql", suite: "test_TestAuthHost_harness" })
          : TestAuth.layer(built),
      );
      const host = await keysOf(
        records === "sql"
          ? hostOwned(
              AuthHost.layer(built, {
                ...dials,
                csrf,
                persistence: {
                  records: "sql",
                  client: TestSql.layer("test_TestAuthHost_host"),
                  migrations: "apply",
                },
              }),
            )
          : hostOwned(
              AuthHost.layer(built, { ...dials, csrf, persistence: { records: "memory" } }),
            ),
      );
      const guard = await keysOf(RedactionGuard.layer);
      const missing = [...host].filter((key) => !harness.has(key));
      const extra = [...harness].filter((key) => !host.has(key)).sort();
      assert.deepStrictEqual(missing, [], "the harness serves everything the host module derives");
      // ADR-EA-049: plus the undeclared-event policy, "die" under the harness.
      assert.deepStrictEqual(
        extra,
        [
          ...[...guard].filter((key) => !host.has(key)),
          AuthEvents.UndeclaredEventPolicy.key,
        ].sort(),
      );
      assert.include(extra, RedactionGuard.RedactionGuard.key);
    });
  }

  it("TestAuth.layer({ tier }) selects the served groups as AuthHost does", async () => {
    const admin = TestAuth.app(TestAuth.layer(built, { tier: "admin" }));
    try {
      const operator = await admin.signIn("tier@example.com");
      // `Pins` has no admin-tier group, so the admin listener serves nothing of it, nor core's groups.
      assert.strictEqual((await operator.request("GET", "/pins")).status, 404);
      assert.strictEqual((await operator.request("GET", "/session")).status, 404);
    } finally {
      await admin.dispose();
    }
    const publicTier = TestAuth.app(TestAuth.layer(built, { tier: "public" }));
    try {
      const user = await publicTier.signIn("tier@example.com");
      assert.strictEqual((await user.request("GET", "/pins")).status, 200);
    } finally {
      await publicTier.dispose();
    }
  });
});
