// spec/behaviors/07-sessions.md, BEH-EA-049 through BEH-EA-056, RRS-003, RRS-005, INV-EA-008, BEH-EA-210.
//
// Plan 19 (ADR-EA-014 rev 1.4): the decision `Sessions.verify` makes about a presented credential is one
// pure function over the stored row, the presented secret's hash, the instant and the policy. These are
// its tables and properties: no layer, no store, no `TestClock`. What only the layer can show (the store
// writes, the events, the delivery of the rotated token, concurrency) stays in `Sessions.test.ts`.
import { SessionStore } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Sessions from "../src/Sessions.ts";
import * as Users from "../src/Users.ts";
import * as Verdict from "../src/internal/sessionVerdict.ts";

const T0 = 1_700_000_000_000;
const minute = 60_000;
const at = (minutes: number) => DateTime.makeUnsafe(T0 + minutes * minute);
const hex = (digit: string) => digit.repeat(64);
const CURRENT = hex("a");
const PREVIOUS = hex("b");
const OTHER = hex("c");

const policy: Verdict.Policy = {
  touchEvery: Duration.hours(1),
  idle: Duration.days(7),
  grace: Duration.seconds(30),
};

const id = Sessions.SessionId("session-1");

const record = (
  overrides: Partial<SessionStore.SessionRecord> = {},
): SessionStore.SessionRecord => ({
  id,
  userId: Users.UserId("11111111-1111-1111-1111-111111111111"),
  secretHash: CURRENT,
  createdAt: at(0),
  authenticatedAt: at(0),
  lastActiveAt: at(0),
  absoluteExpiresAt: at(30 * 24 * 60),
  idleExpiresAt: at(7 * 24 * 60),
  ipAddress: Option.none(),
  userAgent: Option.none(),
  actingAs: Option.none(),
  amr: [],
  tenantId: Option.none(),
  previousSecretHash: Option.none(),
  previousSecretExpiresAt: Option.none(),
  familyId: id,
  supersededBy: Option.none(),
  supersededAt: Option.none(),
  reusedAt: Option.none(),
  ...overrides,
});

const withPrevious = (expiresAtMinutes: number): Partial<SessionStore.SessionRecord> => ({
  previousSecretHash: Option.some(PREVIOUS),
  previousSecretExpiresAt: Option.some(at(expiresAtMinutes)),
});

const tombstone = Option.some(at(1));

const classify = (
  row: Option.Option<SessionStore.SessionRecord>,
  presentedHash: string,
  now: DateTime.Utc,
  overrides: Partial<Verdict.Policy> = {},
) => Verdict.classify({ row, presentedHash, now, policy: { ...policy, ...overrides } });

