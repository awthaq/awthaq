// BEH-EA-299 to BEH-EA-306, spec/models/13-device-authorization.md "Design constraints": the plugin at the
// service level, over both record stores (memory, and a real migrated database), under `TestClock` so an expiry
// or an interval is a `TestClock.adjust`, never a sleep.
import { AuditLog, DataExport, Erasure, RateLimits, Sessions, Users } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as DeviceAuthorization from "../src/DeviceAuthorization.ts";
import * as DeviceGrantRecords from "../src/DeviceGrantRecords.ts";
import * as UserCode from "../src/UserCode.ts";
import { buildLayer, CLI_CLIENT_ID, type HarnessOptions } from "./support/harness.ts";

const VERIFICATION_BASE = "https://app.test/device";
const DEVICE_IP = "203.0.113.7";

const service = DeviceAuthorization.DeviceAuthorization;

/** A fresh user with a live session: the `Caller` a verification page or decision endpoint would resolve. */
const signedIn = (email: string, amr: ReadonlyArray<Sessions.AuthMethod> = ["pwd"]) =>
  Effect.gen(function* () {
    const users = yield* Users.Users;
    const sessions = yield* Sessions.Sessions;
    const user = yield* users.create({ identity: { _tag: "Email", email }, name: email });
    const issued = yield* sessions.issue({ userId: user.id, amr });
    const caller: DeviceAuthorization.Caller = {
      userId: user.id,
      sessionId: issued.session.id,
      impersonated: false,
      amr,
    };
    return caller;
  }).pipe(Effect.orDie);

const requestCode = (overrides?: {
  readonly clientId?: string;
  readonly scope?: ReadonlyArray<string>;
  readonly ip?: string;
}) =>
  Effect.gen(function* () {
    const plugin = yield* service;
    return yield* plugin.requestCode(
      {
        clientId: overrides?.clientId ?? CLI_CLIENT_ID,
        scope: overrides?.scope ?? [],
        ip: overrides?.ip ?? DEVICE_IP,
      },
      { verificationBase: VERIFICATION_BASE },
    );
  });

const poll = (
  issued: DeviceAuthorization.CodeIssued,
  overrides?: { readonly clientId?: string; readonly userAgent?: string },
) =>
  Effect.gen(function* () {
    const plugin = yield* service;
    return yield* plugin.poll(
      {
        deviceCode: issued.deviceCode,
        clientId: overrides?.clientId ?? CLI_CLIENT_ID,
        ip: DEVICE_IP,
      },
      { userAgent: overrides?.userAgent ?? "awthaq-cli/0.1" },
    );
  });

const verify = (
  issued: DeviceAuthorization.CodeIssued,
  caller: Option.Option<DeviceAuthorization.Caller>,
  userCode: string = issued.userCode,
) =>
  Effect.gen(function* () {
    const plugin = yield* service;
    return yield* plugin.verify({ userCode, ip: "198.51.100.20" }, caller);
  });

const approve = (
  issued: DeviceAuthorization.CodeIssued,
  caller: DeviceAuthorization.Caller,
  userCode: string = issued.userCode,
) =>
  Effect.gen(function* () {
    const plugin = yield* service;
    return yield* plugin.approve({ userCode, ip: "198.51.100.20" }, caller);
  });

const deny = (issued: DeviceAuthorization.CodeIssued, caller: DeviceAuthorization.Caller) =>
  Effect.gen(function* () {
    const plugin = yield* service;
    return yield* plugin.deny({ userCode: issued.userCode, ip: "198.51.100.20" }, caller);
  });

/** The stored grant for a code the device holds. */
const grantOf = (issued: DeviceAuthorization.CodeIssued) =>
  Effect.gen(function* () {
    const records = yield* DeviceGrantRecords.DeviceGrantRecords;
    const crypto = yield* Crypto.Crypto;
    return yield* records.findByDeviceHash(
      yield* UserCode.hashDeviceCode(crypto, Redacted.value(issued.deviceCode)),
    );
  });

/** The user claims a code, approves it, and the code is ready to redeem. */
const approvedGrant = (email: string, amr: ReadonlyArray<Sessions.AuthMethod> = ["pwd"]) =>
  Effect.gen(function* () {
    const issued = yield* requestCode();
    const caller = yield* signedIn(email, amr);
    yield* verify(issued, Option.some(caller));
    yield* approve(issued, caller);
    yield* waitInterval;
    return { issued, caller };
  });

