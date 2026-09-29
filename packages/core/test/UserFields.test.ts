// SAM-004/BE-007 (BEH-EA-040, BEH-EA-048; ADR-EA-035): the `userFields` extension point end to end —
// a plugin declares typed scalar fields, the linker generates their columns (dialect-neutral), `Users`
// reads and writes them with client/server gating, and the composition types them.
//
// The same read/write suite runs against both `Users` layers: `layerMemory` (a `Ref`) and `layerSql` over
// migrated SQLite (real Postgres under `pnpm run test:pg`) — where the columns come from `Auth.make`'s own
// generated migrations, not a hand-written `ALTER TABLE`.
import { CoreMigrations, Repositories } from "@awthaq/sql";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expectTypeOf } from "vitest";
import * as TestSql from "../../sql/test/support/TestSql.ts";
import * as Auth from "../src/Auth.ts";
import * as AuthPlugin from "../src/AuthPlugin.ts";
import * as Hooks from "../src/Hooks.ts";
import * as Migrations from "../src/Migrations.ts";
import * as UserFields from "../src/UserFields.ts";
import * as Users from "../src/Users.ts";

// --- Billing: a toy plugin that adds three fields to `users` ----------------

const BillingApi = HttpApi.make("auth").add(
  HttpApiGroup.make("billing").add(
    HttpApiEndpoint.get("plan", "/billing/plan", { success: Schema.String }),
  ),
);

interface BillingShape {
  readonly plan: () => Effect.Effect<string>;
}

class Billing extends AuthPlugin.Service<Billing, BillingShape>()("billing", {
  apiVersion: 1,
  contract: BillingApi,
  userFields: {
    // A system-authority field: only trusted server code may write it (BEH-EA-048).
    plan: UserFields.serverOnly(Schema.Literals(["free", "pro"])),
    // Client-writable by default.
    nickname: UserFields.field(Schema.String),
    seats: UserFields.field(Schema.Number),
    newsletter: UserFields.field(Schema.Boolean),
  },
}) {
  static readonly layer = AuthPlugin.layer(Billing, {
    make: Effect.succeed({ plan: () => Effect.succeed("free") }),
    handlers: HttpApiBuilder.group(BillingApi, "billing", (handlers) =>
      handlers.handle("plan", () => Effect.succeed("free")),
    ),
  });
}

const auth = Auth.make([Billing]);

// --- the plugin-authoring contract ------------------------------------------

describe("userFields declaration (BEH-EA-040)", () => {
  it("Auth.make composes the declared fields, typed by `<plugin id>_<field>`", () => {
    assert.deepStrictEqual(Object.keys(auth.userFields).sort(), [
      "billing_newsletter",
      "billing_nickname",
      "billing_plan",
      "billing_seats",
    ]);
    // The type of the composed record is the declared schemas under prefixed keys.
    expectTypeOf(auth.userFields.billing_plan.Type).toEqualTypeOf<"free" | "pro">();
    expectTypeOf(auth.userFields.billing_nickname.Type).toEqualTypeOf<string>();
    // @ts-expect-error a field nobody declared is not a key of the composed record
    void auth.userFields.billing_missing;
  });

  it("the manifest reports each column, kind and writability without building a layer", () => {
    assert.deepStrictEqual(
      auth.manifest.userFields.map(({ key, kind, clientWritable }) => [key, kind, clientWritable]),
      [
        ["billing_plan", "text", false],
        ["billing_nickname", "text", true],
        ["billing_seats", "real", true],
        ["billing_newsletter", "boolean", true],
      ],
    );
  });

  it("the linker generates one migration per field, after every hand-written one, named under the plugin", () => {
    assert.deepStrictEqual(
      auth.migrations.map((migration) => migration.name),
      [
        "0001_billing_add_user_field_plan",
        "0002_billing_add_user_field_nickname",
        "0003_billing_add_user_field_seats",
        "0004_billing_add_user_field_newsletter",
      ],
    );
  });

  it("a plugin that declares no field composes exactly as before", () => {
    class Plain extends AuthPlugin.Service<Plain, BillingShape>()("plain", {
      apiVersion: 1,
      contract: HttpApi.make("auth").add(
        HttpApiGroup.make("plain").add(
          HttpApiEndpoint.get("plain", "/plain", { success: Schema.String }),
        ),
      ),
    }) {}
    assert.deepStrictEqual(Plain.userFields, {});
  });

  it("a schema that does not encode to one scalar is refused where the plugin is defined", () => {
    const defineWith = (userFields: UserFields.Declarations) => () =>
      UserFields.describePlugin("billing", userFields);
    // @ts-expect-error an array does not encode to a scalar: the type refuses it before the runtime does
    assert.throws(defineWith({ tags: Schema.Array(Schema.String) }), /scalar/);
    assert.throws(defineWith({ mixed: Schema.Union([Schema.String, Schema.Number]) }), /scalar/);
    assert.throws(defineWith({ "not-an-identifier": Schema.String }), /plain identifier/);
    assert.throws(defineWith({ [`x${"y".repeat(60)}`]: Schema.String }), /63 characters/);
  });

  it("a decoded type may differ from the stored scalar (NumberFromString is a text column)", () => {
    const [descriptor] = UserFields.describePlugin("billing", { amount: Schema.NumberFromString });
    assert.strictEqual(descriptor?.kind, "text");
  });

  it.effect("the client types offer only the client-writable fields (BEH-EA-048), encoded for the wire", () =>
    Effect.gen(function* () {
      const profile = UserFields.client(auth.userFields);
      const wire = yield* profile.encode({ billing_nickname: "Ada", billing_seats: 2, billing_newsletter: null });
      assert.deepStrictEqual(wire, { billing_nickname: "Ada", billing_seats: 2, billing_newsletter: null });
      // @ts-expect-error `billing_plan` is server-only: it is not a key of what a client may write
      yield* profile.encode({ billing_plan: "pro" });
      expectTypeOf<UserFields.ClientWritableKeys<typeof auth.userFields>>().toEqualTypeOf<
        "billing_nickname" | "billing_seats" | "billing_newsletter"
      >();
      // Reading is not gated: a user may see a value they may not write.
      const read = yield* profile.decode({ billing_plan: "pro", billing_seats: 2 });
      expectTypeOf(read.billing_plan).toEqualTypeOf<"free" | "pro" | undefined>();
      assert.strictEqual(read.billing_plan, "pro");
    }),
  );

  it("two declarations that would share a column are refused when composed", () => {
    assert.throws(
      () =>
        UserFields.describeAll({
          a_b_c: Schema.String,
          "a.b_c": Schema.String,
        }),
      /share the column/,
    );
  });
});

