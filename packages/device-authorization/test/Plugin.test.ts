// BEH-EA-009 (composition), docs/plugin-authoring.md's checklist, and BEH-EA-304: how the redemption composes
// with the other sign-in machinery — the real `@awthaq/two-factor` gate (the divert), a `BeforeSignIn` veto, and
// the plugin contract's own mechanical checks (`TestAuth.runPluginContractTests`).
import {
  Auth,
  ConfigDescriptor,
  HookPoint,
  Hooks,
  RateLimits,
  Sessions,
  Users,
} from "@awthaq/core";
import { TestAuth } from "@awthaq/test";
import { Totp, TwoFactor } from "@awthaq/two-factor";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as DeviceAuthorization from "../src/DeviceAuthorization.ts";
import * as DeviceGrantRecords from "../src/DeviceGrantRecords.ts";
import * as UserCode from "../src/UserCode.ts";
import { buildLayer, CLI_CLIENT_ID } from "./support/harness.ts";

const service = DeviceAuthorization.DeviceAuthorization;

/** A user whose second factor is confirmed, and a caller (their session) with the given `amr`. */
const enrolledCaller = (email: string, amr: ReadonlyArray<Sessions.AuthMethod>) =>
  Effect.gen(function* () {
    const users = yield* Users.Users;
    const sessions = yield* Sessions.Sessions;
    const twoFactor = yield* TwoFactor.TwoFactor;
    const crypto = yield* Crypto.Crypto;
    const user = yield* users.create({ identity: { _tag: "Email", email }, name: email });
    const fresh = yield* sessions.issue({ userId: user.id });
    const enrolment = yield* twoFactor.enable(user.id, fresh.session.id);
    const key = Option.getOrThrow(Totp.base32Decode(enrolment.secret));
    const now = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000);
    yield* twoFactor.confirm(
      user.id,
      Redacted.make(yield* Totp.totp(crypto, key, now, { period: 30, digits: 6 })),
    );
    const issued = yield* sessions.issue({ userId: user.id, amr });
    const caller: DeviceAuthorization.Caller = {
      userId: user.id,
      sessionId: issued.session.id,
      impersonated: false,
      amr,
    };
    return caller;
  }).pipe(Effect.orDie);

const approvedFor = (caller: DeviceAuthorization.Caller) =>
  Effect.gen(function* () {
    const plugin = yield* service;
    const issued = yield* plugin.requestCode(
      { clientId: CLI_CLIENT_ID, scope: [], ip: "203.0.113.7" },
      { verificationBase: "https://app.test/device" },
    );
    const source = { userCode: issued.userCode, ip: "198.51.100.20" };
    yield* plugin.verify(source, Option.some(caller));
    yield* plugin.approve(source, caller);
    yield* TestClock.adjust(Duration.seconds(5));
    return issued;
  });

const pollOf = (issued: DeviceAuthorization.CodeIssued) =>
  Effect.gen(function* () {
    const plugin = yield* service;
    return yield* plugin.poll({
      deviceCode: issued.deviceCode,
      clientId: CLI_CLIENT_ID,
      ip: "203.0.113.7",
    });
  });

const grantOf = (issued: DeviceAuthorization.CodeIssued) =>
  Effect.gen(function* () {
    const records = yield* DeviceGrantRecords.DeviceGrantRecords;
    const crypto = yield* Crypto.Crypto;
    return yield* records.findByDeviceHash(
      yield* UserCode.hashDeviceCode(crypto, Redacted.value(issued.deviceCode)),
    );
  });

