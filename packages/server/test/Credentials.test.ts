// Hand-wired on purpose: the credential module is the unit under test; the fixtures here are its own (plan 08 exemption).
// spec/behaviors/09-authentication-middleware.md, BEH-EA-065 through BEH-EA-072; ADR-EA-042.
//
// The policy is tested once, at `Credentials`' interface, as a table: 23 request shapes (T1 to T23) run through the
// three tiers. Path A over `HttpApiTest` runs the same table in `Authentication.test.ts` (group A), and the
// qadi and web adapters keep only what they add.
import { AuditLog, AuthEvents, Persistence, SessionCookie, Sessions, Users } from "@awthaq/core";
import { Api } from "@awthaq/api";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as Credentials from "../src/Credentials.ts";

// ---- fixtures -------------------------------------------------------------------------------------------

const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const service = (id: string) =>
  new Api.ServicePrincipal({ ref: new Api.PrincipalRef({ type: "service", id }), scopes: [] });
const user = (id: string) =>
  new Api.UserPrincipal({
    ref: new Api.PrincipalRef({ type: "user", id }),
    sessionId: "stateless",
  });
const apiKey = (id: string) =>
  new Api.ApiKeyPrincipal({ ref: new Api.PrincipalRef({ type: "apikey", id }), scopes: [] });

/** Counts contribution `resolve` calls, so a test can see how often a claimed credential was resolved. */
const claimed = { resolves: 0 };

const contributions = Layer.mergeAll(
  Credentials.contribute("bearer", {
    id: "svc",
    claims: (raw) => raw.startsWith("svc."),
    resolve: (credential) =>
      Redacted.value(credential) === "svc.outage"
        ? Effect.fail(new Api.StoreUnavailable({ operation: "svc.resolve" }))
        : Effect.sync(() => {
            claimed.resolves += 1;
            return service("svc");
          }),
  }),
  Credentials.contribute("bearer", {
    id: "jwtu",
    claims: (raw) => raw.startsWith("jwtu."),
    resolve: (credential) =>
      Redacted.value(credential) === "jwtu.bad"
        ? Effect.fail(new Api.Unauthenticated())
        : Effect.sync(() => {
            claimed.resolves += 1;
            return user("jwt-user");
          }),
  }),
  Credentials.contribute("apiKey", {
    id: "keys",
    claims: (raw) => raw.startsWith("ak_"),
    resolve: (credential) =>
      Redacted.value(credential).startsWith("ak_bad")
        ? Effect.fail(new Api.Unauthenticated())
        : Effect.succeed(apiKey("key")),
  }),
);

const sessionStack = (decorate?: (base: Sessions.SessionsShape) => Sessions.SessionsShape) => {
  const sessions = Sessions.layer.pipe(Layer.provide(Persistence.memory));
  return decorate === undefined
    ? sessions
    : Layer.effect(
        Sessions.Sessions,
        Effect.map(Sessions.Sessions, (base) => decorate(base)),
      ).pipe(Layer.provide(sessions));
};

interface Variant {
  readonly resolver?: Layer.Layer<Credentials.PrincipalResolver>;
  readonly cookie?: Layer.Layer<never>;
  readonly decorate?: (base: Sessions.SessionsShape) => Sessions.SessionsShape;
  readonly sessionConfig?: Layer.Layer<never>;
}

const layerFor = (variant: Variant = {}) =>
  Layer.mergeAll(
    Layer.empty,
    variant.resolver ?? Credentials.PrincipalResolverLive,
    variant.cookie ?? Layer.empty,
  ).pipe(
    Layer.provideMerge(contributions.pipe(Layer.provideMerge(Credentials.CredentialResolversLive))),
    Layer.provideMerge(sessionStack(variant.decorate)),
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layer.pipe(Layer.provide(Persistence.memory))),
    Layer.provide(
      variant.sessionConfig ??
        Layer.succeed(Sessions.SessionConfig, Sessions.SessionConfig.defaultValue()),
    ),
    Layer.provide(NodeCrypto.layer),
  );

const secureDomain = SessionCookie.config({
  mode: SessionCookie.SecureDomain({ domain: "example.com", sameSite: "lax" }),
});

