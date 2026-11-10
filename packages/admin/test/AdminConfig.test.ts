// EP-009/ECS-008 (BEH-EA-229, ADR-EA-006 rev 1.2): the running application's effective
// configuration, dumped through the admin surface behind the same fail-closed gate as user
// administration — sensitive values redacted, never unwrapped.
import { Api } from "@awthaq/api";
import { AuditChain, Auth, EffectiveConfig } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Admin from "../src/Admin.ts";
import { Password } from "@awthaq/password";
import { TestAuth } from "@awthaq/test";

const CANARY = "audit-chain-key-canary-7c1f";

/** What an application composes: the plugin, its configuration, and the catalog of its composition. */
const built = Auth.make([Admin.Admin]);

const buildLayer = (
  config: Partial<Admin.AdminConfigShape>,
  catalog: boolean,
) =>
  TestAuth.layer(built, {
    services: Layer.mergeAll(
      Admin.config(config),
      // A configuration override and a secret, provided to the composed layer like any other config.
      AuditChain.config({ key: Redacted.make(CANARY) }),
      catalog ? EffectiveConfig.layer(built.manifest) : Layer.empty,
    ),
  });

const asCaller = (id: string): Api.UserPrincipal =>
  new Api.UserPrincipal({
    ref: new Api.PrincipalRef({ type: "user", id }),
    sessionId: "admin-session",
  });

describe("Admin.effectiveConfig", () => {
  it.effect(
    "lists the composition's descriptors with an override marked and the secret redacted",
    () =>
      Effect.gen(function* () {
        const admin = yield* Admin.Admin;
        const items = yield* admin.effectiveConfig(asCaller("admin-1"));
        const chain = items.find(
          (item) => item.key === "awthaq/core/AuditChainConfig",
        );
        assert.strictEqual(chain?.owner, "admin");
        assert.strictEqual(chain?.source, "override");
        assert.deepStrictEqual(
          chain?.entries.map((entry) => [
            entry.path,
            entry.value,
            entry.sensitive,
          ]),
          [["key", "<redacted>", true]],
        );
        // Core's own descriptors are listed too, as defaults.
        const session = items.find(
          (item) => item.key === "awthaq/core/SessionConfig",
        );
        assert.strictEqual(session?.owner, "core");
        assert.strictEqual(session?.source, "default");
        assert.notInclude(JSON.stringify(items), CANARY);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          buildLayer({ canManageUsers: () => Effect.succeed(true) }, true),
        ),
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
      Effect.provide(
        buildLayer({ canManageUsers: () => Effect.succeed(true) }, false),
      ),
    ),
  );
});

const withPassword = Auth.make([Admin.Admin, Password.Password]);

const passwordLayer = TestAuth.layer(withPassword, {
  services: Layer.mergeAll(
    Admin.config({ canManageUsers: () => Effect.succeed(true) }),
    Password.config({}),
    TestAuth.httpClient.noBreach,
    EffectiveConfig.layer(withPassword.manifest),
  ),
});

describe("plan 36 F1: the view under a tenant", () => {
  it.effect(
    "under a tenant's Password.config the view reports the minLength the tenant's operations enforce",
    () =>
      Effect.gen(function* () {
        const admin = yield* Admin.Admin;
        const items = yield* admin
          .effectiveConfig(asCaller("admin-1"))
          .pipe(Effect.provide(Password.config({ minLength: 40 })));
        const password = items.find((item) => item.key === "awthaq/password/Config");
        assert.strictEqual(
          password?.entries.find((entry) => entry.path === "minLength")?.value,
          "40",
        );
        assert.strictEqual(password?.scope, "tenant");
        assert.strictEqual(password?.source, "tenant");
        // A deployment-scoped key stays the build value, and no secret leaks under a tenant either.
        const chain = items.find((item) => item.key === "awthaq/core/AuditChainConfig");
        assert.strictEqual(chain?.scope, "deployment");
        assert.notInclude(JSON.stringify(items), CANARY);
      }).pipe(Effect.scoped, Effect.provide(passwordLayer)),
  );

  // The harness provides the composition's layer to the test fiber too, so `source` reads "tenant" here; the value
  // is the build value, which is what this pins.
  it.effect("with no calling override the view reports the build value", () =>
    Effect.gen(function* () {
      const admin = yield* Admin.Admin;
      const items = yield* admin.effectiveConfig(asCaller("admin-1"));
      const password = items.find((item) => item.key === "awthaq/password/Config");
      assert.strictEqual(
        password?.entries.find((entry) => entry.path === "minLength")?.value,
        "12",
      );
      assert.strictEqual(password?.scope, "tenant");
    }).pipe(Effect.scoped, Effect.provide(passwordLayer)),
  );
});