describe("DeviceAuthorization composition", () => {
  it("composes through Auth.make with its tables, groups and config in the manifest", () => {
    const auth = Auth.make([DeviceAuthorization.DeviceAuthorization]);
    assert.strictEqual(auth.api.identifier, "auth");
    const entry = auth.manifest.plugins.find((plugin) => plugin.id === "device_authorization");
    assert.deepStrictEqual(entry?.tables, [
      "device_authorization_grant",
      "device_authorization_client",
    ]);
    assert.deepStrictEqual(entry?.groups.toSorted(), [
      "device_authorization",
      "device_authorization.decision",
      "device_authorization.verification",
    ]);
    assert.deepStrictEqual(
      auth.manifest.config.map((config) => config.descriptor.key),
      ["awthaq/device-authorization/Config"],
    );
  });

  it("doctor's audit warns in production when verificationUri is unset, and is quiet once it is set", () => {
    const auth = Auth.make([DeviceAuthorization.DeviceAuthorization]);
    const descriptor = auth.manifest.config[0]?.descriptor;
    if (descriptor === undefined) return assert.fail("no descriptor");
    const audit = (context: Context.Context<never>) =>
      descriptor.audit(context, { production: true }).map((finding) => finding.code);
    assert.deepStrictEqual(audit(Context.empty()), ["device-authorization-verification-uri"]);
    const configured = Context.make(DeviceAuthorization.DeviceAuthorizationConfig, {
      ...DeviceAuthorization.DeviceAuthorizationConfig.defaultValue(),
      verificationUri: "https://app.example.com/device",
    });
    assert.deepStrictEqual(audit(configured), []);
    assert.deepStrictEqual(
      descriptor.audit(Context.empty(), { production: false }).map((finding) => finding.code),
      [],
    );
    assert.isTrue(ConfigDescriptor.REDACTED === "<redacted>");
  });

  it.effect("the static rateLimits declaration and the registered rules agree (PV-241)", () =>
    Effect.gen(function* () {
      const registry = yield* RateLimits.RateLimitsRegistry;
      const drift = RateLimits.declarationDrift(
        DeviceAuthorization.DeviceAuthorization,
        yield* registry.registered,
      );
      assert.deepStrictEqual(drift, { undeclared: [], unregistered: [], mismatched: [] });
      assert.strictEqual(DeviceAuthorization.DeviceAuthorization.rateLimits.length, 9);
    }).pipe(Effect.provide(buildLayer({ store: "memory" }))),
  );

  it("declares the ports it requires, which the manifest lists", () => {
    const auth = Auth.make([DeviceAuthorization.DeviceAuthorization]);
    assert.deepStrictEqual(auth.manifest.ports.map((port) => port.key).toSorted(), [
      "awthaq/ports/ClientAddress",
      "awthaq/ports/RateLimiter",
    ]);
  });

  TestAuth.runPluginContractTests(
    { describe, it, fail: (message) => assert.fail(message) },
    () => DeviceAuthorization.DeviceAuthorization,
    { options: [{}] },
  );
});

