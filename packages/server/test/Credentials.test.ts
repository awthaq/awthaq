// Hand-wired on purpose: the credential module is the unit under test; the fixtures here are its own (plan 08 exemption).
// spec/behaviors/09-authentication-middleware.md, BEH-EA-065 through BEH-EA-072; ADR-EA-042.
//
// The policy is tested once, at `Credentials`' interface, as a table: 23 request shapes (T1 to T23) run through the
// three tiers. Path A over `HttpApiTest` runs the same table in `Authentication.test.ts` (group A), and the
// qadi and web adapters keep only what they add.
import { Sessions, Users } from "@awthaq/core";
import { Api } from "@awthaq/api";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Credentials from "../src/Credentials.ts";
import {
  A,
  claimed,
  headersFor,
  isAny,
  layerFor,
  none,
  requestWith,
  rows,
  secureDomain,
  seed,
  show,
  tiers,
  variantOf,
} from "./support/CredentialTable.ts";
import type { Variant } from "./support/CredentialTable.ts";

describe("Credentials: the resolution table (T1 to T23 x user, machine, optional tier)", () => {
  for (const row of rows) {
    for (const [name, tier] of tiers) {
      const expected = row[name];
      it.effect(`${row.id} ${name}: ${expected}`, () =>
        Effect.gen(function* () {
          const tokens = yield* seed;
          const credentials = yield* Credentials.make;
          const request = requestWith(headersFor(row, tokens));
          const presented = yield* Credentials.fromRequest(request);
          const outcome = yield* credentials
            .resolve(
              presented,
              tier,
              Credentials.httpScope(request, Api.AuthRequestContext.noRequest),
            )
            .pipe(
              Effect.map(show),
              Effect.catchTag("Unauthenticated", () => Effect.succeed(none)),
            );
          assert.strictEqual(outcome, expected);
        }).pipe(Effect.provide(layerFor(variantOf(row)))),
      );
    }
  }

  it.effect("T17: a claimed bearer that fails never reaches Sessions.verify", () => {
    const verifies = { count: 0 };
    return Effect.gen(function* () {
      const credentials = yield* Credentials.make;
      const request = requestWith({ authorization: "Bearer jwtu.bad" });
      const presented = yield* Credentials.fromRequest(request);
      const failure = yield* credentials
        .resolve(
          presented,
          Credentials.userTier,
          Credentials.httpScope(request, Api.AuthRequestContext.noRequest),
        )
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "Unauthenticated");
      assert.strictEqual(verifies.count, 0);
    }).pipe(
      Effect.provide(
        layerFor({
          decorate: (base) => ({
            ...base,
            verify: (token) =>
              Effect.sync(() => {
                verifies.count += 1;
              }).pipe(Effect.andThen(base.verify(token))),
          }),
        }),
      ),
    );
  });
});

// ---- group M: the per-scope memo ------------------------------------------------------------------------

