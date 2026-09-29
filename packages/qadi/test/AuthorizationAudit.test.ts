// YL-004 (BEH-EA-156): the composition-time counterpart of `RequirePermission`'s
// per-request refusal — an un-annotated endpoint in a guarded group is found at
// startup, naming the route, instead of answering 500 to the first caller.
import { assert, describe, it } from "@effect/vitest";
import {
  PublicEndpoint,
  RequirePermission,
  RequiredPermission,
  publicEndpoint,
  requiresPermission,
} from "@qadi/http";
import { hasRole, permission } from "@qadi/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as AuthorizationAudit from "../src/AuthorizationAudit.ts";

const stats = permission("stats", "read");

describe("auditAuthorizationAnnotations (YL-004)", () => {
  it.effect("reports an endpoint in a guarded group that has neither annotation", () =>
    Effect.gen(function* () {
      const api = HttpApi.make("audit-test").add(
        HttpApiGroup.make("admin")
          .add(
            HttpApiEndpoint.get("stats", "/stats", { success: Schema.Void }).pipe((e) =>
              e.annotate(
                RequiredPermission,
                requiresPermission(e, { permission: stats, policy: hasRole("admin") }),
              ),
            ),
          )
          .add(
            HttpApiEndpoint.get("health", "/health", { success: Schema.Void }).pipe((e) =>
              e.annotate(PublicEndpoint, publicEndpoint("liveness probe")),
            ),
          )
          .add(HttpApiEndpoint.get("forgotten", "/forgotten", { success: Schema.Void }))
          .middleware(RequirePermission),
      );

      const failure = yield* AuthorizationAudit.auditAuthorizationAnnotations(api).pipe(
        Effect.flip,
      );
      assert.strictEqual(failure._tag, "UnannotatedEndpoints");
      assert.deepStrictEqual(failure.endpoints, [
        { group: "admin", method: "GET", path: "/forgotten" },
      ]);
      assert.include(failure.message, "GET /forgotten");
    }),
  );

  it.effect(
    "succeeds when every guarded endpoint requires a permission or is declared public",
    () =>
      Effect.gen(function* () {
        const api = HttpApi.make("audit-test").add(
          HttpApiGroup.make("admin")
            .add(
              HttpApiEndpoint.get("stats", "/stats", { success: Schema.Void }).pipe((e) =>
                e.annotate(
                  RequiredPermission,
                  requiresPermission(e, { permission: stats, policy: hasRole("admin") }),
                ),
              ),
            )
            .add(
              HttpApiEndpoint.get("health", "/health", { success: Schema.Void }).pipe((e) =>
                e.annotate(PublicEndpoint, publicEndpoint("liveness probe")),
              ),
            )
            .middleware(RequirePermission),
        );
        yield* AuthorizationAudit.auditAuthorizationAnnotations(api);
      }),
  );

  it.effect("ignores endpoints outside a RequirePermission-guarded group", () =>
    Effect.gen(function* () {
      const api = HttpApi.make("audit-test").add(
        HttpApiGroup.make("open").add(
          HttpApiEndpoint.get("anything", "/anything", { success: Schema.Void }),
        ),
      );
      yield* AuthorizationAudit.auditAuthorizationAnnotations(api);
    }),
  );
});