describe("DeviceAuthorization redemption through the sign-in machinery (BEH-EA-304)", () => {
  it.effect(
    "a second factor applies: a session that never proved one is diverted, and the grant ends as access_denied",
    () =>
      Effect.gen(function* () {
        const caller = yield* enrolledCaller("plain@example.com", ["pwd"]);
        const issued = yield* approvedFor(caller);
        const answer = yield* pollOf(issued).pipe(Effect.flip);
        assert.strictEqual(answer._tag, "AccessDenied");
        // A device cannot answer a challenge: the grant is ended, not left to be polled until it expires.
        assert.isTrue(Option.isNone(yield* grantOf(issued)));
        const sessions = yield* Sessions.Sessions;
        assert.strictEqual(
          (yield* sessions.list(caller.userId)).length,
          2,
          "no third session was minted",
        );
      }).pipe(Effect.provide(buildLayer({ store: "memory" }))),
  );

  it.effect(
    "an approving session that already carries a second factor is not asked for one again",
    () =>
      Effect.gen(function* () {
        const caller = yield* enrolledCaller("proven@example.com", ["pwd", "otp", "mfa"]);
        const issued = yield* approvedFor(caller);
        const redeemed = yield* pollOf(issued);
        assert.strictEqual(redeemed.session.userId, caller.userId);
        assert.deepStrictEqual(redeemed.session.amr, ["pwd", "otp", "mfa"]);
      }).pipe(Effect.provide(buildLayer({ store: "memory" }))),
  );

  it.effect(
    "a BeforeSignIn veto surfaces as HookAborted and mints nothing; the grant survives for a later poll",
    () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;
        const user = yield* users.create({
          identity: { _tag: "Email", email: "vetoed@example.com" },
          name: "v",
        });
        const live = yield* sessions.issue({ userId: user.id, amr: ["pwd"] });
        const caller: DeviceAuthorization.Caller = {
          userId: user.id,
          sessionId: live.session.id,
          impersonated: false,
          amr: ["pwd"],
        };
        const issued = yield* approvedFor(caller);
        const answer = yield* pollOf(issued).pipe(Effect.flip);
        if (answer._tag !== "HookAborted") return assert.fail(answer._tag);
        assert.strictEqual(answer.code, "BLOCKED");
        assert.isTrue(Option.isSome(yield* grantOf(issued)));
        assert.strictEqual((yield* sessions.list(user.id)).length, 1);
      }).pipe(
        Effect.provide(
          buildLayer(
            { store: "memory" },
            Hooks.BeforeSignIn.tap(
              (input) =>
                input.strategy === DeviceAuthorization.STRATEGY
                  ? Effect.fail(new HookPoint.HookAbort({ code: "BLOCKED" }))
                  : Effect.succeed(input),
              { owner: DeviceAuthorization.DeviceAuthorization },
            ),
          ),
        ),
      ),
  );
});

// A grant's own state machine: the row only ever moves forward, checked through the records' primitives.
describe("DeviceGrantRecords compare-and-swap primitives", () => {
  it.effect("claim, decide and consume each succeed once", () =>
    Effect.gen(function* () {
      const records = yield* DeviceGrantRecords.DeviceGrantRecords;
      const now = yield* DateTime.now;
      const owner = Users.UserId("owner");
      const rival = Users.UserId("rival");
      const grant: DeviceGrantRecords.DeviceGrantRecord = {
        id: "g1",
        deviceCodeHash: "d1",
        userCodeHash: "u1",
        clientId: "c",
        scopes: [],
        status: "pending",
        userId: Option.none(),
        amr: [],
        pollInterval: 5,
        createdAt: now,
        expiresAt: DateTime.addDuration(now, Duration.minutes(15)),
        lastPolledAt: Option.none(),
      };
      assert.isTrue(yield* records.insert(grant));
      // A second row with the same user-code hash is refused: the caller draws another code.
      assert.isFalse(yield* records.insert({ ...grant, id: "g2", deviceCodeHash: "d2" }));

      assert.isTrue(yield* records.claim("g1", owner));
      assert.isFalse(yield* records.claim("g1", rival));
      assert.isFalse(
        yield* records.decide({ id: "g1", userId: rival, status: "approved", amr: [], now }),
      );
      // An expired grant cannot be decided, even by its claimer.
      assert.isFalse(
        yield* records.decide({
          id: "g1",
          userId: owner,
          status: "approved",
          amr: [],
          now: DateTime.addDuration(now, Duration.minutes(16)),
        }),
      );
      // A pending grant cannot be consumed: only an approved one is.
      assert.isTrue(Option.isNone(yield* records.consume("g1", owner)));
      assert.isTrue(
        yield* records.decide({ id: "g1", userId: owner, status: "approved", amr: ["pwd"], now }),
      );
      assert.isFalse(
        yield* records.decide({ id: "g1", userId: owner, status: "denied", amr: [], now }),
        "a terminal state never returns to pending",
      );
      assert.isTrue(Option.isNone(yield* records.consume("g1", rival)));
      const consumed = yield* records.consume("g1", owner);
      assert.isTrue(Option.isSome(consumed));
      assert.isTrue(Option.isNone(yield* records.consume("g1", owner)));
    }).pipe(Effect.provide(DeviceGrantRecords.layerMemory)),
  );
});
