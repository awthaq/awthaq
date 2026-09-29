// EP-009/ECS-008 (BEH-EA-229, ADR-EA-006 rev 1.2): the running application's effective
// configuration, dumped through the admin surface behind the same fail-closed gate as user
// administration — sensitive values redacted, never unwrapped.
import { Api } from "@awthaq/api";
import {
  Auth,
  AuditChain,
  AuditLog,
  AuthEvents,
  EffectiveConfig,
  Hooks,
  Sessions,
  Users,
} from "@awthaq/core";
import { Authentication, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Duration from "effect/Duration";
import * as Admin from "../src/Admin.ts";
import * as ImpersonationRecords from "../src/ImpersonationRecords.ts";

const CANARY = "audit-chain-key-canary-7c1f";

const CoreLive = Layer.mergeAll(Sessions.layerMemory, Users.layerMemory).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(NodeCrypto.layer),
);

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);
const AdminAuthenticationLive = Authentication.AdminAuthenticationLive.pipe(
  Layer.provide(AuthenticationLive),
);
const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make("admin-config-test-csrf-secret-padded-to-thirty-two-bytes"),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

/** What an application composes: the plugin, its configuration, and the catalog of its composition. */
const buildLayer = (config: Partial<Admin.AdminConfigShape>, catalog: boolean) =>
  Admin.Admin.layer.pipe(
    Layer.provide(Admin.config(config)),
    // A configuration override and a secret, provided to the composed layer like any other config.
    Layer.provide(AuditChain.config({ key: Redacted.make(CANARY) })),
    Layer.provide(catalog ? EffectiveConfig.layer(Auth.make([Admin.Admin]).manifest) : Layer.empty),
    Layer.provide(AdminAuthenticationLive),
    Layer.provide(CsrfProtectionLive),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(
      ImpersonationRecords.layerMemory.pipe(
        Layer.provide(NodeCrypto.layer),
        Layer.provide(AuditChain.layer.pipe(Layer.provide(NodeCrypto.layer))),
      ),
    ),
  );

const asCaller = (id: string): Api.UserPrincipal =>
  new Api.UserPrincipal({
    ref: new Api.PrincipalRef({ type: "user", id }),
    sessionId: "admin-session",
  });

describe("Admin.effectiveConfig", () => {
  it.effect("is fail-closed by default and publishes actionDenied", () =>
    Effect.gen(function* () {
      const admin = yield* Admin.Admin;
      const events = yield* AuthEvents.AuthEvents;
      const seen = yield* Ref.make<ReadonlyArray<AuthEvents.AuthEvent>>([]);
      yield* events.stream.pipe(
        Stream.runForEach((event) => Ref.update(seen, (all) => [...all, event])),
        Effect.forkScoped({ startImmediately: true }),
      );
      const failure = yield* admin.effectiveConfig(asCaller("admin-1")).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "AdminActionDenied");
      yield* TestClock.adjust(Duration.millis(10));
      const denied = (yield* Ref.get(seen)).filter((e) => e._tag === "auth.admin.actionDenied");
      assert.deepStrictEqual(
        denied.map((e) => (e._tag === "auth.admin.actionDenied" ? e.action : "")),
        ["effectiveConfig"],
      );
    }).pipe(Effect.scoped, Effect.provide(buildLayer({}, true))),
  );

  it.effect("lists the composition's descriptors with an override marked and the secret redacted", () =>
    Effect.gen(function* () {
      const admin = yield* Admin.Admin;
      const items = yield* admin.effectiveConfig(asCaller("admin-1"));
      const chain = items.find((item) => item.key === "awthaq/core/AuditChainConfig");
      assert.strictEqual(chain?.owner, "admin");
      assert.strictEqual(chain?.source, "override");
      assert.deepStrictEqual(
        chain?.entries.map((entry) => [entry.path, entry.value, entry.sensitive]),
        [["key", "<redacted>", true]],
      );
      // Core's own descriptors are listed too, as defaults.
      const session = items.find((item) => item.key === "awthaq/core/SessionConfig");
      assert.strictEqual(session?.owner, "core");
      assert.strictEqual(session?.source, "default");
      assert.notInclude(JSON.stringify(items), CANARY);
    }).pipe(
      Effect.scoped,
      Effect.provide(buildLayer({ canManageUsers: () => Effect.succeed(true) }, true)),
    ),
  );

  it.effect("without a catalog it lists core's own descriptors only", () =>
    Effect.gen(function* () {
      const admin = yield* Admin.Admin;
      const items = yield* admin.effectiveConfig(asCaller("admin-1"));
      assert.isTrue(items.every((item) => item.owner === "core"));
      assert.notInclude(JSON.stringify(items), CANARY);
    }).pipe(
      Effect.scoped,
      Effect.provide(buildLayer({ canManageUsers: () => Effect.succeed(true) }, false)),
    ),
  );
});
