// P20a/AH-003, decision 36 Tier 4: 01-contract-and-persistence/05-persistence-stratum.feature
// (BEH-EA-033..036 here; pagination is in this file's sibling `PersistenceKeysetSteps.ts` and the
// migration Rules BEH-EA-037..040 in `PersistenceMigrationSteps.ts`). Entities and repositories
// run against a real in-memory SQLite database migrated by the framework `Migrator`
// (`PersistenceStratumWorld.ts`). Scenarios whose behavior does not exist yet (INV-EA-016's
// ownership validation) or needs another World (REQ-EA-092) stay `@skip` in the feature.
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Accounts, AuthEvents, Users } from "@awthaq/core";
import { AuthHttp } from "@awthaq/server";
import { Repositories } from "@awthaq/sql";
import { RedactionGuard } from "@awthaq/test";
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
  insertSession,
  insertUser,
  M,
  MemoryUsersLive,
  RepositoriesLive,
  withDatabase,
} from "./PersistenceStratumWorld.ts";
import { TestServices } from "./shared/Harness.ts";

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
        const users = yield* Repositories.UsersRepository;
        const accounts = yield* Repositories.AccountsRepository;
        const user = yield* users.insert(
          yield* M.User.insert.makeEffect({ email: "sens@example.com", name: "Sens" }),
        );
        const account = yield* accounts.insert(
          yield* M.Account.insert.makeEffect({
            userId: user.id,
            providerId: "password",
            subject: user.id,
            issuer: "",
            passwordHash: "super-secret-hash",
            accessToken: null,
            refreshToken: null,
          }),
        );
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
          const users = yield* Repositories.UsersRepository;
          const accounts = yield* Repositories.AccountsRepository;
          const user = yield* users.insert(
            yield* M.User.insert.makeEffect({ email: "leak@example.com", name: "Leak" }),
          );
          // The whole entity — secrets included — is what the handler hands back.
          return yield* accounts.insert(
            yield* M.Account.insert.makeEffect({
              userId: user.id,
              providerId: "github",
              subject: "gh-leak",
              issuer: "",
              passwordHash: "wire-secret-hash",
              accessToken: "wire-secret-access",
              refreshToken: "wire-secret-refresh",
            }),
          );
        }).pipe(Effect.orDie),
      ),
    );
    const appLayer = AuthHttp.routes(LeakApi).pipe(
      Layer.provide(Handlers),
      Layer.provideMerge(RepositoriesLive),
      Layer.provideMerge(TestServices),
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
    const layer = Accounts.layerSql.pipe(
      Layer.provideMerge(Layer.mergeAll(RepositoriesLive, RedactionGuard.layer)),
    );
    const outcome = yield* Effect.gen(function* () {
      const guard = yield* RedactionGuard.RedactionGuard;
      yield* guard.watch("accessToken", CANARY);
      const users = yield* Repositories.UsersRepository;
      const accounts = yield* Repositories.AccountsRepository;
      const domain = yield* Accounts.Accounts;
      const user = yield* users.insert(
        yield* M.User.insert.makeEffect({ email: "spans@example.com", name: "Spans" }),
      );
      // The repository entity, secret included, through its own (traced) methods...
      const account = yield* accounts.insert(
        yield* M.Account.insert.makeEffect({
          userId: user.id,
          providerId: "github",
          subject: "gh-spans",
          issuer: "",
          passwordHash: null,
          accessToken: CANARY,
          refreshToken: null,
        }),
      );
      yield* accounts.findById(account.id);
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

  // ---- BEH-EA-035: repositories over the ambient SqlClient ----

  Given(
    "a {string} repository built with SqlModel.makeRepository against the ambient SqlClient",
    function* (name: string) {
      yield* Effect.void; // an assertion-only step: nothing to await
      assert.equal(name, "Users");
      assert.match(source("../../packages/sql/src/Repositories.ts"), /SqlModel\.makeRepository\(/);
    },
  );

  When("the repository is resolved", function* () {
    const key = yield* withDatabase(
      Effect.map(Repositories.UsersRepository, () => Repositories.UsersRepository.key),
    );
    yield* put(strings, [key]);
  });

  Then("it is provided as a Context.Service", function* () {
    const [key] = yield* take(strings);
    assert.equal(typeof key, "string");
    // Resolved by `yield* Repository` from a Layer needing nothing but the ambient `SqlClient`.
    assert.equal(key, Repositories.UsersRepository.key);
  });

  Given("a repository method that reads or writes a {string} row", function* (name: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
    assert.equal(name, "User");
  });

  When("the method executes", function* () {
    const transactionSpans = (spans: ReadonlyArray<{ readonly name: string }>) =>
      spans.filter((span) => span.name === "sql.transaction").length;
    const plain = collectSpans();
    const wrapped = collectSpans();
    yield* withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const users = yield* Repositories.UsersRepository;
        const sessions = yield* Repositories.SessionsRepository;
        yield* Effect.provideService(
          Effect.gen(function* () {
            const user = yield* insertUser("plain@example.com");
            yield* users.findByEmail("plain@example.com");
            yield* insertSession(user.id, "h0", DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"));
            yield* sessions.listByUser(user.id, DateTime.makeUnsafe("2025-01-01T00:00:00.000Z"));
          }),
          Tracer.Tracer,
          plain.tracer,
        );
        // Control: the same kind of call inside an explicit transaction *does* open the span.
        yield* Effect.provideService(
          sql.withTransaction(insertUser("wrapped@example.com")),
          Tracer.Tracer,
          wrapped.tracer,
        );
      }),
    );
    yield* put(numbers, [
      transactionSpans(plain.spans),
      transactionSpans(wrapped.spans),
      plain.spans.filter((span) => /^(Users|Sessions)\./.test(span.name)).length,
    ]);
  });

  Then("it does not call SqlClient.withTransaction itself", function* () {
    const [ownTransactions, controlTransactions, repositorySpans] = yield* take(numbers);
    assert.equal(ownTransactions, 0, "repository methods opened no transaction of their own");
    assert.ok((controlTransactions ?? 0) > 0, "an explicit withTransaction is visible as a span");
    assert.ok((repositorySpans ?? 0) > 0, "the repository methods really ran under the tracer");
  });
});
