// P20a follow-up: 02-domain/06-users-accounts.feature, BEH-EA-048 (plugin-contributed user fields,
// SAM-004/ADR-EA-035) and BEH-EA-254 (the self-service data export, CSG-005/ADR-EA-031/033).
//
// Both run over `DomainWorld`'s SQLite-backed composition, whose one plugin, `profile`
// (`UserFieldsFixture.ts`), declares three user fields and contributes an export section. The
// client is a real signed-in user driving `PATCH /user` and `GET /user/export` over the wire; the
// assertions read the stored rows through the very same services.
import { Accounts, AuditLog, Users } from "@awthaq/core";
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { direct, profileAuth, World } from "./DomainWorld.ts";
import {
  getPerson,
  newPerson,
  request,
  setPerson,
  signIn,
  signUp,
  signUpVerified,
} from "./DomainSupport.ts";
import { fieldKey } from "./UserFieldsFixture.ts";

const emailOf = (name: string) => `${name}@example.com`;

/** The value each named field is written with in a request that means it to succeed (or, for `billingTier`, to be refused on gating alone). */
const VALUES: Readonly<Record<string, string | number | boolean>> = {
  nickname: "Casey",
  billingTier: "pro",
  isElevated: true,
  undeclared: "x",
};

/** A value each field's own schema refuses. */
const REFUSED: Readonly<Record<string, string | number | boolean>> = {
  nickname: 42,
};

const valueFor = (field: string) => {
  const value = VALUES[field];
  assert.ok(
    value !== undefined,
    `the scenario names a field this suite has no value for: ${field}`,
  );
  return value;
};

const declared = (field: string) =>
  profileAuth.manifest.userFields.find((entry) => entry.key === fieldKey(field));

/** A response body as JSON, for a wire answer whose shape the step then narrows. */
const jsonOf = Effect.fn("features.userFields.jsonOf")(function* (response: Response) {
  const text = yield* Effect.promise(() => response.clone().text());
  return { text, json: text === "" ? undefined : JSON.parse(text) };
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// ---- the client of BEH-EA-048's scenarios -------------------------------------------------------

const CLIENT = "casey";

/** The signed-in user who submits the generic updates: signed up over the wire once per scenario. */
const client = Effect.fn("features.userFields.client")(function* () {
  const { strings } = yield* World;
  const ready = yield* Effect.exit(strings.get("client:ready"));
  if (ready._tag === "Failure") {
    yield* setPerson(CLIENT, newPerson(emailOf(CLIENT)));
    yield* signUp(CLIENT);
    yield* strings.set("client:ready", "yes");
  }
  return yield* getPerson(CLIENT);
});

const clientUser = Effect.fn("features.userFields.clientUser")(function* () {
  const person = yield* client();
  assert.ok(Option.isSome(person.userId) && Option.isSome(person.cookie));
  return { userId: person.userId.value, cookie: person.cookie.value };
});

const storedFields = Effect.fn("features.userFields.storedFields")(function* () {
  const { userId } = yield* clientUser();
  return yield* direct(Effect.flatMap(Users.Users, (users) => users.getFields(userId)));
});

const storedName = Effect.fn("features.userFields.storedName")(function* () {
  const { userId } = yield* clientUser();
  const found = yield* direct(Effect.flatMap(Users.Users, (users) => users.findById(userId)));
  return found.name;
});

/** `PATCH /user` as the client, answer kept under "update". */
const patchProfile = Effect.fn("features.userFields.patchProfile")(function* (
  name: string,
  fields: Record<string, string | number | boolean>,
) {
  const { cookie } = yield* clientUser();
  const { responses } = yield* World;
  const response = yield* request("PATCH", "/user", { cookie, body: { name, fields } });
  yield* responses.set("update", response);
  return response;
});

const updateAnswer = Effect.fn("features.userFields.updateAnswer")(function* () {
  const { responses } = yield* World;
  return yield* jsonOf(yield* responses.get("update"));
});

const updateStatus = Effect.fn("features.userFields.updateStatus")(function* () {
  const { responses } = yield* World;
  return (yield* responses.get("update")).status;
});

const currentField = Effect.fn("features.userFields.currentField")(function* () {
  const { strings } = yield* World;
  return yield* strings.get("field");
});

// ---- the person of BEH-EA-254's scenarios -------------------------------------------------------

const documentOf = Effect.fn("features.userFields.documentOf")(function* () {
  const { responses } = yield* World;
  return yield* jsonOf(yield* responses.get("export"));
});

const exportEvents = Effect.fn("features.userFields.exportEvents")(function* () {
  const { probes } = yield* World;
  // The bus subscriber runs on its own fiber and the real clock: give it a beat to record.
  yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 25)));
  return (yield* Ref.get(probes.events)).filter((event) => event._tag === "auth.user.dataExported");
});

