// P20a/AH-003, decision 36 Tier 4: 01-contract-and-persistence/05-persistence-stratum.feature
// (BEH-EA-033..036 here; pagination is in this file's sibling `PersistenceKeysetSteps.ts` and the
// migration Rules BEH-EA-037..040 in `PersistenceMigrationSteps.ts`). Entities and store adapters
// run against a real in-memory SQLite database migrated by the framework `Migrator`
// (`PersistenceStratumWorld.ts`). Scenarios whose behavior does not exist yet (INV-EA-016's
// ownership validation) or needs another World (REQ-EA-092) stay `@skip` in the feature.
import { TestEncryption } from "@awthaq/test";
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Accounts, AuthEvents, Persistence, Users } from "@awthaq/core";
import { AuthHttp } from "@awthaq/server";
import { Ids, Sealed, SessionStore, UserStore, AccountStore } from "@awthaq/ports";
import { SealedColumn, UserStoreSql } from "@awthaq/sql";
import { RedactionGuard } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { cell, put, take, type World } from "./FoundationsWorld.ts";
import {
  collectSpans,
  insertAccount,
  insertUser,
  M,
  MemoryUsersLive,
  StoresLive,
  sealedStack,
  withDatabase,
} from "./PersistenceStratumWorld.ts";
import * as HttpServer from "effect/unstable/http/HttpServer";

/** Every SQL store over the ambient `SqlClient` (plan 02): provide it where the composition is built. */
const SqlStores = Persistence.sql().pipe(Layer.provide(TestEncryption.layer));

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANARY = "canary-access-token-9f8e7d6c5b4a";

const strings = cell("strings", (value): value is ReadonlyArray<string> => Array.isArray(value));
const numbers = cell("numbers", (value): value is ReadonlyArray<number> => Array.isArray(value));
const flag = cell("flag", (value): value is boolean => typeof value === "boolean");
const entity = cell("entity", (value): value is string => typeof value === "string");
const jsonText = cell("jsonText", (value): value is string => typeof value === "string");

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

/** The entity class a scenario's quoted name refers to. */
const entityNamed = (name: string) => {
  switch (name) {
    case "User":
      return M.User;
    case "Account":
      return M.Account;
    case "Session":
      return M.Session;
    case "VerificationToken":
      return M.VerificationToken;
    default:
      throw new Error(`"${name}" is not a core entity`);
  }
};

const VARIANTS = ["select", "insert", "update", "json", "jsonCreate", "jsonUpdate"];