// --- Users: the same suite over both layers ---------------------------------

const registryLayer = UserFields.layer(auth.userFields);

const MemoryLayer = Users.layerMemory.pipe(
  Layer.provide(NodeCrypto.layer),
  Layer.provide(Hooks.BeforeUserDelete.layer),
  Layer.provide(registryLayer),
);

const SqlLive = TestSql.layer("core_UserFields");

// Core's migrations, then the linker's generated ones from the plugin ledger, exactly as a runner does.
const Migrated = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Migrator.make({})({ loader: CoreMigrations.coreMigrations });
    yield* Migrations.run(auth.migrations);
  }),
).pipe(Layer.provide(SqlLive));

const SqlTestLayer = Users.layerSql.pipe(
  Layer.provide(Repositories.UsersRepositoryLive),
  Layer.provide(Hooks.BeforeUserDelete.layer),
  Layer.provide(registryLayer),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const newUser = Effect.gen(function* () {
  const users = yield* Users.Users;
  return yield* users.create({ identity: { _tag: "Email", email: "ada@example.com" }, name: "Ada" });
});

const suite = (name: string, layer: Layer.Layer<Users.Users, unknown, never>): void => {
  describe(name, () => {
    it.effect("an unset user has no fields; setFields round-trips every kind and clears with null", () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const user = yield* newUser;
        assert.deepStrictEqual(yield* users.getFields(user.id), {});

        const after = yield* users.setFields(user.id, {
          billing_plan: "pro",
          billing_nickname: "Countess",
          billing_seats: 3.5,
          billing_newsletter: true,
        });
        assert.deepStrictEqual(after, {
          billing_plan: "pro",
          billing_nickname: "Countess",
          billing_seats: 3.5,
          billing_newsletter: true,
        });
        assert.deepStrictEqual(yield* users.getFields(user.id, ["billing_nickname"]), {
          billing_nickname: "Countess",
        });

        // `false` is a value, not "unset"; `null` clears.
        const cleared = yield* users.setFields(user.id, {
          billing_newsletter: false,
          billing_nickname: null,
        });
        assert.deepStrictEqual(cleared, {
          billing_plan: "pro",
          billing_seats: 3.5,
          billing_newsletter: false,
        });
      }).pipe(Effect.provide(layer)),
    );

    it.effect("BEH-EA-048: a client may write a client-writable field but never a server-only one", () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const user = yield* newUser;
        yield* users.setFields(user.id, { billing_nickname: "Ada" }, { source: "client" });

        const refused = yield* users
          .setFields(user.id, { billing_nickname: "Changed", billing_plan: "pro" }, { source: "client" })
          .pipe(Effect.flip);
        assert.strictEqual(refused._tag, "UserFieldNotWritable");
        if (refused._tag === "UserFieldNotWritable") assert.strictEqual(refused.field, "billing_plan");
        // Validated as a whole before anything is stored: the allowed field in the refused patch did not land.
        assert.deepStrictEqual(yield* users.getFields(user.id), { billing_nickname: "Ada" });

        // Trusted server code (the default source) may write it.
        yield* users.setFields(user.id, { billing_plan: "pro" });
        assert.deepStrictEqual(yield* users.getFields(user.id, ["billing_plan"]), {
          billing_plan: "pro",
        });
      }).pipe(Effect.provide(layer)),
    );

    it.effect("an undeclared key, a value the schema refuses and an unknown user are typed failures", () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const user = yield* newUser;
        const unknown = yield* users.setFields(user.id, { billing_missing: "x" }).pipe(Effect.flip);
        assert.strictEqual(unknown._tag, "UnknownUserField");
        const unknownRead = yield* users.getFields(user.id, ["billing_missing"]).pipe(Effect.flip);
        assert.strictEqual(unknownRead._tag, "UnknownUserField");
        const invalid = yield* users.setFields(user.id, { billing_plan: "enterprise" }).pipe(Effect.flip);
        assert.strictEqual(invalid._tag, "InvalidUserField");
        const wrongKind = yield* users.setFields(user.id, { billing_seats: "many" }).pipe(Effect.flip);
        assert.strictEqual(wrongKind._tag, "InvalidUserField");
        const ghost = Users.UserId("99999999-9999-9999-9999-999999999999");
        const missing = yield* users.setFields(ghost, { billing_nickname: "x" }).pipe(Effect.flip);
        assert.strictEqual(missing._tag, "UserNotFound");
        const missingRead = yield* users.getFields(ghost).pipe(Effect.flip);
        assert.strictEqual(missingRead._tag, "UserNotFound");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("typedFields decodes reads and encodes writes with the declared types", () =>
      Effect.gen(function* () {
        const user = yield* newUser;
        const billing = Users.typedFields(auth.userFields);
        const written = yield* billing.set(user.id, { billing_plan: "pro", billing_seats: 4 });
        expectTypeOf(written.billing_plan).toEqualTypeOf<"free" | "pro" | undefined>();
        expectTypeOf(written.billing_seats).toEqualTypeOf<number | undefined>();
        assert.strictEqual(written.billing_plan, "pro");
        const read = yield* billing.get(user.id);
        assert.strictEqual(read.billing_seats, 4);
        assert.isUndefined(read.billing_nickname);
        // A wrong type does not compile.
        // @ts-expect-error `plan` is "free" | "pro"
        const wrong = billing.set(user.id, { billing_plan: "enterprise" });
        void wrong;
        // The typed accessor is server-trusted unless told otherwise.
        const clientRefusal = yield* billing
          .set(user.id, { billing_plan: "free" }, { source: "client" })
          .pipe(Effect.flip);
        assert.strictEqual(clientRefusal._tag, "UserFieldNotWritable");
        const clientAllowed = yield* billing.set(
          user.id,
          { billing_nickname: "Ada" },
          { source: "client" },
        );
        assert.strictEqual(clientAllowed.billing_nickname, "Ada");
      }).pipe(Effect.provide(layer)),
    );
  });
};