const exportAuditRows = Effect.fn("features.userFields.exportAuditRows")(function* () {
  return yield* direct(
    Effect.flatMap(AuditLog.AuditLog, (log) => log.list({ eventTag: "auth.user.dataExported" })),
  );
});

export const userFieldsSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- BEH-EA-048 / REQ-EA-133..135: what a plugin's own declaration decides ----

  const contributes = function* (field: string, clientWritable: boolean) {
    const entry = declared(field);
    assert.ok(entry !== undefined, `the profile plugin declares "${field}"`);
    assert.equal(entry.clientWritable, clientWritable);
    const { strings } = yield* World;
    yield* strings.set("field", field);
  };

  Given(
    "a plugin contributes a field {string} to {string} without declaring it non-writable",
    function* (field: string, _entity: string) {
      yield* contributes(field, true);
    },
  );

  Given(
    "a plugin contributes a field {string} to {string} and declares it non-writable in its own schema",
    function* (field: string, _entity: string) {
      yield* contributes(field, false);
    },
  );

  Given(
    "a plugin contributes a system-authority field {string} to {string} without declaring it non-writable",
    function* (field: string, _entity: string) {
      yield* contributes(field, true);
    },
  );

  When("a client submits a generic update setting {string}", function* (field: string) {
    const { strings } = yield* World;
    yield* strings.set("field", field);
    yield* patchProfile(yield* storedName(), { [fieldKey(field)]: valueFor(field) });
  });

  When(
    "a client submits a generic update setting {string} to a value its schema refuses",
    function* (field: string) {
      const refused = REFUSED[field];
      assert.ok(refused !== undefined);
      const { strings } = yield* World;
      yield* strings.set("field", field);
      yield* patchProfile(yield* storedName(), { [fieldKey(field)]: refused });
    },
  );

  When(
    "a client submits a generic update renaming the user and setting {string} and {string}",
    function* (first: string, second: string) {
      const { strings } = yield* World;
      // Remembered so the Then can prove the rename did not land either.
      yield* strings.set("nameBefore", yield* storedName());
      yield* patchProfile("Renamed By The Client", {
        [fieldKey(first)]: valueFor(first),
        [fieldKey(second)]: valueFor(second),
      });
    },
  );

  When("trusted server code sets {string} to {string}", function* (field: string, value: string) {
    const { userId } = yield* clientUser();
    yield* direct(
      Effect.flatMap(Users.Users, (users) => users.setFields(userId, { [fieldKey(field)]: value })),
    );
  });

  Then("the update is applied", function* () {
    const field = yield* currentField();
    assert.equal(yield* updateStatus(), 200);
    const { json } = yield* updateAnswer();
    assert.ok(isRecord(json) && isRecord(json["fields"]));
    assert.equal(json["fields"][fieldKey(field)], valueFor(field));
    assert.equal((yield* storedFields())[fieldKey(field)], valueFor(field));
  });

  Then("the update to {string} is not applied", function* (field: string) {
    assert.equal(yield* updateStatus(), 403);
    const { json } = yield* updateAnswer();
    assert.ok(isRecord(json));
    assert.equal(json["_tag"], "UserFieldNotWritable");
    assert.equal(json["field"], fieldKey(field));
    assert.equal((yield* storedFields())[fieldKey(field)], undefined);
  });

  Then(
    "the resulting corruption is attributable to the contributing plugin's own schema, not to the base system or to any other plugin that later trusts the field",
    function* () {
      const field = yield* currentField();
      // The value went in because the field's own declaration (the contributing plugin's) left it
      // client-writable ...
      const entry = declared(field);
      assert.ok(entry !== undefined && entry.clientWritable);
      assert.ok(
        entry.key.startsWith("profile_"),
        "the field is namespaced to its contributing plugin",
      );
      // ... while the same plugin's other field, which it did protect, is refused: the gate is
      // the plugin's declaration, and the base system adds nothing of its own around either.
      assert.equal(declared("billingTier")?.clientWritable, false);
      assert.equal((yield* storedFields())[fieldKey(field)], valueFor(field));
    },
  );

  Then(
    "the user's account shows {string} as {string}",
    function* (field: string, expected: string) {
      const response = yield* patchProfile(yield* storedName(), {});
      assert.equal(response.status, 200);
      const { json } = yield* jsonOf(response);
      assert.ok(isRecord(json) && isRecord(json["fields"]));
      assert.equal(json["fields"][fieldKey(field)], expected);
    },
  );

  Then(
    "a client submitting a generic update of {string} still gets it refused",
    function* (field: string) {
      yield* patchProfile(yield* storedName(), { [fieldKey(field)]: valueFor(field) });
      assert.equal(yield* updateStatus(), 403);
      const { json } = yield* updateAnswer();
      assert.ok(isRecord(json));
      assert.equal(json["_tag"], "UserFieldNotWritable");
    },
  );

  Then("the user's name and {string} are unchanged", function* (field: string) {
    const { strings } = yield* World;
    assert.equal(yield* storedName(), yield* strings.get("nameBefore"));
    assert.equal((yield* storedFields())[fieldKey(field)], undefined);
  });

  Then("the update is refused as an unknown field", function* () {
    assert.equal(yield* updateStatus(), 422);
    const { json } = yield* updateAnswer();
    assert.ok(isRecord(json));
    assert.equal(json["_tag"], "UnknownUserField");
  });

  Then("the update is refused as an invalid value", function* () {
    assert.equal(yield* updateStatus(), 422);
    const { json } = yield* updateAnswer();
    assert.ok(isRecord(json));
    assert.equal(json["_tag"], "InvalidUserField");
  });

  Then("{string} holds no value", function* (field: string) {
    assert.equal((yield* storedFields())[fieldKey(field)], undefined);
  });

  // ---- BEH-EA-254: the data export ----------------------------------------------------------------

  Given(
    "a signed-in user {string} with a linked {string} Account and a second live session",
    function* (name: string, provider: string) {
      yield* setPerson(name, newPerson(emailOf(name)));
      // Verified, so the second sign-in below passes the verified-email gate.
      yield* signUpVerified(name);
      const person = yield* getPerson(name);
      assert.ok(Option.isSome(person.userId));
      const userId = person.userId.value;
      yield* direct(
        Effect.flatMap(Accounts.Accounts, (accounts) =>
          accounts.link({ userId, providerId: provider, subject: `${provider}-${name}` }),
        ),
      );
      const { strings } = yield* World;
      yield* strings.set(`second:${name}`, yield* signIn(name));
    },
  );

  Given("another user {string} exists", function* (name: string) {
    yield* setPerson(name, newPerson(emailOf(name)));
    yield* signUp(name);
  });

  Given("the {string} plugin's store is unavailable", function* (plugin: string) {
    assert.equal(plugin, "profile");
    const { probes } = yield* World;
    yield* Ref.update(probes.faults, (faults) => ({ ...faults, failExportContribution: true }));
  });

  Given("rate limits are enforced", function* () {
    const { probes } = yield* World;
    yield* Ref.update(probes.faults, (faults) => ({ ...faults, enforceRateLimits: true }));
  });

  const requestExport = Effect.fn("features.userFields.requestExport")(function* (name: string) {
    const person = yield* getPerson(name);
    assert.ok(Option.isSome(person.cookie));
    const response = yield* request("GET", "/user/export", { cookie: person.cookie.value });
    const { responses } = yield* World;
    yield* responses.set("export", response);
    return response;
  });

  When("{string} requests her data export", function* (name: string) {
    yield* requestExport(name);
  });

  When(
    "{string} requests her data export {int} times in a row",
    function* (name: string, times: number) {
      const statuses: Array<number> = [];
      for (let attempt = 0; attempt < times; attempt++) {
        statuses.push((yield* requestExport(name)).status);
      }
      const { strings } = yield* World;
      yield* strings.set("export:statuses", statuses.join(","));
    },
  );

  Then("the response is one JSON attachment that caches nowhere", function* () {
    const { responses } = yield* World;
    const response = yield* responses.get("export");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert.match(response.headers.get("content-disposition") ?? "", /^attachment;/);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  Then(
    "the document holds her user, both Accounts, both sessions and her own audit activity",
    function* () {
      const person = yield* getPerson(yield* (yield* World).people.current);
      assert.ok(Option.isSome(person.userId));
      const { json } = yield* documentOf();
      assert.ok(isRecord(json) && isRecord(json["user"]));
      assert.equal(json["user"]["id"], person.userId.value);
      assert.ok(Array.isArray(json["accounts"]));
      assert.deepEqual(
        json["accounts"]
          .map((account) => (isRecord(account) ? account["providerId"] : undefined))
          .sort(),
        ["google", "password"],
      );
      assert.ok(Array.isArray(json["sessions"]));
      assert.equal(json["sessions"].length, 2);
      assert.ok(Array.isArray(json["activity"]));
      assert.ok(
        json["activity"].some((row) => isRecord(row) && row["event"] === "auth.session.issued"),
        "her own audit activity includes the sessions issued to her",
      );
    },
  );

  Then(
    "the document has a section for the {string} plugin under its own id",
    function* (id: string) {
      const { json } = yield* documentOf();
      assert.ok(isRecord(json) && isRecord(json["sections"]));
      assert.deepEqual(Object.keys(json["sections"]), [id]);
      assert.ok(isRecord(json["sections"][id]));
    },
  );

  Then(
    "the document contains no password hash, provider token, session secret or key material",
    function* () {
      const { text } = yield* documentOf();
      const { strings, people } = yield* World;
      const person = yield* getPerson(yield* people.current);
      assert.ok(Option.isSome(person.cookie));
      const secrets = [
        person.cookie.value,
        yield* strings.get(`second:${yield* people.current}`),
      ].map((cookie) => decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1)));
      for (const token of secrets) {
        assert.ok(token.includes("."), "a session token is <id>.<secret>");
        assert.ok(!text.includes(token), "no whole session token");
        assert.ok(!text.includes(token.slice(token.lastIndexOf(".") + 1)), "no session secret");
      }
      for (const forbidden of [
        "argon2id",
        "$scrypt",
        "credentialHash",
        "secretHash",
        "accessToken",
        "refreshToken",
        "idToken",
      ]) {
        assert.ok(!text.includes(forbidden), `the export must not carry ${forbidden}`);
      }
    },
  );

  Then("the document does not mention {string}", function* (name: string) {
    const { text } = yield* documentOf();
    const other = yield* getPerson(name);
    assert.ok(Option.isSome(other.userId));
    assert.ok(!text.includes(other.userId.value), "no other user's id");
    assert.ok(!text.includes(other.email), "no other user's address");
  });

  Then("the export is refused as a store outage", function* () {
    const { responses } = yield* World;
    const response = yield* responses.get("export");
    assert.equal(response.status, 503);
    const { json } = yield* documentOf();
    assert.ok(isRecord(json));
    assert.equal(json["_tag"], "StoreUnavailable");
  });

  Then("no document is produced and no export is recorded", function* () {
    const { json } = yield* documentOf();
    assert.ok(!isRecord(json) || json["sections"] === undefined);
    assert.deepEqual(yield* exportEvents(), []);
    assert.deepEqual(yield* exportAuditRows(), []);
  });

  Then(
    "{string} is published for {string} as a self-service request, carrying ids only",
    function* (tag: string, name: string) {
      assert.equal(tag, "auth.user.dataExported");
      const person = yield* getPerson(name);
      assert.ok(Option.isSome(person.userId));
      const events = yield* exportEvents();
      assert.equal(events.length, 1);
      const [event] = events;
      assert.ok(event !== undefined && event._tag === "auth.user.dataExported");
      assert.equal(event.userId, person.userId.value);
      assert.equal(event.requestedBy, "self");
      // Ids only: past the envelope every published event carries (id, time, trace, request
      // context), the payload is the subject and who asked — nothing of the document rides on it.
      const envelope = new Set([
        "correlationId",
        "eventId",
        "ip",
        "occurredAt",
        "spanId",
        "traceId",
        "userAgent",
      ]);
      assert.deepEqual(
        Object.keys(event)
          .filter((key) => !envelope.has(key))
          .sort(),
        ["_tag", "requestedBy", "userId"],
      );
    },
  );

  Then(
    "the first {int} exports succeed and the {int}th is refused as rate-limited",
    function* (allowed: number, refused: number) {
      const { strings } = yield* World;
      const statuses = (yield* strings.get("export:statuses")).split(",").map(Number);
      assert.equal(statuses.length, refused);
      assert.deepEqual(
        statuses.slice(0, allowed),
        Array.from({ length: allowed }, () => 200),
      );
      assert.equal(statuses[refused - 1], 429);
    },
  );
});