describe("Credentials: the per-request memo (PCS-006, TS-003, NHS-006)", () => {
  const countingSessions = (verifies: { count: number }): Variant => ({
    decorate: (base) => ({
      ...base,
      verify: (token) => {
        return Effect.sync(() => {
          verifies.count += 1;
        }).pipe(
          Effect.andThen(Effect.sleep(Duration.millis(10))),
          Effect.andThen(base.verify(token)),
        );
      },
    }),
  });

  it.effect(
    "M1 PCS-006: two concurrent steps for one scope and credential call verify exactly once",
    () => {
      const verifies = { count: 0 };
      return Effect.gen(function* () {
        const tokens = yield* seed;
        const credentials = yield* Credentials.make;
        const request = requestWith({ cookie: `__Host-session=${tokens.own}` });
        const presented = yield* Credentials.fromRequest(request);
        const scope = Credentials.httpScope(request, Api.AuthRequestContext.noRequest);
        const call = credentials.step("cookie", presented, Credentials.userTier, scope);
        const fiber = yield* Effect.all([call, call, call], { concurrency: "unbounded" }).pipe(
          Effect.forkChild,
        );
        yield* TestClock.adjust(Duration.millis(20));
        const all = yield* Fiber.join(fiber);
        assert.deepStrictEqual(all.map(show), ["A@cookie", "A@cookie", "A@cookie"]);
        assert.strictEqual(verifies.count, 1);
      }).pipe(Effect.provide(layerFor(countingSessions(verifies))));
    },
  );

  it.effect("M2 NHS-006: a re-wrapped request (request.modify) shares the original's scope", () => {
    const verifies = { count: 0 };
    return Effect.gen(function* () {
      const tokens = yield* seed;
      const credentials = yield* Credentials.make;
      const request = requestWith({ cookie: `__Host-session=${tokens.own}` });
      const prefixed = request.modify({ url: "/y" });
      const presented = yield* Credentials.fromRequest(request);
      const first = yield* credentials
        .step(
          "cookie",
          presented,
          Credentials.userTier,
          Credentials.httpScope(request, Api.AuthRequestContext.noRequest),
        )
        .pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.millis(20));
      yield* Fiber.join(first);
      yield* credentials.step(
        "cookie",
        presented,
        Credentials.userTier,
        Credentials.httpScope(prefixed, Api.AuthRequestContext.noRequest),
      );
      assert.strictEqual(verifies.count, 1);
    }).pipe(Effect.provide(layerFor(countingSessions(verifies))));
  });

  it.effect("M3 TS-003: an interrupted first step does not wedge a second caller", () => {
    const verifies = { count: 0 };
    return Effect.gen(function* () {
      const credentials = yield* Credentials.make;
      const request = requestWith({ cookie: "__Host-session=some-id.some-secret" });
      const presented = yield* Credentials.fromRequest(request);
      const scope = Credentials.httpScope(request, Api.AuthRequestContext.noRequest);
      const step = credentials
        .step("cookie", presented, Credentials.userTier, scope)
        .pipe(Effect.flip);
      const first = yield* step.pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(first);
      const second = yield* step.pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.millis(20));
      const failure = yield* Fiber.join(second);
      assert.strictEqual(failure._tag, "Unauthenticated");
      assert.strictEqual(verifies.count, 2);
    }).pipe(Effect.provide(layerFor(countingSessions(verifies))));
  });

  it.effect("M4 PCS-006: a claimed credential resolves once per scope across two tiers", () =>
    Effect.gen(function* () {
      const credentials = yield* Credentials.make;
      const request = requestWith({ authorization: "Bearer jwtu.ok" });
      const presented = yield* Credentials.fromRequest(request);
      const scope = Credentials.httpScope(request, Api.AuthRequestContext.noRequest);
      const before = claimed.resolves;
      yield* credentials.resolve(presented, Credentials.userTier, scope);
      yield* credentials.resolve(presented, Credentials.machineTier, scope);
      assert.strictEqual(claimed.resolves - before, 1);
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect(
    "M5 PIL-005: a rotating verify hands exactly one Rotation to scope.deliver, carrying the carrier it came in on",
    () => {
      const rotations: Array<Credentials.Rotation> = [];
      return Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const issued = yield* sessions.issue({ userId: Users.UserId(A) });
        yield* TestClock.adjust(Duration.millis(200));
        const credentials = yield* Credentials.make;
        const request = requestWith({ authorization: `Bearer ${Redacted.value(issued.token)}` });
        const presented = yield* Credentials.fromRequest(request);
        const scope = {
          ...Credentials.httpScope(request, Api.AuthRequestContext.noRequest),
          deliver: (rotation: Credentials.Rotation) =>
            Effect.sync(() => {
              rotations.push(rotation);
            }),
        };
        yield* credentials.resolve(presented, Credentials.userTier, scope);
        yield* credentials.resolve(presented, Credentials.machineTier, scope);
        assert.strictEqual(rotations.length, 1);
        assert.strictEqual(rotations[0]?.carrier, "bearer");
        assert.strictEqual(rotations[0]?.session.id, issued.session.id);
        assert.notStrictEqual(
          Redacted.value(rotations[0]?.token ?? Redacted.make("")),
          Redacted.value(issued.token),
        );
      }).pipe(
        Effect.provide(
          layerFor({
            sessionConfig: Layer.succeed(Sessions.SessionConfig, {
              absolute: Duration.millis(1000),
              idle: Duration.millis(500),
              touchEvery: Duration.millis(100),
            }),
          }),
        ),
      );
    },
  );
});

// ---- group O: the outage short-circuit (MA-004) ---------------------------------------------------------