suite("UserFields over Users.layerMemory", MemoryLayer);
suite("UserFields over Users.layerSql (migrated by Auth.make's generated migrations)", SqlTestLayer);

describe("UserFields over Users.layerSql: the generated columns", () => {
  it.effect("are nullable scalar columns added to `users`, and only those", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const user = yield* newUser;
      const rows = yield* sql`SELECT * FROM users WHERE id = ${user.id}`;
      const [row] = rows;
      assert.isDefined(row);
      for (const column of ["billing_plan", "billing_nickname", "billing_seats", "billing_newsletter"]) {
        assert.isTrue(column in (row ?? {}), column);
        assert.isNull(row?.[column]);
      }
    }).pipe(Effect.provide(SqlTestLayer)),
  );

  it.effect("a deleted user's fields do not resurrect on a re-created id", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const user = yield* newUser;
      yield* users.setFields(user.id, { billing_nickname: "Ada" });
      yield* users.delete(user.id);
      const gone = yield* users.getFields(user.id).pipe(Effect.flip);
      assert.strictEqual(gone._tag, "UserNotFound");
      const again = yield* newUser;
      assert.deepStrictEqual(yield* users.getFields(again.id), {});
      assert.isTrue(Option.isSome(Option.some(again)));
    }).pipe(Effect.provide(MemoryLayer)),
  );
});