/** The sessions every row refers to by name. */
const seed = Effect.gen(function* () {
  const sessions = yield* Sessions.Sessions;
  const issue = (userId: string, actingAs?: { readonly type: string; readonly id: string }) =>
    sessions
      .issue({
        userId: Users.UserId(userId),
        ...(actingAs === undefined ? {} : { actingAs }),
      })
      .pipe(Effect.map((issued) => Redacted.value(issued.token)));
  return {
    own: yield* issue(A),
    other: yield* issue(B),
    imp: yield* issue(B, { type: "user", id: A }),
    planted: yield* issue(B),
    stale: "stale.token",
  };
});
type Tokens = Effect.Success<typeof seed>;

const requestWith = (headers: Record<string, string>) =>
  HttpServerRequest.fromWeb(new Request("http://localhost/whatever", { headers }));

const who = (id: string) => (id === A ? "A" : id === B ? "B" : id);

/** `A@cookie`, `B~A@impersonation` (B acting as A), `Service@bearer` (a claimed credential): what a request resolved to. */
const show = (resolved: Credentials.Resolved<Api.Principal>) => {
  const principal = resolved.principal;
  const acting =
    principal._tag === "User" && principal.actingAs !== undefined
      ? `~${who(principal.actingAs.id)}`
      : "";
  const subject = resolved._tag === "Claimed" ? principal._tag : who(principal.ref.id);
  return `${subject}${acting}@${resolved.carrier}`;
};

// ---- group T: the table ---------------------------------------------------------------------------------

interface Row {
  readonly id: string;
  /** `[cookie name, token name or literal]`; the name `impersonation`/`session` follows the configured mode. */
  readonly cookies?: ReadonlyArray<readonly [string, string]>;
  readonly apiKey?: string;
  readonly bearer?: string;
  readonly variant?: "secure" | "serviceResolver";
  readonly user: string;
  readonly machine: string;
  readonly optional: string;
}

const none = "unauthenticated";

const isAny = (_principal: Api.Principal): _principal is Api.Principal => true;

const rows: ReadonlyArray<Row> = [
  { id: "T1", user: none, machine: none, optional: none },
  {
    id: "T2",
    cookies: [["session", "own"]],
    user: "A@cookie",
    machine: "A@cookie",
    optional: "A@cookie",
  },
  {
    id: "T3",
    cookies: [["session", "own"]],
    bearer: "other",
    user: "A@cookie",
    machine: "A@cookie",
    optional: "A@cookie",
  },
  {
    id: "T4",
    cookies: [["session", "stale"]],
    bearer: "other",
    user: "B@bearer",
    machine: "B@bearer",
    optional: "B@bearer",
  },
  {
    id: "T5",
    cookies: [["session", "stale"]],
    bearer: "jwtu.ok",
    user: "User@bearer",
    machine: "User@bearer",
    optional: "User@bearer",
  },
  {
    id: "T6",
    cookies: [["session", "stale"]],
    bearer: "svc.x",
    user: none,
    machine: "Service@bearer",
    optional: none,
  },
  {
    id: "T7",
    cookies: [
      ["impersonation", "imp"],
      ["session", "own"],
    ],
    user: "B~A@impersonation",
    machine: "B~A@impersonation",
    optional: "B~A@impersonation",
  },
  {
    id: "T8",
    cookies: [
      ["impersonation", "planted"],
      ["session", "own"],
    ],
    user: "A@cookie",
    machine: "A@cookie",
    optional: "A@cookie",
  },
  { id: "T9", cookies: [["impersonation", "planted"]], user: none, machine: none, optional: none },
  {
    id: "T10",
    cookies: [
      ["impersonation", "stale"],
      ["session", "own"],
    ],
    user: "A@cookie",
    machine: "A@cookie",
    optional: "A@cookie",
  },
  { id: "T11", apiKey: "ak_1", user: none, machine: "ApiKey@apiKey", optional: none },
  {
    id: "T12",
    apiKey: "nope",
    bearer: "own",
    user: "A@bearer",
    machine: "A@bearer",
    optional: "A@bearer",
  },
  {
    id: "T13",
    apiKey: "ak_bad",
    bearer: "own",
    user: "A@bearer",
    machine: "A@bearer",
    optional: "A@bearer",
  },
  {
    id: "T14",
    cookies: [["session", "own"]],
    apiKey: "ak_1",
    user: "A@cookie",
    machine: "A@cookie",
    optional: "A@cookie",
  },
  { id: "T15", bearer: "ak_1", user: none, machine: none, optional: none },
  { id: "T16", bearer: "own", user: "A@bearer", machine: "A@bearer", optional: "A@bearer" },
  { id: "T17", bearer: "jwtu.bad", user: none, machine: none, optional: none },
  {
    id: "T18",
    cookies: [["impersonation", "imp"]],
    bearer: "own",
    user: "B~A@impersonation",
    machine: "B~A@impersonation",
    optional: "B~A@impersonation",
  },
  {
    id: "T19",
    apiKey: "ak_1",
    bearer: "svc.x",
    user: none,
    machine: "ApiKey@apiKey",
    optional: none,
  },
  {
    id: "T20",
    variant: "secure",
    cookies: [["__Host-session", "own"]],
    user: none,
    machine: none,
    optional: none,
  },
  {
    id: "T21",
    variant: "secure",
    cookies: [["__Secure-session", "own"]],
    user: "A@cookie",
    machine: "A@cookie",
    optional: "A@cookie",
  },
  {
    id: "T22",
    variant: "secure",
    cookies: [
      ["__Secure-impersonation", "imp"],
      ["__Secure-session", "own"],
    ],
    user: "B~A@impersonation",
    machine: "B~A@impersonation",
    optional: "B~A@impersonation",
  },
  {
    id: "T23",
    variant: "serviceResolver",
    cookies: [["session", "own"]],
    user: none,
    machine: "svc-session@cookie",
    optional: none,
  },
];