describe("Credentials: a store outage stops the chain (MA-004)", () => {
  const outage = new Api.StoreUnavailable({ operation: "Sessions.verify" });
  const down: Variant = { decorate: (base) => ({ ...base, verify: () => Effect.fail(outage) }) };

  it.effect(
    "O1: a cookie-carrier outage fails StoreUnavailable, and the bearer step on the same scope fails with it, not Unauthenticated",
    () =>
      Effect.gen(function* () {
        const credentials = yield* Credentials.make;
        const request = requestWith({
          cookie: "__Host-session=some-id.some-secret",
          authorization: "Bearer other-id.other-secret",
        });
        const presented = yield* Credentials.fromRequest(request);
        const scope = Credentials.httpScope(request, Api.AuthRequestContext.noRequest);
        const first = yield* credentials
          .step("cookie", presented, Credentials.userTier, scope)
          .pipe(Effect.flip);
        assert.strictEqual(first._tag, "StoreUnavailable");
        const second = yield* credentials
          .step("bearer", presented, Credentials.userTier, scope)
          .pipe(Effect.flip);
        assert.strictEqual(second._tag, "StoreUnavailable");
      }).pipe(Effect.provide(layerFor(down))),
  );

  it.effect("O2: a claimed-credential outage stops resolve; later carriers are not tried", () => {
    const verifies = { count: 0 };
    return Effect.gen(function* () {
      const credentials = yield* Credentials.make;
      const request = requestWith({
        authorization: "Bearer svc.outage",
        cookie: "__Host-session=some-id.some-secret",
      });
      const presented = yield* Credentials.fromRequest(request);
      const failure = yield* credentials
        .resolve(
          { ...presented, cookie: Option.none(), impersonation: Option.none() },
          Credentials.machineTier,
          Credentials.httpScope(request, Api.AuthRequestContext.noRequest),
        )
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "StoreUnavailable");
      assert.strictEqual(verifies.count, 0);
    }).pipe(
      Effect.provide(
        layerFor({
          decorate: (base) => ({
            ...base,
            verify: (token) =>
              Effect.sync(() => {
                verifies.count += 1;
              }).pipe(Effect.andThen(base.verify(token))),
          }),
        }),
      ),
    );
  });

  it.effect(
    "O3: the optional tier surfaces an outage as StoreUnavailable, never as anonymous",
    () =>
      Effect.gen(function* () {
        const credentials = yield* Credentials.make;
        const request = requestWith({ cookie: "__Host-session=some-id.some-secret" });
        const presented = yield* Credentials.fromRequest(request);
        const failure = yield* credentials
          .resolve(
            presented,
            Credentials.optionalTier,
            Credentials.httpScope(request, Api.AuthRequestContext.noRequest),
          )
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "StoreUnavailable");
      }).pipe(Effect.provide(layerFor(down))),
  );
});

// ---- group D: tiers derive from the declarations (BEH-EA-072) --------------------------------------------

describe("Credentials: tiers are derived from the middleware declarations (BEH-EA-072)", () => {
  const declarations = [
    ["Authentication", Api.Authentication, Credentials.userTier],
    [
      "AdminAuthentication",
      Api.AdminAuthentication,
      Credentials.tier(Api.AdminAuthentication, isAny),
    ],
    ["OptionalAuthentication", Api.OptionalAuthentication, Credentials.optionalTier],
    ["MachineAuthentication", Api.MachineAuthentication, Credentials.machineTier],
  ] as const;

  it("D1: every declared key of every authentication middleware is a carrier, so the tier lists every scheme", () => {
    for (const [name, declaration, tier] of declarations) {
      assert.strictEqual(
        tier.carriers.length,
        Object.keys(declaration.security).length,
        `${name} declares a key that is not a known carrier`,
      );
    }
  });

  it("D2: the tiers' carriers equal the declarations' key order", () => {
    for (const [, declaration, tier] of declarations) {
      assert.deepStrictEqual(tier.carriers, Object.keys(declaration.security));
    }
    assert.deepStrictEqual(Credentials.machineTier.carriers, [
      "impersonation",
      "cookie",
      "apiKey",
      "bearer",
    ]);
  });

  it("D3: a redeclared record ({ bearer, cookie }) yields a tier in that order", () => {
    const reordered = Credentials.tier(
      { security: { bearer: Api.BearerToken, cookie: Api.SessionCookie } },
      (_principal): _principal is Api.Principal => true,
    );
    assert.deepStrictEqual(reordered.carriers, ["bearer", "cookie"]);
  });

  it("D4: a key that is not a carrier is dropped, so a typo cannot silently reorder the chain", () => {
    const odd = Credentials.tier(
      { security: { session: Api.SessionCookie, bearer: Api.BearerToken } },
      (_principal): _principal is Api.Principal => true,
    );
    assert.deepStrictEqual(odd.carriers, ["bearer"]);
  });
});

// ---- group P: parsing parity with Effect's own security decode ---------------------------------------------

