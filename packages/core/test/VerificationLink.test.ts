// MLO-009/ARF-007/ARF-009: the shared, purpose-checked mailed-token codec.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import type { StoreUnavailable } from "../src/Errors.ts";
import * as Persistence from "../src/Persistence.ts";
import * as AuditLog from "../src/AuditLog.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import * as Users from "../src/Users.ts";
import * as Verification from "../src/Verification.ts";
import * as VerificationLink from "../src/VerificationLink.ts";

const TestLayer = Verification.layer
  .pipe(Layer.provide(Persistence.memory))
  .pipe(
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layer.pipe(Layer.provide(Persistence.memory))),
    Layer.provideMerge(NodeCrypto.layer),
  );

const ResetLink = VerificationLink.forUser({ name: "reset-password" });
const VerifyLink = VerificationLink.forUser({ name: "verify-email" });
const Note = Schema.Struct({ note: Schema.String });
const NoteLink = VerificationLink.forUser({ name: "note", payload: Note });
const ChallengeLike = VerificationLink.forUser({ name: "challenge", keyedBy: "user" });
const AddressLink = VerificationLink.forAddress({ name: "address", payload: Note });

const reasonOf = (error: VerificationLink.LinkRefused | StoreUnavailable) =>
  error._tag === "VerificationLink/Refused" ? error.reason : error._tag;

const userA = Users.UserId("11111111-1111-7111-8111-111111111111");
const userB = Users.UserId("22222222-2222-7222-8222-222222222222");

describe("VerificationLink.encode/decode", () => {
  const value = Redacted.make("secret-half");

  it("round-trips a token for its own purpose", () => {
    const token = VerificationLink.encode({
      purpose: "reset-password",
      publicId: "abc_-123",
      value,
    });
    const decoded = VerificationLink.decode(Redacted.value(token), ResetLink);
    assert.isTrue(Option.isSome(decoded));
    const got = Option.getOrThrow(decoded);
    assert.strictEqual(got.identifier, "reset-password:abc_-123");
    assert.strictEqual(got.publicId, "abc_-123");
    assert.strictEqual(Redacted.value(got.value), "secret-half");
  });

  it("rejects another purpose's token", () => {
    const token = VerificationLink.encode({ purpose: "verify-email", publicId: "abc", value });
    assert.isTrue(Option.isNone(VerificationLink.decode(Redacted.value(token), ResetLink)));
  });

  it("rejects malformed input: no separator, empty halves, purpose-only identifier", () => {
    for (const raw of [
      "",
      "nodot",
      ".secret",
      "reset-password:abc.",
      "reset-password:.secret",
      "abc.secret",
    ]) {
      assert.isTrue(Option.isNone(VerificationLink.decode(raw, ResetLink)), raw);
    }
  });

  it("does not print the token", () => {
    const token = VerificationLink.encode({ purpose: "verify-email", publicId: "abc", value });
    assert.notInclude(String(token), "secret-half");
  });
});

describe("VerificationLink.issue", () => {
  it.effect(
    "a random-keyed purpose mints distinct public ids and a user-keyed one uses the user id; the payload round-trips through redeem",
    () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const random = yield* SecureRandom.SecureRandom;
        const deps = { verification, random };
        const ttl = Duration.hours(1);
        const a = yield* VerificationLink.issue(deps, ResetLink, { ttl, userId: userA });
        const b = yield* VerificationLink.issue(deps, ResetLink, { ttl, userId: userA });
        assert.notStrictEqual(a.publicId, b.publicId);
        // ARF-009: the mailed token carries an opaque id, never the user.
        assert.notInclude(Redacted.value(a.token), userA);

        const keyed = yield* VerificationLink.issue(deps, ChallengeLike, { ttl, userId: userA });
        assert.strictEqual(keyed.publicId, userA);

        const noted = yield* VerificationLink.issue(deps, NoteLink, {
          ttl,
          userId: userA,
          payload: { note: "hello" },
        });
        const redeem = VerificationLink.redeemer(NoteLink, {
          verification,
          budget: { source: "caller", token: "none" },
        });
        const link = yield* redeem({ token: noted.token }, Effect.succeed);
        assert.deepStrictEqual(link, {
          purpose: "note",
          userId: userA,
          payload: { note: "hello" },
        });
      }).pipe(Effect.provide(TestLayer)),
  );
});

