// BEH-EA-308 (spec/behaviors/29-saml-sp.md, ADR-EA-023 Decision 4): the `Sso` dispatcher. An email domain (or an organization id) routes
// to an organization's OIDC connection or its SAML connection, and the answer is the URL of the owning protocol plugin's own login
// route; which protocol wins when both route the same hint is configured, and `discoverAll` shows the conflict instead of hiding it.
import { AuthHttp } from "@awthaq/server";
import { ConnectionRecords, Organization, OrganizationConnections } from "@awthaq/organization";
import { RateLimiter } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as Sso from "../src/Sso.ts";
import { atNow, BASE_URL, ownerPrincipal, SamlLive, seedConnection } from "./support.ts";

const OidcStoreLive = OrganizationConnections.layerStore.pipe(
  Layer.provideMerge(OrganizationConnections.OrganizationConnections.layer),
  Layer.provideMerge(ConnectionRecords.layerMemory),
);

const MemoryLimiter = RateLimiter.layer.pipe(
  Layer.provide(
    RateLimiter.layerStoreMemoryWith({ maxBuckets: 1000, sweepInterval: Duration.days(3650) }),
  ),
);

const SsoLive = (
  config: Parameters<typeof SamlLive>[0] = {},
  preferred?: Sso.SsoProtocol,
  limiter: Layer.Layer<RateLimiter.RateLimiter> = RateLimiter.layerPermissive,
) =>
  Sso.Sso.layer.pipe(
    Layer.provide(preferred === undefined ? Layer.empty : Sso.config({ preferred })),
    Layer.provideMerge(OidcStoreLive),
    Layer.provideMerge(SamlLive(config, limiter)),
  );

const oidcConnection = (organizationId: string, emailDomains: ReadonlyArray<string>) =>
  Effect.flatMap(OrganizationConnections.OrganizationConnectionStore, (store) =>
    store.create({
      organizationId,
      kind: "oidc",
      name: "Acme OIDC",
      issuer: "https://oidc.acme.example",
      discoveryUrl: "https://oidc.acme.example/.well-known/openid-configuration",
      clientId: "client-1",
      clientSecret: Redacted.make("secret"),
      emailDomains,
    }),
  );

const org = (slug: string) =>
  Effect.flatMap(Organization.Organization, (organization) =>
    organization.create({ caller: ownerPrincipal, name: slug, slug }),
  );

const sso = Effect.flatMap(Sso.Sso, Effect.succeed);

describe("routing an email domain", () => {
  it.effect("to the organization's SAML connection, with the SAML plugin's own login URL", () =>
    Effect.gen(function* () {
      yield* atNow;
      const dispatcher = yield* sso;
      const { connection, organizationId } = yield* seedConnection({
        emailDomains: ["acme.example"],
      });
      const route = Option.getOrThrow(
        yield* dispatcher.discover({ email: "Ada@Acme.Example", callbackURL: "/dash board" }),
      );
      assert.deepStrictEqual(route, {
        protocol: "saml",
        connectionId: connection.id,
        organizationId,
        loginUrl: `/auth/saml/login?connection=${connection.id}&callbackURL=%2Fdash%20board`,
      });
    }).pipe(Effect.provide(SsoLive())),
  );

  it.effect(
    "to the organization's OIDC connection, with the OAuth plugin's authorize URL for its provider id",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const dispatcher = yield* sso;
        const acme = yield* org("acme");
        const view = yield* oidcConnection(acme.id, ["acme.example"]);
        const route = Option.getOrThrow(yield* dispatcher.discover({ email: "ada@acme.example" }));
        assert.strictEqual(route.protocol, "oidc");
        assert.strictEqual(route.connectionId, view.id);
        assert.strictEqual(route.organizationId, acme.id);
        assert.strictEqual(
          route.loginUrl,
          `/oauth/${encodeURIComponent(view.providerId)}/authorize`,
        );
      }).pipe(Effect.provide(SsoLive())),
  );

  it.effect(
    "by organization id: each protocol's first-created connection of that organization",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const dispatcher = yield* sso;
        const { organizationId } = yield* seedConnection({ emailDomains: ["acme.example"] });
        const route = Option.getOrThrow(yield* dispatcher.discover({ organizationId }));
        assert.strictEqual(route.protocol, "saml");
        const other = yield* org("globex");
        yield* oidcConnection(other.id, ["globex.example"]);
        assert.strictEqual(
          Option.getOrThrow(yield* dispatcher.discover({ organizationId: other.id })).protocol,
          "oidc",
        );
      }).pipe(Effect.provide(SsoLive())),
  );

  it.effect(
    "nothing routing is None, whatever the reason: an unknown domain, an unknown organization, a malformed or empty hint",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const dispatcher = yield* sso;
        yield* seedConnection({ emailDomains: ["acme.example"] });
        for (const hint of [
          { email: "ada@other.example" },
          { organizationId: "no-such-org" },
          { email: "not-an-email" },
          { email: "ada@" },
          {},
        ]) {
          assert.isTrue(Option.isNone(yield* dispatcher.discover(hint)), JSON.stringify(hint));
        }
      }).pipe(Effect.provide(SsoLive())),
  );
});