export const persistenceStratumSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- BEH-EA-033: Model.Class entities, supplier-assigned UUIDv7 ids ----

  Given("the {string} entity definition", function* (name: string) {
    yield* put(entity, name);
  });

  When("the definition is inspected", function* () {
    entityNamed(yield* take(entity));
  });

  Then("{string} is declared as a Model.Class", function* (name: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
    const definition = entityNamed(name);
    // A `Model.Class` carries every derived variant — database and JSON — off one field declaration.
    for (const variant of VARIANTS) {
      assert.ok(variant in definition, `${name} has a ${variant} variant`);
    }
    assert.ok("id" in definition.fields, `${name} declares an id field`);
  });

  Given("a new {string} is created through the ordinary creation path", function* (name: string) {
    yield* put(entity, name);
  });

  When("the row is inserted", function* () {
    assert.equal(yield* take(entity), "User");
    const created = yield* withDatabase(insertUser("uuid@example.com"));
    yield* put(strings, [created.id]);
  });

  Then(
    "the {string} column is assigned a Model.UuidV7Insert value by the supplier",
    function* (column: string) {
      assert.equal(column, "id");
      const [id] = yield* take(strings);
      assert.ok(id !== undefined);
      assert.match(id, UUID_V7);
    },
  );

  Given(
    "a creation request for a {string} that includes an {string} field chosen by the caller",
    function* (name: string, field: string) {
      yield* Effect.void; // an assertion-only step: nothing to await
      assert.deepEqual([name, field], ["User", "id"]);
    },
  );

  When("the entity is created through the ordinary creation path", function* () {
    // The ordinary creation path is the domain service: its input has no place for an id.
    const callerChosen = { id: "caller-chosen-id" };
    const created = yield* Effect.gen(function* () {
      const users = yield* Users.Users;
      // Spread from a variable: the id rides along past the compiler, as it would from untyped input.
      return yield* users.create({
        identity: { _tag: "Email", email: "chosen@example.com" },
        name: "Chosen",
        ...callerChosen,
      });
    }).pipe(Effect.provide(MemoryUsersLive));
    yield* put(strings, [created.id, callerChosen.id]);
  });

  Then(
    "the caller-supplied {string} is not the id assigned to the created row",
    function* (field: string) {
      assert.equal(field, "id");
      const [assigned, supplied] = yield* take(strings);
      assert.notEqual(assigned, supplied);
      assert.match(assigned ?? "", UUID_V7);
    },
  );

  // ---- BEH-EA-034: Model.Sensitive fields ----

  Given(
    "an {string} entity whose {string} field is declared Model.Sensitive",
    function* (name: string, field: string) {
      yield* Effect.void; // an assertion-only step: nothing to await
      assert.equal(name, "Account");
      // Sensitive: a stored column of the database variant, absent from every JSON variant.
      assert.ok(field in M.Account.fields);
      assert.ok(field in M.Account.select.fields, `${field} is a stored column`);
      assert.ok(!(field in M.Account.json.fields), `${field} is not in the JSON variant`);
    },
  );

  When("the entity is encoded to its JSON variant", function* () {
    const encoded = yield* withDatabase(
      Effect.gen(function* () {
        const user = yield* insertUser("sens@example.com");
        const account = yield* insertAccount({
          userId: user.id,
          providerId: "password",
          subject: user.id,
          passwordHash: "super-secret-hash",
          accessToken: null,
        });
        // The stored row does hold the hash: the JSON variant is what must hide it.
        assert.equal(account.passwordHash, "super-secret-hash");
        return yield* Schema.encodeUnknownEffect(M.Account.json)(account);
      }),
    );
    yield* put(jsonText, JSON.stringify(encoded));
  });

  Then("the {string} field does not appear in the encoded JSON", function* (field: string) {
    const text = yield* take(jsonText);
    assert.ok(!text.includes(`"${field}"`), text);
    assert.ok(!text.includes("super-secret-hash"), text);
    // Not vacuous: the encoding really is the account.
    assert.ok(text.includes('"providerId":"password"'), text);
  });

  Given(
    "a handler that returns an {string} entity value directly as its response",
    function* (name: string) {
      yield* Effect.void; // an assertion-only step: nothing to await
      assert.equal(name, "Account");
    },
  );

  When("the response is serialized", function* () {
    const LeakApi = HttpApi.make("leak").add(
      HttpApiGroup.make("leak").add(
        HttpApiEndpoint.get("account", "/account", { success: M.Account.json }),
      ),
    );
    const Handlers = HttpApiBuilder.group(LeakApi, "leak", (handlers) =>
      handlers.handle("account", () =>
        Effect.gen(function* () {
          const user = yield* insertUser("leak@example.com");
          // The whole entity — secrets included — is what the handler hands back.
          return yield* insertAccount({
            userId: user.id,
            providerId: "github",
            subject: "gh-leak",
            passwordHash: "wire-secret-hash",
            accessToken: "wire-secret-access",
          });
        }).pipe(Effect.orDie),
      ),
    );
    const appLayer = AuthHttp.routes(LeakApi).pipe(
      Layer.provide(Handlers),
      Layer.provideMerge(StoresLive),
      Layer.provideMerge(HttpServer.layerServices),
      Layer.provideMerge(HttpRouter.layer),
    );
    const { handler } = HttpRouter.toWebHandler(appLayer);
    const response = yield* Effect.promise(() => handler(new Request("http://localhost/account")));
    assert.equal(response.status, 200);
    yield* put(jsonText, yield* Effect.promise(() => response.text()));
  });

  Then(
    "the {string} and {string} fields are absent from the HTTP response",
    function* (first: string, second: string) {
      assert.deepEqual([first, second], ["passwordHash", "accessToken"]);
      const text = yield* take(jsonText);
      for (const field of [first, second, "refreshToken"]) {
        assert.ok(!text.includes(`"${field}"`), text);
      }
      for (const secret of ["wire-secret-hash", "wire-secret-access", "wire-secret-refresh"]) {
        assert.ok(!text.includes(secret), text);
      }
      // Not vacuous: the response really is the account.
      assert.ok(text.includes('"providerId":"github"'), text);
    },
  );

  When("the entity passes through logging, tracing spans, and emitted events", function* () {
    const layer = Accounts.layer
      .pipe(Layer.provide(SqlStores))
      .pipe(Layer.provideMerge(Layer.mergeAll(StoresLive, RedactionGuard.layer, NodeCrypto.layer)));
    const outcome = yield* Effect.gen(function* () {
      const guard = yield* RedactionGuard.RedactionGuard;
      yield* guard.watch("accessToken", CANARY);
      const accounts = yield* AccountStore.AccountStore;
      const domain = yield* Accounts.Accounts;
      const user = yield* insertUser("spans@example.com");
      // The stored entity, secret included, through the store's own (traced) primitives...
      const account = yield* insertAccount({
        userId: user.id,
        providerId: "github",
        subject: "gh-spans",
        passwordHash: null,
        accessToken: CANARY,
      });
      yield* accounts.readProviderTokens(account.id);
      yield* accounts.listByUser(user.id);
      // ...and the domain service a real sign-in reaches it through.
      yield* domain.link({
        userId: Users.UserId(user.id),
        providerId: "github",
        subject: "gh-domain",
        tokens: {
          accessToken: Redacted.make(CANARY),
          refreshToken: Option.none(),
          idToken: Option.none(),
          accessTokenExpiresAt: Option.none(),
          refreshTokenExpiresAt: Option.none(),
          scope: Option.none(),
          tokenType: Option.none(),
        },
      });
      yield* domain.findByProviderSubject("github", "gh-domain");
      yield* Effect.logInfo(`account ${account.id} linked for ${user.id}`);
      return yield* Effect.exit(guard.assertNoLeaks);
    }).pipe(Effect.provide(layer));
    yield* put(flag, outcome._tag === "Success");
  });

  Then("no Redacted value for {string} reaches any log, span, or event", function* (field: string) {
    assert.equal(field, "accessToken");
    assert.equal(yield* take(flag), true);
    // The guard is not vacuous: the same canary in a log line is a leak.
    const control = yield* Effect.gen(function* () {
      const guard = yield* RedactionGuard.RedactionGuard;
      yield* guard.watch("accessToken", CANARY);
      yield* Effect.logInfo(`token=${CANARY}`);
      return yield* Effect.exit(guard.assertNoLeaks);
    }).pipe(Effect.provide(RedactionGuard.layer));
    assert.equal(control._tag, "Failure");
    // Events: no published event schema has a place to carry a token or hash at all.
    for (const member of AuthEvents.AuthEventSchema.members) {
      for (const name of Object.keys(member.fields)) {
        assert.ok(
          !["passwordHash", "accessToken", "refreshToken", "idToken"].includes(name),
          `an event schema (${Object.keys(member.fields).join(", ")}) carries a secret-shaped field "${name}"`,
        );
      }
    }
  });

  // ---- BEH-EA-035: store adapters over the ambient SqlClient ----

  Given(
    "the {string} adapter built with SqlModel.makeRepository against the ambient SqlClient",
    function* (name: string) {
      yield* Effect.void; // an assertion-only step: nothing to await
      assert.equal(name, "UserStoreSql");
      assert.match(source("../../packages/sql/src/UserStoreSql.ts"), /SqlModel\.makeRepository\(/);
    },
  );

  When("the adapter is resolved", function* () {
    // The adapter's layer needs nothing but the ambient `SqlClient`: `withDatabase` provides only that.
    const key = yield* withDatabase(
      Effect.provide(
        Effect.map(UserStore.UserStore, () => UserStore.UserStore.key),
        UserStoreSql.layer,
      ),
    );
    yield* put(strings, [key]);
  });

  Then(
    "it provides the {string} port from a layer that needs only the SqlClient",
    function* (port: string) {
      const [key] = yield* take(strings);
      assert.equal(typeof key, "string");
      // Resolved by `yield* UserStore` from a Layer needing nothing but the ambient `SqlClient`.
      assert.equal(port, "UserStore");
      assert.equal(key, UserStore.UserStore.key);
    },
  );

  Given(
    "store primitives that read or write a {string} row and an {string} row",
    function* (first: string, second: string) {
      yield* Effect.void; // an assertion-only step: nothing to await
      assert.deepEqual([first, second], ["User", "Account"]);
    },
  );

  When("the primitives execute", function* () {
    const transactionSpans = (spans: ReadonlyArray<{ readonly name: string }>) =>
      spans.filter((span) => span.name === "sql.transaction").length;
    const single = collectSpans();
    const multi = collectSpans();
    const wrapped = collectSpans();
    yield* withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const users = yield* UserStore.UserStore;
        const accounts = yield* AccountStore.AccountStore;
        const user = yield* insertUser("plain@example.com");
        const account = yield* insertAccount({
          userId: user.id,
          providerId: "github",
          subject: "plain-subject",
          passwordHash: null,
          accessToken: null,
        });
        // A single-statement primitive opens no transaction of its own...
        yield* Effect.provideService(
          users.getByEmail("plain@example.com"),
          Tracer.Tracer,
          single.tracer,
        );
        // ...a multi-statement one opens exactly one unit...
        yield* Effect.provideService(
          accounts.deleteUnlessLast(account.id, true),
          Tracer.Tracer,
          multi.tracer,
        );
        // ...and the control: the same kind of call inside an explicit transaction *does* open the span.
        yield* Effect.provideService(
          sql.withTransaction(insertUser("wrapped@example.com")),
          Tracer.Tracer,
          wrapped.tracer,
        );
      }),
    );
    yield* put(numbers, [
      transactionSpans(single.spans),
      transactionSpans(multi.spans),
      transactionSpans(wrapped.spans),
      single.spans.filter((span) => span.name.startsWith("Users.")).length,
    ]);
  });

  Then(
    "the single-statement one opens no transaction and the multi-statement one opens exactly one",
    function* () {
      const [singleTransactions, multiTransactions, controlTransactions, storeSpans] =
        yield* take(numbers);
      assert.equal(singleTransactions, 0, "a single-statement primitive opened no transaction");
      assert.equal(multiTransactions, 1, "a multi-statement primitive opened exactly one unit");
      assert.ok((controlTransactions ?? 0) > 0, "an explicit withTransaction is visible as a span");
      assert.ok((storeSpans ?? 0) > 0, "the primitive really ran under the tracer");
    },
  );

  // ---- BEH-EA-339: a composition's sealed columns are swept as one list (plan 17) ----

  const rotation = cell(
    "sealedRotation",
    (value): value is { readonly opened: ReadonlyArray<boolean>; readonly secondPass: number } =>
      typeof value === "object" && value !== null,
  );

  Given(
    "a user with metadata, a session and a linked account, sealed under the key {string}",
    function* (kid: string) {
      yield* Effect.void; // an assertion-only step: the stack starts on "k1", the flow runs in the When
      assert.equal(kid, "k1");
    },
  );

  When(
    "the key rotates to {string}, every deployed sealed column is swept and {string} is retired",
    function* (next: string, old: string) {
      const stack = sealedStack();
      const at = DateTime.makeUnsafe(1_700_000_000_000);
      const later = DateTime.makeUnsafe(1_700_003_600_000);
      const userId = Schema.decodeUnknownSync(Ids.UserId)("rotation-user");
      const sessionId = Schema.decodeUnknownSync(Ids.SessionId)("rotation-session");
      const accountId = Schema.decodeUnknownSync(Ids.AccountId)("rotation-account");
      const outcome = yield* Effect.gen(function* () {
        const users = yield* UserStore.UserStore;
        const sessions = yield* SessionStore.SessionStore;
        const accounts = yield* AccountStore.AccountStore;
        yield* users.insertOrHolder({
          id: userId,
          email: Option.some("rotation@example.com"),
          emailVerified: false,
          phone: Option.none(),
          phoneVerified: false,
          name: "Rotation",
          image: Option.none(),
          metadata: Option.some('{"plan":"pro"}'),
          status: "active",
          statusReason: Option.none(),
          suspendedUntil: Option.none(),
          createdAt: at,
          updatedAt: at,
        });
        yield* sessions.insert({
          session: {
            id: sessionId,
            userId,
            secretHash: "rotation-hash",
            at,
            absoluteExpiresAt: later,
            idleExpiresAt: later,
            ipAddress: Option.some("203.0.113.9"),
            userAgent: Option.some("Agent/1.0"),
            actingAs: Option.none(),
            amr: [],
          },
          supersedes: Option.none(),
          maxLive: Option.none(),
        });
        yield* accounts.insertIfAbsent({
          id: accountId,
          userId,
          providerId: "github",
          subject: "rotation-subject",
          issuer: "",
          credentialHash: Option.none(),
          tokens: Option.some({
            accessToken: Redacted.make("access-secret"),
            refreshToken: Option.some(Redacted.make("refresh-secret")),
            idToken: Option.some(Redacted.make("id-secret")),
            accessTokenExpiresAt: Option.none(),
            refreshTokenExpiresAt: Option.none(),
            scope: Option.none(),
            tokenType: Option.none(),
          }),
          createdAt: at,
          updatedAt: at,
        });
        stack.rotateTo(next);
        yield* SealedColumn.sweepDeployed();
        const secondPass = (yield* SealedColumn.sweepDeployed()).reduce(
          (total, report) => total + report.resealed,
          0,
        );
        stack.retire(old);
        const user = Option.getOrThrow(yield* users.get(userId));
        const session = Option.getOrThrow(yield* sessions.get(sessionId));
        const tokens = Option.getOrThrow(
          Option.getOrThrow(yield* accounts.readProviderTokens(accountId)),
        );
        const opened = [
          Option.isSome(yield* Sealed.openOption(user.metadata)),
          Option.isSome(yield* Sealed.openOption(session.ipAddress)),
          Option.isSome(yield* Sealed.openOption(session.userAgent)),
          Redacted.value(yield* tokens.accessToken.open) === "access-secret",
          Option.isSome(yield* Sealed.openOption(tokens.refreshToken)),
          Option.isSome(yield* Sealed.openOption(tokens.idToken)),
        ];
        return { opened, secondPass };
      }).pipe(Effect.provide(stack.layer));
      yield* put(rotation, outcome);
    },
  );

  Then(
    "the user's metadata, the session's device details and the account's tokens still open",
    function* () {
      const { opened } = yield* take(rotation);
      assert.deepEqual(opened, [true, true, true, true, true, true]);
    },
  );

  Then("a second sweep reports that nothing is left to re-seal", function* () {
    const { secondPass } = yield* take(rotation);
    assert.equal(secondPass, 0);
  });
});