describe("Credentials: the reader equals Effect's security decode (parity)", () => {
  const decoded = <S extends Parameters<typeof HttpApiBuilder.securityDecode>[0]>(
    security: S,
    request: HttpServerRequest.HttpServerRequest,
  ) =>
    HttpApiBuilder.securityDecode(security).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      Effect.provideService(HttpServerRequest.ParsedSearchParams, {}),
      Effect.map((value) => (Redacted.isRedacted(value) ? Redacted.value(value) : "")),
    );

  const valueOf = (option: Option.Option<Redacted.Redacted<string>>) =>
    Option.match(option, { onNone: () => "", onSome: Redacted.value });

  it.effect("P1: the bearer reader equals securityDecode(Api.BearerToken)", () =>
    Effect.gen(function* () {
      for (const header of [
        "Bearer t",
        "bearer t",
        "BEARER  t",
        "Bearer",
        "Bearer ",
        "Basic t",
        "Bearert",
        "Bearer t ",
        "Bearer a b",
        "",
      ]) {
        const request = requestWith(header === "" ? {} : { authorization: header });
        const presented = yield* Credentials.fromRequest(request);
        assert.strictEqual(
          valueOf(presented.bearer),
          yield* decoded(Api.BearerToken, request),
          `authorization: ${JSON.stringify(header)}`,
        );
      }
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect(
    "P2: the cookie reader equals securityDecode(Api.SessionCookie) under the default config",
    () =>
      Effect.gen(function* () {
        for (const cookie of [
          "",
          "__Host-session=abc",
          "__Host-session=",
          "other=1; __Host-session=x.y",
        ]) {
          const request = requestWith(cookie === "" ? {} : { cookie });
          const presented = yield* Credentials.fromRequest(request);
          assert.strictEqual(valueOf(presented.cookie), yield* decoded(Api.SessionCookie, request));
          assert.strictEqual(
            valueOf(presented.impersonation),
            yield* decoded(Api.ImpersonationCookie, request),
          );
        }
      }).pipe(Effect.provide(layerFor())),
  );

  it.effect("P2: the cookie reader reads the configured name under SecureDomain", () =>
    Effect.gen(function* () {
      const request = requestWith({
        cookie: "__Host-session=host; __Secure-session=secure; __Secure-impersonation=imp",
      });
      const presented = yield* Credentials.fromRequest(request);
      assert.strictEqual(valueOf(presented.cookie), "secure");
      assert.strictEqual(valueOf(presented.impersonation), "imp");
    }).pipe(Effect.provide(layerFor({ cookie: secureDomain }))),
  );

  it.effect("P3: x-api-key is read as sent, and an empty value is absent", () =>
    Effect.gen(function* () {
      const request = requestWith({ "x-api-key": "ak_1" });
      const presented = yield* Credentials.fromRequest(request);
      assert.strictEqual(valueOf(presented.apiKey), yield* decoded(Api.ApiKeyHeader, request));
      const empty = yield* Credentials.fromRequest(requestWith({ "x-api-key": "" }));
      assert.isTrue(Option.isNone(empty.apiKey));
    }).pipe(Effect.provide(layerFor())),
  );
});

// ---- the collecting scope (a framework call) -------------------------------------------------------------

describe("Credentials: the collecting scope", () => {
  it.effect(
    "C1: rotations are collected with their carrier and never delivered to a response",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const issued = yield* sessions.issue({ userId: Users.UserId(A) });
        yield* TestClock.adjust(Duration.millis(200));
        const credentials = yield* Credentials.make;
        const { scope, rotations } = yield* Credentials.collecting;
        const presented = yield* Credentials.presented({
          cookie: (name) => (name === "__Host-session" ? Redacted.value(issued.token) : undefined),
          header: () => undefined,
        });
        const resolved = yield* credentials.resolve(presented, Credentials.userTier, scope);
        assert.strictEqual(resolved._tag, "Session");
        const collected = yield* rotations;
        assert.strictEqual(collected.length, 1);
        assert.strictEqual(collected[0]?.carrier, "cookie");
      }).pipe(
        Effect.provide(
          layerFor({
            sessionConfig: Layer.succeed(Sessions.SessionConfig, {
              absolute: Duration.millis(1000),
              idle: Duration.millis(500),
              touchEvery: Duration.millis(100),
            }),
          }),
        ),
      ),
  );

  it.effect("C2: claim is never consulted for a cookie-only call", () => {
    const before = claimed.resolves;
    return Effect.gen(function* () {
      const credentials = yield* Credentials.make;
      const { scope } = yield* Credentials.collecting;
      const presented = yield* Credentials.presented({
        cookie: () => undefined,
        header: (name) => (name === "authorization" ? "Bearer jwtu.ok" : undefined),
      });
      const failure = yield* credentials
        .resolve(presented, Credentials.userTier, scope)
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "Unauthenticated");
      assert.strictEqual(claimed.resolves, before);
    }).pipe(Effect.provide(layerFor()));
  });
});