describe("classify (BEH-EA-049..056, RRS-003, RRS-005)", () => {
  it("1: no row is Unknown", () => {
    assert.strictEqual(classify(Option.none(), CURRENT, at(5))._tag, "Unknown");
  });

  it("2: a live row presented with another secret is Refused (BEH-EA-050/056)", () => {
    assert.strictEqual(classify(Option.some(record()), OTHER, at(5))._tag, "Refused");
  });

  it("3: an idle-expired row with a wrong secret is Refused, not Expired (PIL-007)", () => {
    const row = record({ idleExpiresAt: at(10) });
    assert.strictEqual(classify(Option.some(row), OTHER, at(20))._tag, "Refused");
  });

  it("4: a tombstoned row with a wrong secret is Refused, no reuse (PIL-007/RRS-003)", () => {
    const row = record({ supersededAt: tombstone });
    assert.strictEqual(classify(Option.some(row), OTHER, at(5))._tag, "Refused");
  });

  it("5: a previous secret after its window closed is Refused (RRS-005)", () => {
    const row = record(withPrevious(10));
    assert.strictEqual(classify(Option.some(row), PREVIOUS, at(10))._tag, "Refused");
  });

  it("6: a tombstoned row's current secret, unflagged, is Replayed with flagReuse (RRS-003)", () => {
    const verdict = classify(Option.some(record({ supersededAt: tombstone })), CURRENT, at(5));
    assert.deepStrictEqual(verdict, { _tag: "Replayed", flagReuse: true });
  });

  it("7: a tombstoned row's current secret, already flagged, is Replayed without flagReuse", () => {
    const row = record({ supersededAt: tombstone, reusedAt: Option.some(at(2)) });
    assert.deepStrictEqual(classify(Option.some(row), CURRENT, at(5)), {
      _tag: "Replayed",
      flagReuse: false,
    });
  });

  it("8: a previous secret inside its window against a tombstone is never a reuse signal (RRS-005)", () => {
    const row = record({ supersededAt: tombstone, ...withPrevious(10) });
    assert.deepStrictEqual(classify(Option.some(row), PREVIOUS, at(5)), {
      _tag: "Replayed",
      flagReuse: false,
    });
  });

  it("9: a tombstoned and absolute-expired row is Replayed: the tombstone is checked before expiry", () => {
    const row = record({ supersededAt: tombstone, absoluteExpiresAt: at(10) });
    assert.deepStrictEqual(classify(Option.some(row), CURRENT, at(20)), {
      _tag: "Replayed",
      flagReuse: true,
    });
  });

  it("10: the absolute deadline is inclusive (>=)", () => {
    const row = record({ absoluteExpiresAt: at(100) });
    const verdict = classify(Option.some(row), CURRENT, at(100));
    assert.strictEqual(verdict._tag, "Expired");
    assert.strictEqual(verdict._tag === "Expired" && verdict.kind, "absolute");
  });

  it("11: an idle-expired row with the absolute far away is Expired idle (BEH-EA-051)", () => {
    const row = record({ idleExpiresAt: at(100) });
    const verdict = classify(Option.some(row), CURRENT, at(101));
    assert.strictEqual(verdict._tag === "Expired" && verdict.kind, "idle");
  });

  it("12: an actingAs session past touchEvery is Accepted, never rotated (BEH-EA-210)", () => {
    const row = record({ actingAs: Option.some({ type: "user", id: "admin" }) });
    assert.strictEqual(classify(Option.some(row), CURRENT, at(600))._tag, "Accepted");
  });

  it("13: the current secret one millisecond before touchEvery is Accepted (BEH-EA-052)", () => {
    const now = DateTime.makeUnsafe(T0 + 60 * minute - 1);
    assert.strictEqual(classify(Option.some(record()), CURRENT, now)._tag, "Accepted");
  });

  it("14: the current secret exactly at touchEvery rotates, not via grace", () => {
    const verdict = classify(Option.some(record()), CURRENT, at(60));
    assert.strictEqual(verdict._tag, "Rotate");
    assert.strictEqual(verdict._tag === "Rotate" && verdict.viaGrace, false);
  });

  it("15: a previous secret inside its window rotates via grace even when not due (RRS-005)", () => {
    const row = record(withPrevious(10));
    const verdict = classify(Option.some(row), PREVIOUS, at(5));
    assert.strictEqual(verdict._tag, "Rotate");
    assert.strictEqual(verdict._tag === "Rotate" && verdict.viaGrace, true);
  });

  it("16: a zero grace keeps no previous secret", () => {
    const verdict = classify(Option.some(record()), CURRENT, at(60), { grace: Duration.zero });
    assert.isTrue(verdict._tag === "Rotate" && Option.isNone(verdict.rotation.previous));
  });

  it("17: a configured grace is honoured, not a fixed 30 seconds", () => {
    const verdict = classify(Option.some(record()), CURRENT, at(60), {
      grace: Duration.minutes(5),
    });
    assert.isTrue(verdict._tag === "Rotate");
    if (verdict._tag !== "Rotate") return;
    assert.isTrue(Option.isSome(verdict.rotation.previous));
    if (Option.isNone(verdict.rotation.previous)) return;
    assert.strictEqual(verdict.rotation.previous.value.hash, CURRENT);
    assert.strictEqual(
      DateTime.toEpochMillis(verdict.rotation.previous.value.expiresAt),
      DateTime.toEpochMillis(at(65)),
    );
  });

  it("18: an idle refresh never passes the absolute deadline (INV-EA-008)", () => {
    const row = record({ absoluteExpiresAt: at(70) });
    const verdict = classify(Option.some(row), CURRENT, at(60));
    assert.isTrue(verdict._tag === "Rotate");
    if (verdict._tag !== "Rotate") return;
    assert.strictEqual(
      DateTime.toEpochMillis(verdict.rotation.idleExpiresAt),
      DateTime.toEpochMillis(at(70)),
    );
  });

  it("19: another session's previous hash is Refused by a row that never had it (RRS-005)", () => {
    // Session B's previous hash is PREVIOUS; session A (this row) rotated to a different secret.
    assert.strictEqual(classify(Option.some(record()), PREVIOUS, at(5))._tag, "Refused");
  });
});

describe("afterLostRotation (RRC-006)", () => {
  const after = (row: Option.Option<SessionStore.SessionRecord>, minutes: number) =>
    Verdict.afterLostRotation(row, at(minutes));

  it("a row that is gone is Gone", () => {
    assert.strictEqual(after(Option.none(), 5)._tag, "Gone");
  });

  it("a tombstoned row is Gone", () => {
    assert.strictEqual(after(Option.some(record({ supersededAt: tombstone })), 5)._tag, "Gone");
  });

  it("an idle-expired row is Expired idle", () => {
    const verdict = after(Option.some(record({ idleExpiresAt: at(10) })), 20);
    assert.strictEqual(verdict._tag === "Expired" && verdict.kind, "idle");
  });

  it("an absolute-expired row is Expired absolute", () => {
    const verdict = after(Option.some(record({ absoluteExpiresAt: at(10) })), 20);
    assert.strictEqual(verdict._tag === "Expired" && verdict.kind, "absolute");
  });

  it("a live row is Accepted with that row", () => {
    const row = record();
    const verdict = after(Option.some(row), 5);
    assert.strictEqual(verdict._tag === "Accepted" && verdict.row, row);
  });
});