/** The device waits one advised interval, as a well-behaved client does. */
const waitInterval = TestClock.adjust(Duration.seconds(5));

const suites: ReadonlyArray<HarnessOptions> = [
  { store: "memory" },
  { store: "sql", suite: "device_authorization_service" },
];

for (const options of suites) {
  const layer = (overrides?: Partial<HarnessOptions>) => buildLayer({ ...options, ...overrides });

  describe(`DeviceAuthorization (${options.store})`, () => {
    describe("requesting a code (BEH-EA-299)", () => {
      it.effect("answers the RFC 8628 §3.2 fields, with the user code in XXXX-XXXX form", () =>
        Effect.gen(function* () {
          const issued = yield* requestCode();
          assert.match(issued.userCode, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
          assert.match(Redacted.value(issued.deviceCode), /^[A-Za-z0-9_-]{43}$/);
          assert.strictEqual(issued.expiresIn, 15 * 60);
          assert.strictEqual(issued.interval, 5);
          assert.strictEqual(issued.verificationUri, VERIFICATION_BASE);
          assert.strictEqual(
            issued.verificationUriComplete,
            `${VERIFICATION_BASE}?user_code=${encodeURIComponent(issued.userCode)}`,
          );
        }).pipe(Effect.provide(layer())),
      );

      it.effect("stores only SHA-256 hashes of the two codes, never a code", () =>
        Effect.gen(function* () {
          const records = yield* DeviceGrantRecords.DeviceGrantRecords;
          const crypto = yield* Crypto.Crypto;
          const issued = yield* requestCode();
          const found = yield* records.findByUserHash(
            yield* UserCode.hash(crypto, issued.userCode),
          );
          if (Option.isNone(found))
            return assert.fail("the grant was not stored under the user-code hash");
          const serialized = JSON.stringify(found.value);
          assert.notInclude(serialized, Redacted.value(issued.deviceCode));
          assert.notInclude(serialized, UserCode.normalize(issued.userCode));
          assert.match(found.value.deviceCodeHash, /^[0-9a-f]{64}$/);
          assert.match(found.value.userCodeHash, /^[0-9a-f]{64}$/);
          assert.strictEqual(found.value.status, "pending");
          assert.isTrue(Option.isNone(found.value.userId));
        }).pipe(Effect.provide(layer())),
      );

      it.effect(
        "a user code entered lower-cased with spaces still finds its grant; one character off does not",
        () =>
          Effect.gen(function* () {
            const issued = yield* requestCode();
            const caller = yield* signedIn("normalised@example.com");
            const typed = issued.userCode.toLowerCase().replace("-", " ");
            const claimed = yield* verify(issued, Option.some(caller), typed);
            assert.strictEqual(claimed.status, "pending");
            assert.isTrue(Option.isSome(claimed.context));
            const flipped = `${issued.userCode.slice(0, -1)}${issued.userCode.endsWith("B") ? "C" : "B"}`;
            const miss = yield* verify(issued, Option.some(caller), flipped).pipe(Effect.flip);
            assert.strictEqual(miss._tag, "InvalidUserCode");
          }).pipe(Effect.provide(layer())),
      );

      it.effect(
        "refuses an unregistered client, a revoked one and a scope the client is not registered for",
        () =>
          Effect.gen(function* () {
            const plugin = yield* service;
            const unknown = yield* requestCode({ clientId: "nobody" }).pipe(Effect.flip);
            assert.strictEqual(unknown._tag, "InvalidClient");
            const outside = yield* requestCode({ scope: ["admin"] }).pipe(Effect.flip);
            assert.strictEqual(outside._tag, "InvalidScope");

            const registered = yield* plugin.registerClient({
              name: "Set-top box",
              scopes: ["playback"],
            });
            const ok = yield* requestCode({ clientId: registered.clientId, scope: ["playback"] });
            assert.strictEqual(ok.userCode.length, 9);
            assert.isTrue(yield* plugin.revokeClient(registered.clientId));
            const revoked = yield* requestCode({ clientId: registered.clientId }).pipe(Effect.flip);
            assert.strictEqual(revoked._tag, "InvalidClient");
            // Revoking twice, or a client that never existed, revokes nothing.
            assert.isFalse(yield* plugin.revokeClient(registered.clientId));
          }).pipe(Effect.provide(layer())),
      );

      it.effect("registerClient refuses a duplicate id, a configured id and unusable input", () =>
        Effect.gen(function* () {
          const plugin = yield* service;
          yield* plugin.registerClient({ name: "TV", clientId: "tv-app" });
          const twice = yield* plugin
            .registerClient({ name: "TV", clientId: "tv-app" })
            .pipe(Effect.flip);
          assert.strictEqual(twice._tag, "DeviceAuthorization/ClientExists");
          const shadow = yield* plugin
            .registerClient({ name: "Fake CLI", clientId: CLI_CLIENT_ID })
            .pipe(Effect.flip);
          assert.strictEqual(shadow._tag, "DeviceAuthorization/ClientExists");
          const nameless = yield* plugin.registerClient({ name: "  " }).pipe(Effect.flip);
          assert.strictEqual(nameless._tag, "DeviceAuthorization/ClientInvalid");
          const badId = yield* plugin
            .registerClient({ name: "x", clientId: "has space" })
            .pipe(Effect.flip);
          assert.strictEqual(badId._tag, "DeviceAuthorization/ClientInvalid");
          const listed = yield* plugin.listClients;
          assert.deepStrictEqual(
            listed.map((client) => [client.clientId, client.source]),
            [
              [CLI_CLIENT_ID, "config"],
              ["tv-app", "registered"],
            ],
          );
        }).pipe(Effect.provide(layer())),
      );
    });

    describe("polling (BEH-EA-300)", () => {
      it.effect(
        "answers authorization_pending, then issues a session exactly once after approval",
        () =>
          Effect.gen(function* () {
            const issued = yield* requestCode();
            const pending = yield* poll(issued).pipe(Effect.flip);
            assert.strictEqual(pending._tag, "AuthorizationPending");

            const caller = yield* signedIn("approver@example.com");
            yield* verify(issued, Option.some(caller));
            yield* approve(issued, caller);
            yield* waitInterval;

            const redeemed = yield* poll(issued);
            assert.strictEqual(redeemed.session.userId, caller.userId);
            assert.isAbove(Redacted.value(redeemed.token).length, 10);
            // The grant is consumed: the same device code is now spent.
            yield* waitInterval;
            const again = yield* poll(issued).pipe(Effect.flip);
            assert.strictEqual(again._tag, "InvalidGrant");
            assert.isTrue(Option.isNone(yield* grantOf(issued)));
          }).pipe(Effect.provide(layer())),
      );

      it.effect(
        "a poll before the interval answers slow_down and raises the server-side interval by 5 seconds",
        () =>
          Effect.gen(function* () {
            const issued = yield* requestCode();
            const first = yield* poll(issued).pipe(Effect.flip);
            assert.strictEqual(first._tag, "AuthorizationPending");
            const early = yield* poll(issued).pipe(Effect.flip);
            if (early._tag !== "SlowDown") return assert.fail(early._tag);
            assert.strictEqual(early.interval, 10);
            assert.strictEqual(
              Option.getOrNull(Option.map(yield* grantOf(issued), (g) => g.pollInterval)),
              10,
            );

            // The advised 5 seconds are no longer enough...
            yield* TestClock.adjust(Duration.seconds(5));
            const stillEarly = yield* poll(issued).pipe(Effect.flip);
            assert.strictEqual(stillEarly._tag, "SlowDown");
            // ...but the raised interval is (the second early poll raised it again, to 15).
            yield* TestClock.adjust(Duration.seconds(15));
            const later = yield* poll(issued).pipe(Effect.flip);
            assert.strictEqual(later._tag, "AuthorizationPending");
          }).pipe(Effect.provide(layer())),
      );

      it.effect(
        "a poll rejected as pending still counts toward throttling: a slow_down poll is not free",
        () =>
          Effect.gen(function* () {
            const issued = yield* requestCode();
            yield* poll(issued).pipe(Effect.flip);
            yield* TestClock.adjust(Duration.seconds(5));
            // Passes the interval check, is answered pending, and *advances lastPolledAt*...
            const second = yield* poll(issued).pipe(Effect.flip);
            assert.strictEqual(second._tag, "AuthorizationPending");
            // ...so an immediate retry is slow_down rather than another free pending.
            const third = yield* poll(issued).pipe(Effect.flip);
            assert.strictEqual(third._tag, "SlowDown");
          }).pipe(Effect.provide(layer())),
      );

      it.effect("a denied grant answers access_denied and its row is deleted on observation", () =>
        Effect.gen(function* () {
          const issued = yield* requestCode();
          const caller = yield* signedIn("denier@example.com");
          yield* verify(issued, Option.some(caller));
          const decision = yield* deny(issued, caller);
          assert.strictEqual(decision.status, "denied");
          const answer = yield* poll(issued).pipe(Effect.flip);
          assert.strictEqual(answer._tag, "AccessDenied");
          assert.isTrue(Option.isNone(yield* grantOf(issued)));
        }).pipe(Effect.provide(layer())),
      );

      it.effect(
        "an expired code answers expired_token and its row is deleted on first discovery",
        () =>
          Effect.gen(function* () {
            const issued = yield* requestCode();
            yield* TestClock.adjust(Duration.minutes(16));
            const answer = yield* poll(issued).pipe(Effect.flip);
            assert.strictEqual(answer._tag, "ExpiredToken");
            assert.isTrue(Option.isNone(yield* grantOf(issued)));
          }).pipe(Effect.provide(layer())),
      );

      it.effect("the verification page rejects an expired code without deleting it", () =>
        Effect.gen(function* () {
          const issued = yield* requestCode();
          yield* TestClock.adjust(Duration.minutes(16));
          const caller = yield* signedIn("late@example.com");
          const refused = yield* verify(issued, Option.some(caller)).pipe(Effect.flip);
          assert.strictEqual(refused._tag, "InvalidUserCode");
          assert.isTrue(Option.isSome(yield* grantOf(issued)));
        }).pipe(Effect.provide(layer())),
      );

      it.effect(
        "a device code presented by another client, or one that never existed, is invalid_grant",
        () =>
          Effect.gen(function* () {
            const plugin = yield* service;
            yield* plugin.registerClient({ name: "Other", clientId: "other-client" });
            const issued = yield* requestCode();
            const foreign = yield* poll(issued, { clientId: "other-client" }).pipe(Effect.flip);
            assert.strictEqual(foreign._tag, "InvalidGrant");
            const forged = yield* plugin
              .poll({ deviceCode: Redacted.make("nope"), clientId: CLI_CLIENT_ID, ip: DEVICE_IP })
              .pipe(Effect.flip);
            assert.strictEqual(forged._tag, "InvalidGrant");
          }).pipe(Effect.provide(layer())),
      );

      it.effect(
        "two concurrent polls after approval issue exactly one session; the loser gets invalid_grant",
        () =>
          Effect.gen(function* () {
            const { issued, caller } = yield* approvedGrant("racer@example.com");
            const sessions = yield* Sessions.Sessions;
            const before = (yield* sessions.list(
              caller.userId,
              Sessions.SessionId(caller.sessionId),
            )).length;
            const exits = yield* Effect.all(
              [Effect.exit(poll(issued)), Effect.exit(poll(issued))],
              {
                concurrency: 2,
              },
            );
            const wins = exits.filter(Exit.isSuccess);
            const losses = exits.filter(Exit.isFailure);
            assert.strictEqual(wins.length, 1);
            assert.strictEqual(losses.length, 1);
            const failure = losses[0] === undefined ? undefined : Exit.findErrorOption(losses[0]);
            assert.isTrue(
              Option.exists(failure ?? Option.none(), (error) => error._tag === "InvalidGrant"),
            );
            const after = (yield* sessions.list(
              caller.userId,
              Sessions.SessionId(caller.sessionId),
            )).length;
            assert.strictEqual(after, before + 1, "exactly one session was minted for the grant");
          }).pipe(Effect.provide(layer())),
      );

      it.effect(
        "the issued session records the device's address and user agent, and inherits the approver's amr",
        () =>
          Effect.gen(function* () {
            const { issued } = yield* approvedGrant("meta@example.com", ["pwd", "otp", "mfa"]);
            const redeemed = yield* poll(issued, { userAgent: "smart-tv/9.1" });
            assert.deepStrictEqual(Option.getOrNull(redeemed.session.ipAddress), DEVICE_IP);
            assert.deepStrictEqual(Option.getOrNull(redeemed.session.userAgent), "smart-tv/9.1");
            assert.deepStrictEqual(redeemed.session.amr, ["pwd", "otp", "mfa"]);
            // A normal session: the token verifies like any other.
            const sessions = yield* Sessions.Sessions;
            const verified = yield* sessions.verify(redeemed.token);
            assert.strictEqual(verified.session.id, redeemed.session.id);
          }).pipe(Effect.provide(layer())),
      );
    });

    describe("claim, then decide (BEH-EA-301/313)", () => {
      it.effect(
        "opening the page claims an unclaimed code exactly once; a different user cannot claim it",
        () =>
          Effect.gen(function* () {
            const issued = yield* requestCode();
            const first = yield* signedIn("first@example.com");
            const second = yield* signedIn("second@example.com");

            const opened = yield* verify(issued, Option.some(first));
            const again = yield* verify(issued, Option.some(first));
            assert.strictEqual(opened.status, "pending");
            assert.deepStrictEqual(again, opened, "opening it twice is a no-op");
            assert.deepStrictEqual(
              Option.map(yield* grantOf(issued), (g) => g.userId),
              Option.some(Option.some(first.userId)),
            );

            const other = yield* verify(issued, Option.some(second));
            assert.isTrue(Option.isNone(other.context));
            assert.deepStrictEqual(
              Option.map(yield* grantOf(issued), (g) => g.userId),
              Option.some(Option.some(first.userId)),
            );
          }).pipe(Effect.provide(layer())),
      );

      it.effect(
        "only the claiming user sees the client and scope; anyone else sees the code and its status",
        () =>
          Effect.gen(function* () {
            const plugin = yield* service;
            yield* plugin.registerClient({
              name: "Set-top box",
              clientId: "stb",
              scopes: ["playback"],
            });
            const issued = yield* requestCode({ clientId: "stb", scope: ["playback"] });
            const owner = yield* signedIn("owner@example.com");
            const stranger = yield* signedIn("stranger@example.com");

            const mine = yield* verify(issued, Option.some(owner));
            if (Option.isNone(mine.context)) return assert.fail("the claimer sees no context");
            assert.deepStrictEqual(mine.context.value.client, {
              clientId: "stb",
              name: "Set-top box",
            });
            assert.deepStrictEqual(mine.context.value.scopes, ["playback"]);

            const anonymous = yield* verify(issued, Option.none());
            const other = yield* verify(issued, Option.some(stranger));
            for (const view of [anonymous, other]) {
              assert.deepStrictEqual(
                { userCode: view.userCode, status: view.status },
                { userCode: issued.userCode, status: "pending" },
              );
              assert.isTrue(Option.isNone(view.context));
            }
          }).pipe(Effect.provide(layer())),
      );

      it.effect("an anonymous caller never claims: the code stays unclaimed", () =>
        Effect.gen(function* () {
          const issued = yield* requestCode();
          yield* verify(issued, Option.none());
          assert.isTrue(Option.exists(yield* grantOf(issued), (g) => Option.isNone(g.userId)));
        }).pipe(Effect.provide(layer())),
      );

      it.effect(
        "approving without a prior claim is refused; so is approving as someone who did not claim it",
        () =>
          Effect.gen(function* () {
            const issued = yield* requestCode();
            const user = yield* signedIn("unclaimed@example.com");
            const stranger = yield* signedIn("intruder@example.com");
            const refused = yield* approve(issued, user).pipe(Effect.flip);
            assert.strictEqual(refused._tag, "UserCodeNotClaimed");

            yield* verify(issued, Option.some(user));
            // Claimed by someone else: indistinguishable from an unknown code.
            const foreign = yield* approve(issued, stranger).pipe(Effect.flip);
            assert.strictEqual(foreign._tag, "InvalidUserCode");
            const foreignDeny = yield* deny(issued, stranger).pipe(Effect.flip);
            assert.strictEqual(foreignDeny._tag, "InvalidUserCode");
          }).pipe(Effect.provide(layer())),
      );

      it.effect(
        "a decision is final: two racing decisions cannot both win, and a decided code is not pending again",
        () =>
          Effect.gen(function* () {
            const issued = yield* requestCode();
            const user = yield* signedIn("decider@example.com");
            yield* verify(issued, Option.some(user));
            const results = yield* Effect.all(
              [Effect.exit(approve(issued, user)), Effect.exit(deny(issued, user))],
              { concurrency: 2 },
            );
            assert.strictEqual(results.filter(Exit.isSuccess).length, 1);
            const status = Option.getOrNull(Option.map(yield* grantOf(issued), (g) => g.status));
            assert.isTrue(status === "approved" || status === "denied");
            // A terminal state never returns to pending: deciding again is refused.
            const again = yield* approve(issued, user).pipe(Effect.flip);
            assert.strictEqual(again._tag, "InvalidUserCode");
          }).pipe(Effect.provide(layer())),
      );

      it.effect(
        "an impersonation session may not decide, and requiredAssurance gates an approval",
        () =>
          Effect.gen(function* () {
            const issued = yield* requestCode();
            const user = yield* signedIn("weak@example.com", ["pwd"]);
            yield* verify(issued, Option.some(user));
            const impersonated = yield* approve(issued, { ...user, impersonated: true }).pipe(
              Effect.flip,
            );
            assert.strictEqual(impersonated._tag, "DeviceApprovalRefused");
            const weak = yield* approve(issued, user).pipe(Effect.flip);
            assert.strictEqual(weak._tag, "DeviceApprovalRefused");
            // A denial is never gated on assurance: anyone may say no.
            assert.strictEqual((yield* deny(issued, user)).status, "denied");
          }).pipe(Effect.provide(layer({ config: { requiredAssurance: "aal2" } }))),
      );

      it.effect("an approving session that reaches the required assurance approves", () =>
        Effect.gen(function* () {
          const issued = yield* requestCode();
          const strong = yield* signedIn("strong@example.com", ["pwd", "otp", "mfa"]);
          yield* verify(issued, Option.some(strong));
          assert.strictEqual((yield* approve(issued, strong)).status, "approved");
        }).pipe(Effect.provide(layer({ config: { requiredAssurance: "aal2" } }))),
      );
    });

    describe("rate limits (BEH-EA-303)", () => {
      it.effect("POST /device/code is 5 per window per source; a sixth is rate limited", () =>
        Effect.gen(function* () {
          for (let i = 0; i < 5; i++) yield* requestCode();
          const sixth = yield* requestCode().pipe(Effect.flip);
          assert.strictEqual(sixth._tag, "RateLimited");
          // Another source has its own budget.
          yield* requestCode({ ip: "203.0.113.99" });
        }).pipe(Effect.provide(layer({ rateLimiter: "enforcing" }))),
      );

      it.effect(
        "five failed user-code lookups exhaust the budget: the sixth attempt is rate limited, per source",
        () =>
          Effect.gen(function* () {
            const issued = yield* requestCode();
            const caller = yield* signedIn("guesser@example.com");
            const wrong = "BCDF-GHJK";
            for (let i = 0; i < 5; i++) {
              const miss = yield* verify(issued, Option.none(), wrong).pipe(Effect.flip);
              assert.strictEqual(miss._tag, "InvalidUserCode");
            }
            const sixth = yield* verify(issued, Option.none(), wrong).pipe(Effect.flip);
            assert.strictEqual(sixth._tag, "RateLimited");
            // Once spent, even the *right* code is refused from that source until the window passes.
            const right = yield* verify(issued, Option.some(caller)).pipe(Effect.flip);
            assert.strictEqual(right._tag, "RateLimited");
            yield* TestClock.adjust(Duration.minutes(16));
            assert.strictEqual((yield* verify(issued, Option.none())).status, "pending");
          }).pipe(
            Effect.provide(
              layer({ rateLimiter: "enforcing", config: { expiresIn: Duration.hours(2) } }),
            ),
          ),
      );

      it.effect(
        "a session has its own failure budget, so rotating source addresses does not reset it",
        () =>
          Effect.gen(function* () {
            const plugin = yield* service;
            const issued = yield* requestCode();
            const caller = yield* signedIn("rotator@example.com");
            for (let i = 0; i < 5; i++) {
              const miss = yield* plugin
                .verify({ userCode: "BCDF-GHJK", ip: `198.51.100.${i + 1}` }, Option.some(caller))
                .pipe(Effect.flip);
              assert.strictEqual(miss._tag, "InvalidUserCode");
            }
            const sixth = yield* plugin
              .verify({ userCode: issued.userCode, ip: "198.51.100.200" }, Option.some(caller))
              .pipe(Effect.flip);
            assert.strictEqual(sixth._tag, "RateLimited");
          }).pipe(Effect.provide(layer({ rateLimiter: "enforcing" }))),
      );

      it.effect("polling with codes that never existed spends a per-source budget", () =>
        Effect.gen(function* () {
          const plugin = yield* service;
          const bogus = {
            deviceCode: Redacted.make("nope"),
            clientId: CLI_CLIENT_ID,
            ip: DEVICE_IP,
          };
          for (let i = 0; i < 3; i++) {
            const miss = yield* plugin.poll(bogus).pipe(Effect.flip);
            assert.strictEqual(miss._tag, "InvalidGrant");
          }
          const refused = yield* plugin.poll(bogus).pipe(Effect.flip);
          assert.strictEqual(refused._tag, "RateLimited");
        }).pipe(
          Effect.provide(
            layer({
              rateLimiter: "enforcing",
              config: {
                ...DeviceAuthorization.DeviceAuthorizationConfig.defaultValue(),
                invalidGrantRateLimit: { limit: 3, window: Duration.minutes(15) },
              },
            }),
          ),
        ),
      );

      it.effect("every budget is introspectable through the rate-limit registry", () =>
        Effect.gen(function* () {
          const registry = yield* RateLimits.RateLimitsRegistry;
          const rules = yield* registry.registered;
          const mine = rules.filter((rule) => rule.plugin === "device_authorization");
          assert.deepStrictEqual(mine.map((rule) => `${rule.group}/${rule.endpoint}`).sort(), [
            "device_authorization.decision/approve",
            "device_authorization.decision/approve",
            "device_authorization.decision/deny",
            "device_authorization.decision/deny",
            "device_authorization.verification/verify",
            "device_authorization.verification/verify",
            "device_authorization/code",
            "device_authorization/code",
            "device_authorization/token",
          ]);
        }).pipe(Effect.provide(layer())),
      );
    });

    describe("issuing the session (BEH-EA-304)", () => {
      it.effect("a suspended user gets no session, and the grant is kept", () =>
        Effect.gen(function* () {
          const { issued, caller } = yield* approvedGrant("suspended@example.com");
          const users = yield* Users.Users;
          yield* users.setStatus(caller.userId, "suspended", { reason: "test" }).pipe(Effect.orDie);
          const refused = yield* poll(issued).pipe(Effect.flip);
          assert.strictEqual(refused._tag, "UserSuspended");
          assert.isTrue(Option.isSome(yield* grantOf(issued)));
        }).pipe(Effect.provide(layer())),
      );

      it.effect(
        "a user deleted after approving leaves an unredeemable grant: invalid_grant, and the row is dropped",
        () =>
          Effect.gen(function* () {
            const { issued, caller } = yield* approvedGrant("gone@example.com");
            const users = yield* Users.Users;
            yield* users.delete(caller.userId).pipe(Effect.orDie);
            const refused = yield* poll(issued).pipe(Effect.flip);
            assert.strictEqual(refused._tag, "InvalidGrant");
            assert.isTrue(Option.isNone(yield* grantOf(issued)));
          }).pipe(Effect.provide(layer())),
      );
    });

    describe("events, audit, erasure, export and retention (BEH-EA-306)", () => {
      it.effect(
        "an approval and a denial are audited with the approver and the client, and no code",
        () =>
          Effect.gen(function* () {
            const approved = yield* requestCode();
            const denied = yield* requestCode({ ip: "203.0.113.50" });
            const caller = yield* signedIn("audited@example.com");
            yield* verify(approved, Option.some(caller));
            yield* approve(approved, caller);
            yield* verify(denied, Option.some(caller));
            yield* deny(denied, caller);
            const audit = yield* AuditLog.AuditLog;
            const approvals = yield* audit.list({ eventTag: "auth.deviceAuthorization.approved" });
            const denials = yield* audit.list({ eventTag: "auth.deviceAuthorization.denied" });
            assert.strictEqual(approvals.length, 1);
            assert.strictEqual(denials.length, 1);
            assert.deepStrictEqual(approvals[0]?.actorUserId, Option.some(caller.userId));
            const text = JSON.stringify([approvals, denials]);
            assert.include(text, CLI_CLIENT_ID);
            assert.notInclude(text, Redacted.value(approved.deviceCode));
            assert.notInclude(text, UserCode.normalize(approved.userCode));
          }).pipe(Effect.provide(layer())),
      );

      it.effect(
        "a redeemed grant is announced as an ordinary sign-in with the deviceAuthorization strategy",
        () =>
          Effect.gen(function* () {
            const { issued, caller } = yield* approvedGrant("signedin@example.com");
            yield* poll(issued);
            const audit = yield* AuditLog.AuditLog;
            const signedInRows = yield* audit.list({ eventTag: "auth.user.signedIn" });
            assert.isTrue(
              signedInRows.some(
                (row) =>
                  Option.exists(row.actorUserId, (id) => id === caller.userId) &&
                  JSON.stringify(row.payload).includes(DeviceAuthorization.STRATEGY),
              ),
            );
          }).pipe(Effect.provide(layer())),
      );

      it.effect("erasing a user deletes the grants they claimed or decided, and only theirs", () =>
        Effect.gen(function* () {
          const registry = yield* Erasure.ErasureRegistry;
          const mine = yield* requestCode();
          const theirs = yield* requestCode({ ip: "203.0.113.51" });
          const unclaimed = yield* requestCode({ ip: "203.0.113.52" });
          const me = yield* signedIn("erased@example.com");
          const other = yield* signedIn("kept@example.com");
          yield* verify(mine, Option.some(me));
          yield* verify(theirs, Option.some(other));

          const contribution = (yield* registry.contributions).find(
            (entry) => entry.id === "device_authorization",
          );
          if (contribution === undefined) return assert.fail("no erasure contribution");
          yield* contribution.erase({ userId: me.userId });
          assert.isTrue(Option.isNone(yield* grantOf(mine)));
          assert.isTrue(Option.isSome(yield* grantOf(theirs)));
          assert.isTrue(Option.isSome(yield* grantOf(unclaimed)));
        }).pipe(Effect.provide(layer())),
      );

      it.effect("the data export lists the person's grants, and never a code or a hash", () =>
        Effect.gen(function* () {
          const registry = yield* DataExport.DataExportRegistry;
          const issued = yield* requestCode({ scope: [] });
          const me = yield* signedIn("exported@example.com");
          yield* verify(issued, Option.some(me));
          const contribution = (yield* registry.contributions).find(
            (entry) => entry.id === "device_authorization",
          );
          if (contribution === undefined) return assert.fail("no export contribution");
          const section = yield* contribution.collect({ userId: me.userId });
          const text = JSON.stringify(section);
          assert.include(text, CLI_CLIENT_ID);
          assert.include(text, "pending");
          assert.notInclude(text, Redacted.value(issued.deviceCode));
          assert.notMatch(text, /[0-9a-f]{64}/);
        }).pipe(Effect.provide(layer())),
      );

      it.effect("purgeExpired deletes only rows past their expiry, and reports how many", () =>
        Effect.gen(function* () {
          const plugin = yield* service;
          const old = yield* requestCode();
          yield* TestClock.adjust(Duration.minutes(10));
          const fresh = yield* requestCode({ ip: "203.0.113.60" });
          yield* TestClock.adjust(Duration.minutes(6));
          // `old` expired a minute ago; `fresh` has nine minutes left.
          assert.strictEqual(yield* plugin.purgeExpired(), 1);
          assert.isTrue(Option.isNone(yield* grantOf(old)));
          assert.isTrue(Option.isSome(yield* grantOf(fresh)));
          assert.strictEqual(yield* plugin.purgeExpired(), 0);
        }).pipe(Effect.provide(layer())),
      );
    });
  });
}