describe("VerificationLink.redeemer", () => {
  const ttl = Duration.hours(1);

  /** A recording budget: what was spent, in order. */
  const recording = Effect.gen(function* () {
    const spent = yield* Ref.make<ReadonlyArray<string>>([]);
    const note = (what: string) => Ref.update(spent, (all) => [...all, what]);
    return {
      spent: Ref.get(spent),
      note,
      budget: {
        source: note("source"),
        token: (publicId: string) => note(`token:${publicId}`),
      },
    };
  });

  it.effect(
    "BEH-EA-057: a well-formed token of the purpose runs use with the typed link and spends it; presenting it again is refused missed",
    () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const random = yield* SecureRandom.SecureRandom;
        const { budget } = yield* recording;
        const issued = yield* VerificationLink.issue({ verification, random }, ResetLink, {
          ttl,
          userId: userA,
        });
        const redeem = VerificationLink.redeemer(ResetLink, { verification, budget });
        const link = yield* redeem({ token: issued.token }, Effect.succeed);
        assert.deepStrictEqual(link, {
          purpose: "reset-password",
          userId: userA,
          payload: undefined,
        });
        const again = yield* redeem({ token: issued.token }, Effect.succeed).pipe(Effect.flip);
        assert.strictEqual(reasonOf(again), "missed");
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "BEH-EA-057: a malformed token is refused malformed after the source budget and before the token budget, and the store is untouched (never `missed`)",
    () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const { budget, spent } = yield* recording;
        const redeem = VerificationLink.redeemer(ResetLink, { verification, budget });
        const raws = [
          "",
          "nonsense",
          ".",
          "reset-password:",
          "reset-password:.s",
          "reset-password:abc.",
        ];
        for (const raw of raws) {
          const refused = yield* redeem({ token: Redacted.make(raw) }, Effect.succeed).pipe(
            Effect.flip,
          );
          assert.strictEqual(reasonOf(refused), "malformed", raw);
        }
        assert.deepStrictEqual(
          yield* spent,
          raws.map(() => "source"),
        );
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "BEH-EA-057/ARF-007: a token of another purpose is refused malformed before anything is spent, and still redeems for its own purpose",
    () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const random = yield* SecureRandom.SecureRandom;
        const { budget, spent } = yield* recording;
        const verifyIssued = yield* VerificationLink.issue({ verification, random }, VerifyLink, {
          ttl,
          userId: userA,
        });
        const resets = VerificationLink.redeemer(ResetLink, { verification, budget });
        const verifies = VerificationLink.redeemer(VerifyLink, { verification, budget });
        // A wire token carries no purpose brand: widen it to a plain Redacted<string>.
        const wire: Redacted.Redacted<string> = verifyIssued.token;
        const refused = yield* resets({ token: wire }, Effect.succeed).pipe(Effect.flip);
        assert.strictEqual(reasonOf(refused), "malformed");
        assert.deepStrictEqual(yield* spent, ["source"]);
        const link = yield* verifies({ token: wire }, Effect.succeed);
        assert.strictEqual(link.userId, userA);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "APS-003: the budgets run source, then token keyed on the public id (never the secret), then beforeClaim, then the claim",
    () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const random = yield* SecureRandom.SecureRandom;
        const { budget, spent, note } = yield* recording;
        const issued = yield* VerificationLink.issue({ verification, random }, ResetLink, {
          ttl,
          userId: userA,
        });
        const redeem = VerificationLink.redeemer(ResetLink, { verification, budget });
        yield* redeem({ token: issued.token }, () => note("use"), {
          beforeClaim: note("beforeClaim"),
        });
        assert.deepStrictEqual(yield* spent, [
          "source",
          `token:${issued.publicId}`,
          "beforeClaim",
          "use",
        ]);
        assert.notInclude(
          (yield* spent).join(),
          Redacted.value(issued.token).split(".").pop() ?? "",
        );
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "APS-003: a budget refusal surfaces as the budget's own error and leaves the token live",
    () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const random = yield* SecureRandom.SecureRandom;
        const issued = yield* VerificationLink.issue({ verification, random }, ResetLink, {
          ttl,
          userId: userA,
        });
        const limited = VerificationLink.redeemer(ResetLink, {
          verification,
          budget: {
            source: Effect.void,
            token: () => Effect.fail("limited" as const),
          },
        });
        const failure = yield* limited({ token: issued.token }, Effect.succeed).pipe(Effect.flip);
        assert.strictEqual(failure, "limited");
        const open = VerificationLink.redeemer(ResetLink, {
          verification,
          budget: { source: "caller", token: "none" },
        });
        const link = yield* open({ token: issued.token }, Effect.succeed);
        assert.strictEqual(link.userId, userA);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("ARF-002: a beforeClaim failure surfaces as itself and leaves the token live", () =>
    Effect.gen(function* () {
      const verification = yield* Verification.Verification;
      const random = yield* SecureRandom.SecureRandom;
      const issued = yield* VerificationLink.issue({ verification, random }, ResetLink, {
        ttl,
        userId: userA,
      });
      const redeem = VerificationLink.redeemer(ResetLink, {
        verification,
        budget: { source: "caller", token: "none" },
      });
      const failure = yield* redeem({ token: issued.token }, Effect.succeed, {
        beforeClaim: Effect.fail("weak" as const),
      }).pipe(Effect.flip);
      assert.strictEqual(failure, "weak");
      const link = yield* redeem({ token: issued.token }, Effect.succeed);
      assert.strictEqual(link.userId, userA);
    }).pipe(Effect.provide(TestLayer)),
  );

  const bareRedeem = (verification: Verification.VerificationShape) =>
    VerificationLink.redeemer(ResetLink, {
      verification,
      budget: { source: "caller", token: "none" },
    });

  /** A row under the purpose's identifier, minted without the fields the purpose requires. */
  const forgedRow = (
    verification: Verification.VerificationShape,
    purpose: string,
    row: { readonly userId?: Users.UserId; readonly payload?: unknown },
  ) =>
    Effect.gen(function* () {
      const publicId = "forged-public-id";
      const { value } = yield* verification.issue({
        identifier: VerificationLink.identifierOf(purpose, publicId),
        ttl,
        ...row,
      });
      return VerificationLink.encode({ purpose, publicId, value });
    });

  it.effect(
    "a required-subject row with no user is refused foreign and spent: the next presentation is refused missed",
    () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const token = yield* forgedRow(verification, "reset-password", {});
        const redeem = bareRedeem(verification);
        const first = yield* redeem({ token }, Effect.succeed).pipe(Effect.flip);
        assert.strictEqual(reasonOf(first), "foreign");
        const second = yield* redeem({ token }, Effect.succeed).pipe(Effect.flip);
        assert.strictEqual(reasonOf(second), "missed");
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("a row whose payload does not decode is refused foreign and spent", () =>
    Effect.gen(function* () {
      const verification = yield* Verification.Verification;
      const token = yield* forgedRow(verification, "note", { userId: userA, payload: { nope: 1 } });
      const redeem = VerificationLink.redeemer(NoteLink, {
        verification,
        budget: { source: "caller", token: "none" },
      });
      const first = yield* redeem({ token }, Effect.succeed).pipe(Effect.flip);
      assert.strictEqual(reasonOf(first), "foreign");
      const second = yield* redeem({ token }, Effect.succeed).pipe(Effect.flip);
      assert.strictEqual(reasonOf(second), "missed");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "a user-keyed purpose keeps one live link per user: the earlier link is refused missed after a second issue",
    () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const random = yield* SecureRandom.SecureRandom;
        const deps = { verification, random };
        const first = yield* VerificationLink.issue(deps, ChallengeLike, { ttl, userId: userA });
        const second = yield* VerificationLink.issue(deps, ChallengeLike, { ttl, userId: userA });
        const redeem = VerificationLink.redeemer(ChallengeLike, {
          verification,
          budget: { source: "caller", token: "none" },
        });
        const stale = yield* redeem({ token: first.token }, Effect.succeed).pipe(Effect.flip);
        assert.strictEqual(reasonOf(stale), "missed");
        const link = yield* redeem({ token: second.token }, Effect.succeed);
        assert.strictEqual(link.userId, userA);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "a user-keyed link presented under another user's public id is refused missed, and the owner's link still redeems",
    () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const random = yield* SecureRandom.SecureRandom;
        const deps = { verification, random };
        const a = yield* VerificationLink.issue(deps, ChallengeLike, { ttl, userId: userA });
        yield* VerificationLink.issue(deps, ChallengeLike, { ttl, userId: userB });
        const secretOfA = Redacted.value(a.token).split(".").pop() ?? "";
        const forged = VerificationLink.encode({
          purpose: "challenge",
          publicId: userB,
          value: Redacted.make(secretOfA),
        });
        const redeem = VerificationLink.redeemer(ChallengeLike, {
          verification,
          budget: { source: "caller", token: "none" },
        });
        const refused = yield* redeem({ token: forged }, Effect.succeed).pipe(Effect.flip);
        assert.strictEqual(reasonOf(refused), "missed");
        const link = yield* redeem({ token: a.token }, Effect.succeed);
        assert.strictEqual(link.userId, userA);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "ADR-EA-039: a refusal from use settles as the caller says (rollback by default: the token redeems again; commit: spent), and onFailure never sees LinkRefused",
    () =>
      Effect.gen(function* () {
        const verification = yield* Verification.Verification;
        const random = yield* SecureRandom.SecureRandom;
        const deps = { verification, random };
        const redeem = bareRedeem(verification);

        const rolledBack = yield* VerificationLink.issue(deps, ResetLink, { ttl, userId: userA });
        const refusal = yield* redeem({ token: rolledBack.token }, () =>
          Effect.fail("nope" as const),
        ).pipe(Effect.flip);
        assert.strictEqual(refusal, "nope");
        assert.strictEqual(
          (yield* redeem({ token: rolledBack.token }, Effect.succeed)).userId,
          userA,
        );

        const committed = yield* VerificationLink.issue(deps, ResetLink, { ttl, userId: userA });
        const seen: Array<unknown> = [];
        yield* redeem({ token: committed.token }, () => Effect.fail("spent" as const), {
          onFailure: (error) => {
            seen.push(error);
            return "commit";
          },
        }).pipe(Effect.flip);
        const after = yield* redeem({ token: committed.token }, Effect.succeed).pipe(Effect.flip);
        assert.strictEqual(reasonOf(after), "missed");

        // A foreign row commits before onFailure is asked.
        const foreign = yield* forgedRow(verification, "reset-password", {});
        yield* redeem({ token: foreign }, Effect.succeed, {
          onFailure: (error) => {
            seen.push(error);
            return "rollback";
          },
        }).pipe(Effect.flip);
        assert.deepStrictEqual(seen, ["spent"]);
        const gone = yield* redeem({ token: foreign }, Effect.succeed).pipe(Effect.flip);
        assert.strictEqual(reasonOf(gone), "missed");
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("an expired link is refused missed", () =>
    Effect.gen(function* () {
      const verification = yield* Verification.Verification;
      const random = yield* SecureRandom.SecureRandom;
      const issued = yield* VerificationLink.issue({ verification, random }, ResetLink, {
        ttl: Duration.minutes(5),
        userId: userA,
      });
      yield* TestClock.adjust(Duration.minutes(6));
      const refused = yield* bareRedeem(verification)({ token: issued.token }, Effect.succeed).pipe(
        Effect.flip,
      );
      assert.strictEqual(reasonOf(refused), "missed");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("a forAddress link with no user hands use None, and its payload typed", () =>
    Effect.gen(function* () {
      const verification = yield* Verification.Verification;
      const random = yield* SecureRandom.SecureRandom;
      const issued = yield* VerificationLink.issue({ verification, random }, AddressLink, {
        ttl,
        payload: { note: "to a new address" },
      });
      const redeem = VerificationLink.redeemer(AddressLink, {
        verification,
        budget: { source: "caller", token: "none" },
      });
      const link = yield* redeem({ token: issued.token }, Effect.succeed);
      assert.isTrue(Option.isNone(link.userId));
      assert.strictEqual(link.payload.note, "to a new address");
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("VerificationLink.mailData", () => {
  it.effect(
    "always carries expiresAt, keeps the token Redacted, adds url only when configured",
    () =>
      Effect.gen(function* () {
        const expiresAt = yield* DateTime.now;
        const token = Redacted.make("t.o.k");
        const plain = VerificationLink.mailData({ token, expiresAt });
        assert.strictEqual(plain.expiresAt, DateTime.formatIso(expiresAt));
        assert.isTrue(Redacted.isRedacted(plain.token));
        assert.isUndefined(plain.url);
        const linked = VerificationLink.mailData({
          token,
          expiresAt,
          link: (raw) => `https://app.example/reset#${raw}`,
        });
        assert.strictEqual(linked.url, "https://app.example/reset#t.o.k");
      }),
  );
});