describe("parse, format, spanId (BEH-EA-049, MW-001)", () => {
  const credential = (raw: string) => {
    const presented = Verdict.parse(raw);
    return presented._tag === "Credential" ? [presented.id, presented.secret] : undefined;
  };

  it("splits at the first dot", () => {
    assert.strictEqual(Verdict.parse("abc")._tag, "Opaque");
    assert.deepStrictEqual(credential("id.s"), ["id", "s"]);
    assert.deepStrictEqual(credential("id."), ["id", ""]);
    assert.deepStrictEqual(credential("a.b.c"), ["a", "b.c"]);
  });

  it("an empty id is opaque", () => {
    assert.strictEqual(Verdict.parse(".s")._tag, "Opaque");
    assert.strictEqual(Verdict.parse("")._tag, "Opaque");
  });

  it("spanId admits only an id-shaped, bounded id", () => {
    assert.deepStrictEqual(Verdict.spanId(Verdict.parse("abc-1.s")), Option.some("abc-1"));
    assert.isTrue(Option.isNone(Verdict.spanId(Verdict.parse(`${"a".repeat(65)}.s`))));
    assert.isTrue(Option.isNone(Verdict.spanId(Verdict.parse("a b.s"))));
    assert.isTrue(Option.isNone(Verdict.spanId(Verdict.parse("opaque"))));
  });
});

describe("SessionStore.expiryOf (BEH-EA-051)", () => {
  const row = { absoluteExpiresAt: at(100), idleExpiresAt: at(50) };

  it("is None one millisecond before both deadlines", () => {
    assert.isTrue(
      Option.isNone(SessionStore.expiryOf(row, DateTime.makeUnsafe(T0 + 50 * minute - 1))),
    );
  });

  it("names idle at the idle deadline and absolute at the absolute one", () => {
    assert.deepStrictEqual(SessionStore.expiryOf(row, at(50)), Option.some("idle"));
    assert.deepStrictEqual(SessionStore.expiryOf(row, at(100)), Option.some("absolute"));
  });

  it("names absolute first when both have passed", () => {
    assert.deepStrictEqual(SessionStore.expiryOf(row, at(500)), Option.some("absolute"));
  });
});

// ---- properties --------------------------------------------------------------------------------

const minutes = (maximum: number) => Schema.Int.check(Schema.isBetween({ minimum: 0, maximum }));

const Facts = Schema.Struct({
  lastActive: minutes(1000),
  absolute: minutes(2000),
  idle: minutes(2000),
  previousExpires: minutes(2000),
  now: minutes(2500),
  tombstoned: Schema.Boolean,
  flagged: Schema.Boolean,
  actingAs: Schema.Boolean,
  hasPrevious: Schema.Boolean,
  presented: Schema.Literals(["current", "previous", "other"]),
  touchEvery: minutes(300),
  idleWindow: minutes(500),
  graceSeconds: minutes(600),
});

const inputOf = (facts: typeof Facts.Type) => {
  const row = record({
    lastActiveAt: at(facts.lastActive),
    absoluteExpiresAt: at(facts.absolute),
    idleExpiresAt: at(facts.idle),
    supersededAt: facts.tombstoned ? tombstone : Option.none(),
    reusedAt: facts.flagged ? Option.some(at(2)) : Option.none(),
    actingAs: facts.actingAs ? Option.some({ type: "user", id: "admin" }) : Option.none(),
    ...(facts.hasPrevious ? withPrevious(facts.previousExpires) : {}),
  });
  const presentedHash =
    facts.presented === "current" ? CURRENT : facts.presented === "previous" ? PREVIOUS : OTHER;
  const verdictPolicy: Verdict.Policy = {
    touchEvery: Duration.minutes(facts.touchEvery),
    idle: Duration.minutes(facts.idleWindow),
    grace: Duration.seconds(facts.graceSeconds),
  };
  return { row, presentedHash, now: at(facts.now), policy: verdictPolicy };
};

/** The oracle for RRS-005: which accepted secret the presented hash is. */
const acceptedAs = (input: ReturnType<typeof inputOf>) =>
  input.presentedHash === CURRENT
    ? "current"
    : input.presentedHash === PREVIOUS &&
        Option.isSome(input.row.previousSecretExpiresAt) &&
        Option.isSome(input.row.previousSecretHash) &&
        DateTime.toEpochMillis(input.now) <
          DateTime.toEpochMillis(input.row.previousSecretExpiresAt.value)
      ? "previous"
      : "none";