describe("when both protocols route the same hint", () => {
  const bothOnAcme = Effect.gen(function* () {
    yield* atNow;
    const dispatcher = yield* sso;
    const { organizationId } = yield* seedConnection({ emailDomains: ["acme.example"] });
    yield* oidcConnection(organizationId, ["acme.example"]);
    return dispatcher;
  });

  it.effect("SAML wins by default, and discoverAll lists both so the conflict is visible", () =>
    Effect.gen(function* () {
      const dispatcher = yield* bothOnAcme;
      const all = yield* dispatcher.discoverAll({ email: "ada@acme.example" });
      assert.deepStrictEqual(
        all.map((route) => route.protocol),
        ["saml", "oidc"],
      );
      assert.strictEqual(
        Option.getOrThrow(yield* dispatcher.discover({ email: "ada@acme.example" })).protocol,
        "saml",
      );
    }).pipe(Effect.provide(SsoLive())),
  );

  it.effect("the configured preference decides, in discover and in the order of discoverAll", () =>
    Effect.gen(function* () {
      const dispatcher = yield* bothOnAcme;
      const all = yield* dispatcher.discoverAll({ email: "ada@acme.example" });
      assert.deepStrictEqual(
        all.map((route) => route.protocol),
        ["oidc", "saml"],
      );
      assert.strictEqual(
        Option.getOrThrow(yield* dispatcher.discover({ email: "ada@acme.example" })).protocol,
        "oidc",
      );
    }).pipe(Effect.provide(SsoLive({}, "oidc"))),
  );
});

describe("the start endpoint", () => {
  it.effect(
    "is one uniform SsoNotFound when nothing routes, and is limited per source address",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const dispatcher = yield* sso;
        yield* seedConnection({ emailDomains: ["acme.example"] });
        const found = yield* dispatcher.start({ email: "ada@acme.example" }, "203.0.113.9");
        assert.strictEqual(found.protocol, "saml");
        const missing = yield* dispatcher
          .start({ email: "ada@nowhere.example" }, "203.0.113.9")
          .pipe(Effect.flip);
        assert.deepStrictEqual(JSON.parse(JSON.stringify(missing)), { _tag: "SsoNotFound" });
        const empty = yield* dispatcher.start({}, "203.0.113.9").pipe(Effect.flip);
        assert.deepStrictEqual(JSON.parse(JSON.stringify(empty)), { _tag: "SsoNotFound" });
        // Two calls made, two more would be a third and a fourth: the budget is 3 per window for this address.
        const limited = yield* dispatcher
          .start({ email: "ada@acme.example" }, "203.0.113.9")
          .pipe(Effect.flip);
        assert.strictEqual(limited._tag, "RateLimited");
        yield* dispatcher.start({ email: "ada@acme.example" }, "203.0.113.10");
      }).pipe(
        Effect.provide(
          SsoLive(
            {
              rateLimits: {
                login: { limit: 30, window: Duration.minutes(1) },
                acs: { limit: 30, window: Duration.minutes(1) },
                slo: { limit: 30, window: Duration.minutes(1) },
                sso: { limit: 3, window: Duration.minutes(1) },
              },
            },
            undefined,
            MemoryLimiter,
          ),
        ),
      ),
  );

  const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
    Layer.provideMerge(FileSystem.layerNoop({})),
  );

  it.effect(
    "over HTTP: 200 with the route, 404 with the uniform body, and the composition puts `sso` on the public API",
    () =>
      Effect.gen(function* () {
        const Live = SsoLive();
        const AppLayer = AuthHttp.routes(Sso.SsoApi).pipe(
          Layer.provide(Live),
          Layer.provideMerge(TestServices),
          Layer.provideMerge(HttpRouter.layer),
        );
        const memoMap = Layer.makeMemoMapUnsafe();
        const { handler } = HttpRouter.toWebHandler(AppLayer, { memoMap });
        const seeded = yield* Effect.promise(() =>
          Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const scope = yield* Effect.scope;
                const context = yield* Layer.buildWithMemoMap(Live, memoMap, scope);
                return yield* seedConnection({ emailDomains: ["acme.example"] }).pipe(
                  Effect.provide(context),
                );
              }),
            ),
          ),
        );
        const post = (body: unknown) =>
          handler(
            new Request(`${BASE_URL}/auth/sso/start`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
          );
        const ok = yield* Effect.promise(() =>
          post({ email: "ada@acme.example", callbackURL: "/home" }),
        );
        assert.strictEqual(ok.status, 200);
        const body = JSON.parse(yield* Effect.promise(() => ok.text()));
        assert.strictEqual(body.protocol, "saml");
        assert.strictEqual(body.connectionId, seeded.connection.id);
        assert.strictEqual(
          body.loginUrl,
          `/auth/saml/login?connection=${seeded.connection.id}&callbackURL=%2Fhome`,
        );
        const none = yield* Effect.promise(() => post({ email: "ada@nowhere.example" }));
        assert.strictEqual(none.status, 404);
        assert.deepStrictEqual(JSON.parse(yield* Effect.promise(() => none.text())), {
          _tag: "SsoNotFound",
        });
        const invalid = yield* Effect.promise(() => post({ email: "" }));
        assert.strictEqual(invalid.status, 400);
      }),
  );
});
