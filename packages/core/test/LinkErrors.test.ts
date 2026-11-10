// BEH-EA-201: `Auth.isLinkError` is how the CLI loader tells a link problem from any other load failure.
// A trigger table (typed against the union, so a new tag fails typecheck until it has a trigger) proves each
// tag is raised and recognised; a source scan proves no tagged error on the composition path is left out.
import { SealedColumn } from "@awthaq/sql";
import { SessionLifecycle } from "@awthaq/api";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import { readFileSync } from "node:fs";
import * as Auth from "../src/Auth.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import * as AuthPlugin from "../src/AuthPlugin.ts";
import * as HookPoint from "../src/HookPoint.ts";
import * as UserFields from "../src/UserFields.ts";

// A hand-built plugin value (the shape `AuthPlugin.Any` names), so each trigger states only what it breaks.
const raw = (id: string, extra: Partial<AuthPlugin.Any> = {}): AuthPlugin.Any => ({
  id,
  apiVersion: 1,
  contract: { identifier: "auth", groups: {} },
  tables: [],
  migrations: [],
  dependsOn: [],
  layer: Layer.empty,
  ...extra,
});

const make = (...plugins: readonly [AuthPlugin.Any, ...ReadonlyArray<AuthPlugin.Any>]) =>
  Auth.make(plugins);

const withGroup = (group: HttpApiGroup.Constraint) => HttpApi.make("auth").add(group);

class Twin extends AuthPlugin.Service<Twin, Record<string, never>>()("twin", {
  apiVersion: 1,
  contract: HttpApi.make("auth"),
}) {}

class Other extends AuthPlugin.Service<Other, Record<string, never>>()("other", {
  apiVersion: 1,
  contract: HttpApi.make("auth"),
}) {
  static readonly layer = AuthPlugin.layer(Other, { make: Effect.succeed({}) });
}

const field = UserFields.field(Schema.String);

const triggers = {
  CircularPluginDependency: () => {
    // Getters, as a circular import between two plugin modules would give.
    const ping: AuthPlugin.Any = {
      ...raw("ping"),
      get dependsOn() {
        return [pong];
      },
    };
    const pong: AuthPlugin.Any = {
      ...raw("pong"),
      get dependsOn() {
        return [ping];
      },
    };
    return make(ping, pong);
  },
  // Auth.make's type refuses `[]`; the runtime backstop is what a config module written in JS reaches.
  EmptyPluginTuple: () => {
    // @ts-expect-error - Auth.make requires at least one plugin
    return make();
  },
  GroupIdConflict: () =>
    make(raw("imposter", { contract: withGroup(HttpApiGroup.make("session")) })),
  RouteConflict: () =>
    make(
      raw("imposter", {
        contract: withGroup(
          HttpApiGroup.make("imposter").add(
            HttpApiEndpoint.get("list", "/session/list", { success: Schema.String }),
          ),
        ),
      }),
    ),
  // An internal invariant `Auth.make` cannot be driven into from a well-formed input: constructed, not provoked.
  LinkerInvariantViolation: () => {
    throw new Auth.LinkerInvariantViolation({ message: "awthaq: internal error" });
  },
  UndeclaredTableDependency: () =>
    make(raw("owner", { tables: ["owner_t"] }), raw("reader", { readsTables: ["owner_t"] })),
  "Auth/TenancyDeclarationInvalid": () =>
    make(
      raw("bad", {
        tables: ["bad_x"],
        tenancy: { bad_x: AuthPlugin.Table.partitioned('tenant"; DROP') },
      }),
    ),
  "Auth/SealedColumnDeclarationInvalid": () =>
    make(
      raw("mine", {
        sealedColumns: [SealedColumn.column({ table: "other_a", column: "secret", key: "id" })],
      }),
    ),
  "Auth/MigrationDeclarationInvalid": () =>
    make(
      raw("twice", {
        migrations: [
          { name: "m", up: Effect.void },
          { name: "m", up: Effect.void },
        ],
      }),
    ),
  "Auth/EventTagConflict": () => make(raw("thief", { events: [AuthEvents.UserCreatedEvent] })),
  "UserFields/InvalidDeclaration": () =>
    make(raw("fielded", { userFields: { "bad-name": field } })),
  // `a.b_x` and `a_b_x` are one column (dots become underscores).
  UserFieldConflict: () =>
    make(raw("a.b", { userFields: { x: field } }), raw("a_b", { userFields: { x: field } })),
  ConflictingDependsOn: () => {
    AuthPlugin.layer(Twin, { make: Effect.succeed({}) });
    return AuthPlugin.layer(Twin, { dependsOn: [Other], make: Effect.succeed({}) });
  },
  "SealedColumn/InvalidDeclaration": () =>
    SealedColumn.column({ table: "not an identifier", column: "x", key: "id" }),
  "SessionLifecycle/Conflict": () =>
    make(
      raw("twice", {
        contract: withGroup(
          HttpApiGroup.make("g").add(
            HttpApiEndpoint.post("both", "/both")
              .middleware(SessionLifecycle.Mints)
              .middleware(SessionLifecycle.Ends),
          ),
        ),
      }),
    ),
} satisfies Record<Auth.LinkError["_tag"], () => unknown>;

const thrownBy = (thunk: () => unknown): unknown => {
  try {
    thunk();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("Auth.isLinkError (BEH-EA-201)", () => {
  for (const [tag, trigger] of Object.entries(triggers)) {
    it(`recognises ${tag} as raised`, () => {
      const thrown = thrownBy(trigger);
      assert.isTrue(Auth.isLinkError(thrown));
      assert.strictEqual(Auth.isLinkError(thrown) ? thrown._tag : undefined, tag);
    });
  }

  it("recognises no tag the trigger table does not own, and no tag the table lacks", () => {
    assert.deepStrictEqual(Object.keys(triggers).sort(), Object.keys(Auth.linkErrorTags).sort());
  });

  it("rejects everything that is not a link error", () => {
    assert.isFalse(Auth.isLinkError(new HookPoint.HookPointFrozen({ point: "p", message: "x" })));
    assert.isFalse(Auth.isLinkError(new Error("x")));
    assert.isFalse(Auth.isLinkError(null));
    assert.isFalse(Auth.isLinkError("RouteConflict"));
    assert.isFalse(Auth.isLinkError({ _tag: "toString" }));
  });

  it("covers every tagged error declared where the composition path raises", () => {
    const files = [
      "core/src/Auth.ts",
      "core/src/AuthPlugin.ts",
      "core/src/UserFields.ts",
      "sql/src/SealedColumn.ts",
      "api/src/SessionLifecycle.ts",
    ];
    const declared = new Set(
      files.flatMap((file) =>
        [
          ...readFileSync(new URL(`../../${file}`, import.meta.url), "utf8").matchAll(
            /Data\.TaggedError\(\s*"([^"]+)"/g,
          ),
        ].map((match) => match[1]),
      ),
    );
    assert.isAtLeast(declared.size, 15);
    assert.deepStrictEqual([...declared].sort(), Object.keys(Auth.linkErrorTags).sort());
  });
});