const verdictOf = (facts: typeof Facts.Type) => {
  const input = inputOf(facts);
  return { input, verdict: Verdict.classify({ ...input, row: Option.some(input.row) }) };
};

describe("classify properties", () => {
  it.prop(
    "P1 PIL-007: a hash that is neither the current nor a live previous secret is Refused",
    { facts: Facts },
    ({ facts }) => {
      const { input, verdict } = verdictOf(facts);
      if (acceptedAs(input) === "none") assert.strictEqual(verdict._tag, "Refused");
    },
  );

  it.prop(
    "P2 INV-EA-008: every Rotate stays inside the absolute deadline and stamps now",
    { facts: Facts },
    ({ facts }) => {
      const { input, verdict } = verdictOf(facts);
      if (verdict._tag !== "Rotate") return;
      assert.isTrue(
        DateTime.toEpochMillis(verdict.rotation.idleExpiresAt) <=
          DateTime.toEpochMillis(input.row.absoluteExpiresAt),
      );
      assert.strictEqual(
        DateTime.toEpochMillis(verdict.rotation.lastActiveAt),
        DateTime.toEpochMillis(input.now),
      );
    },
  );

  it.prop("P3 BEH-EA-210: an actingAs row is never rotated", { facts: Facts }, ({ facts }) => {
    const { input, verdict } = verdictOf(facts);
    if (Option.isSome(input.row.actingAs)) assert.notStrictEqual(verdict._tag, "Rotate");
  });

  it.prop(
    "P4 RRS-005: a previous-secret presentation is never a reuse signal",
    { facts: Facts },
    ({ facts }) => {
      const { input, verdict } = verdictOf(facts);
      if (acceptedAs(input) === "previous" && verdict._tag === "Replayed") {
        assert.isFalse(verdict.flagReuse);
      }
    },
  );

  it.prop(
    "P5: every Rotate expects the hash it read; previous is None exactly when grace is zero",
    { facts: Facts },
    ({ facts }) => {
      const { input, verdict } = verdictOf(facts);
      if (verdict._tag !== "Rotate") return;
      assert.strictEqual(verdict.rotation.expectedSecretHash, input.row.secretHash);
      assert.strictEqual(
        Option.isNone(verdict.rotation.previous),
        Duration.toMillis(input.policy.grace) === 0,
      );
    },
  );

  it.prop(
    "P6 BEH-EA-052: the current secret before lastActiveAt + touchEvery is never a Rotate",
    { facts: Facts },
    ({ facts }) => {
      const { input, verdict } = verdictOf(facts);
      const dueAt = DateTime.toEpochMillis(
        DateTime.addDuration(input.row.lastActiveAt, input.policy.touchEvery),
      );
      if (acceptedAs(input) === "current" && DateTime.toEpochMillis(input.now) < dueAt) {
        assert.notStrictEqual(verdict._tag, "Rotate");
      }
    },
  );

  it.prop(
    "P7: for an untombstoned row and a matching secret, Expired exactly when the row is not live",
    { facts: Facts },
    ({ facts }) => {
      const { input, verdict } = verdictOf(facts);
      if (Option.isSome(input.row.supersededAt) || acceptedAs(input) === "none") return;
      assert.strictEqual(verdict._tag === "Expired", !SessionStore.isLive(input.row, input.now));
      if (verdict._tag === "Expired") {
        assert.deepStrictEqual(
          Option.some(verdict.kind),
          SessionStore.expiryOf(input.row, input.now),
        );
      }
    },
  );

  it.prop(
    "P8: parse(format(id, secret)) is the Credential; no dot or a leading dot is Opaque",
    { head: Schema.String, secret: Schema.String },
    ({ head, secret }) => {
      const idPart = head.replaceAll(".", "");
      const parsed = Verdict.parse(Verdict.format(Sessions.SessionId(idPart), secret));
      if (idPart.length > 0) {
        assert.strictEqual(parsed._tag, "Credential");
        assert.strictEqual(parsed._tag === "Credential" ? String(parsed.id) : undefined, idPart);
        assert.strictEqual(parsed._tag === "Credential" && parsed.secret, secret);
      } else {
        assert.strictEqual(parsed._tag, "Opaque");
      }
      assert.strictEqual(Verdict.parse(idPart)._tag, "Opaque");
    },
  );

  it.prop(
    "P9: afterLostRotation is Accepted exactly when the row is live",
    { facts: Facts },
    ({ facts }) => {
      const input = inputOf(facts);
      const verdict = Verdict.afterLostRotation(Option.some(input.row), input.now);
      assert.strictEqual(verdict._tag === "Accepted", SessionStore.isLive(input.row, input.now));
    },
  );
});