const tokenOf = (tokens: Tokens, name: string) =>
  name in tokens ? String(Reflect.get(tokens, name)) : name;

const headersFor = (row: Row, tokens: Tokens) => {
  const names: Record<string, string> =
    row.variant === "secure"
      ? { session: "__Secure-session", impersonation: "__Secure-impersonation" }
      : { session: "__Host-session", impersonation: "__Host-impersonation" };
  const cookie = (row.cookies ?? [])
    .map(([name, token]) => `${names[name] ?? name}=${tokenOf(tokens, token)}`)
    .join("; ");
  return {
    ...(cookie === "" ? {} : { cookie }),
    ...(row.apiKey === undefined ? {} : { "x-api-key": tokenOf(tokens, row.apiKey) }),
    ...(row.bearer === undefined ? {} : { authorization: `Bearer ${tokenOf(tokens, row.bearer)}` }),
  };
};

const variantOf = (row: Row): Variant =>
  row.variant === "secure"
    ? { cookie: secureDomain }
    : row.variant === "serviceResolver"
      ? {
          resolver: Layer.succeed(Credentials.PrincipalResolver, {
            resolve: () => Effect.succeed(service("svc-session")),
          }),
        }
      : {};

const tiers = [
  ["user", Credentials.userTier],
  ["machine", Credentials.machineTier],
  ["optional", Credentials.optionalTier],
] as const;

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
            .resolve(presented, tier, Credentials.httpScope(request))
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
        .resolve(presented, Credentials.userTier, Credentials.httpScope(request))
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
        const scope = Credentials.httpScope(request);
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
        .step("cookie", presented, Credentials.userTier, Credentials.httpScope(request))
        .pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.millis(20));
      yield* Fiber.join(first);
      yield* credentials.step(
        "cookie",
        presented,
        Credentials.userTier,
        Credentials.httpScope(prefixed),
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
      const scope = Credentials.httpScope(request);
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
      const scope = Credentials.httpScope(request);
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
          ...Credentials.httpScope(request),
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
        const scope = Credentials.httpScope(request);
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
          Credentials.httpScope(request),
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
          .resolve(presented, Credentials.optionalTier, Credentials.httpScope(request))
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
