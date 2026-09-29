// P20a/AH-003 (decision 36, tier 1): the World for 10-csrf.feature.
//
// Real `CsrfProtectionLive` (the shipped middleware, unmodified) in front of small plugins that
// each own one group carrying `Api.CsrfProtection` — composed through `Auth.make` and served by
// `@awthaq/test`'s `TestAuth.layer` (the bundle P10 shipped, ETVS-004) instead of a hand-rolled
// memory composition. Requests go through `HttpRouter.toWebHandler`, so what the scenarios
// observe is the wire: status, the typed `CsrfRejected` body, and the `__Host-csrf` cookie.
//
// `allowedOrigins` is a real list with one extra property: its `includes` — the only thing
// `CsrfProtection` calls on it — records every Origin the middleware compares. That is what
// makes "the Origin comparison is (not) evaluated" (REQ-EA-206/209) observable rather than
// inferred from the status.
import { Api } from "@awthaq/api";
import { Auth, AuthPlugin } from "@awthaq/core";
import { Authentication, Csrf } from "@awthaq/server";
import { TestAuth } from "@awthaq/test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { CsrfConfigForTests } from "./CsrfTestSupport.ts";

/** How many times an endpoint's own handler code ran — "not subject to rejection" means it ran. */
class Hits extends Context.Service<Hits, Ref.Ref<number>>()("features/CsrfHits") {}

const endpoints = <const P extends `/${string}`>(path: P) => ({
  get: HttpApiEndpoint.get("get", path, { success: Schema.String }),
  head: HttpApiEndpoint.head("head", path, { success: Schema.String }),
  post: HttpApiEndpoint.post("post", path, { success: Schema.String }),
  put: HttpApiEndpoint.put("put", path, { success: Schema.String }),
  patch: HttpApiEndpoint.patch("patch", path, { success: Schema.String }),
  delete: HttpApiEndpoint.delete("delete", path, { success: Schema.String }),
});

const appEndpoints = endpoints("/app/thing");
const billingEndpoints = endpoints("/billing/thing");

export const AppApi = HttpApi.make("auth").add(
  HttpApiGroup.make("app")
    .add(
      appEndpoints.get,
      appEndpoints.head,
      appEndpoints.post,
      appEndpoints.put,
      appEndpoints.patch,
      appEndpoints.delete,
    )
    .middleware(Api.CsrfProtection),
);

export const BillingApi = HttpApi.make("auth").add(
  HttpApiGroup.make("billing")
    .add(
      billingEndpoints.get,
      billingEndpoints.head,
      billingEndpoints.post,
      billingEndpoints.put,
      billingEndpoints.patch,
      billingEndpoints.delete,
    )
    .middleware(Api.CsrfProtection),
);

const hit = Effect.gen(function* () {
  yield* Ref.update(yield* Hits, (n) => n + 1);
  return "ok";
});

const AppHandlers = HttpApiBuilder.group(AppApi, "app", (handlers) =>
  handlers
    .handle("get", () => hit)
    .handle("head", () => hit)
    .handle("post", () => hit)
    .handle("put", () => hit)
    .handle("patch", () => hit)
    .handle("delete", () => hit),
);

const BillingHandlers = HttpApiBuilder.group(BillingApi, "billing", (handlers) =>
  handlers
    .handle("get", () => hit)
    .handle("head", () => hit)
    .handle("post", () => hit)
    .handle("put", () => hit)
    .handle("patch", () => hit)
    .handle("delete", () => hit),
);

class AppPlugin extends AuthPlugin.Service<AppPlugin, Record<string, never>>()("app", {
  apiVersion: 1,
  contract: AppApi,
  tables: [],
}) {
  static readonly layer = AuthPlugin.layer(AppPlugin, {
    make: Effect.succeed({}),
    handlers: AppHandlers,
  });
}

class BillingPlugin extends AuthPlugin.Service<BillingPlugin, Record<string, never>>()("billing", {
  apiVersion: 1,
  contract: BillingApi,
  tables: [],
}) {
  static readonly layer = AuthPlugin.layer(BillingPlugin, {
    make: Effect.succeed({}),
    handlers: BillingHandlers,
  });
}

/** BEH-EA-080: two applications, composed through `Auth.make`, with different plugins installed. */
const builtApp = Auth.make([AppPlugin]);
const builtBilling = Auth.make([BillingPlugin]);
const builtBoth = Auth.make([AppPlugin, BillingPlugin]);

export const ALLOWED_ORIGIN = "https://app.example.com";

// BEH-EA-080/REQ-EA-222: the cookie and header names are not configuration. `CsrfConfigShape` has
// no field for them, and a literal that tries to add one does not type-check — `tsc` fails this
// file the day such a field appears, so "no override is available" stays a checked fact.
export const overrideAttempt: Csrf.CsrfConfigShape = {
  secret: CsrfConfigForTests.secret,
  allowedOrigins: [],
  // @ts-expect-error `cookieName` does not exist on CsrfConfigShape
  cookieName: "renamed-csrf",
};

const makeServices = (
  hits: Ref.Ref<number>,
  originChecks: Array<string>,
  extraConfig: Readonly<Record<string, unknown>>,
) => {
  const allowedOrigins: ReadonlyArray<string> = Object.assign([ALLOWED_ORIGIN], {
    includes: (origin: string) => {
      originChecks.push(origin);
      return origin === ALLOWED_ORIGIN;
    },
  });
  return Layer.mergeAll(
    Authentication.AuthenticationLive.pipe(Layer.provide(Authentication.PrincipalResolverLive)),
    Csrf.CsrfProtectionLive.pipe(
      Layer.provide(
        Layer.succeed(Csrf.CsrfConfig, {
          secret: CsrfConfigForTests.secret,
          allowedOrigins,
          ...extraConfig,
        }),
      ),
    ),
    Layer.succeed(Hits, hits),
  );
};

export type Composition = "app" | "billing" | "both";

export const buildApp = (
  composition: Composition,
  extraConfig: Readonly<Record<string, unknown>> = {},
) => {
  const hits = Ref.makeUnsafe(0);
  const originChecks: Array<string> = [];
  const services = makeServices(hits, originChecks, extraConfig);
  const handler =
    composition === "app"
      ? HttpRouter.toWebHandler(TestAuth.layer(builtApp, services)).handler
      : composition === "billing"
        ? HttpRouter.toWebHandler(TestAuth.layer(builtBilling, services)).handler
        : HttpRouter.toWebHandler(TestAuth.layer(builtBoth, services)).handler;
  return { handler, hits, originChecks };
};

export type AppHandle = ReturnType<typeof buildApp>;

/** What one request left behind. */
export interface Observation {
  readonly status: number;
  /** The typed error's `_tag`, when the body carries one. */
  readonly tag: string | undefined;
  readonly body: string;
  readonly hits: number;
  /** Origins the middleware compared against its allow-list while deciding. */
  readonly originChecks: ReadonlyArray<string>;
  /** The `__Host-csrf` value the response set, when it set one. */
  readonly issuedToken: string | undefined;
  readonly setCookie: string | null;
}

export interface RequestSpec {
  readonly method: string;
  readonly group: "app" | "billing";
  readonly headers: Readonly<Record<string, string>>;
}

export interface WorldShape {
  readonly app: Ref.Ref<AppHandle | undefined>;
  readonly composition: Ref.Ref<Composition>;
  /** The request the Givens are arranging. */
  readonly pending: Ref.Ref<RequestSpec>;
  readonly observations: Ref.Ref<ReadonlyArray<Observation>>;
  readonly outcomes: Ref.Ref<Readonly<Record<string, unknown>>>;
  /** Further apps a scenario composes beside the default one (REQ-EA-221). */
  readonly apps: Ref.Ref<Readonly<Record<string, AppHandle>>>;
}

export class World extends Context.Service<World, WorldShape>()("features/CsrfWorld") {}

export const WorldLive = Layer.effect(
  World,
  Effect.gen(function* () {
    return World.of({
      app: yield* Ref.make<AppHandle | undefined>(undefined),
      composition: yield* Ref.make<Composition>("both"),
      pending: yield* Ref.make<RequestSpec>({ method: "POST", group: "app", headers: {} }),
      observations: yield* Ref.make<ReadonlyArray<Observation>>([]),
      outcomes: yield* Ref.make<Readonly<Record<string, unknown>>>({}),
      apps: yield* Ref.make<Readonly<Record<string, AppHandle>>>({}),
    });
  }),
);

/** Builds this Scenario's app once, on first use, for the composition the scenario chose (default: both plugins). */
export const appHandle = Effect.fn("features.csrf.appHandle")(function* () {
  const world = yield* World;
  const existing = yield* Ref.get(world.app);
  if (existing !== undefined) return existing;
  const fresh = buildApp(yield* Ref.get(world.composition));
  yield* Ref.set(world.app, fresh);
  return fresh;
});

export const useComposition = Effect.fn("features.csrf.useComposition")(function* (
  composition: Composition,
) {
  const world = yield* World;
  yield* Ref.set(world.composition, composition);
  yield* Ref.set(world.app, undefined);
});

const ErrorBody = Schema.Struct({ _tag: Schema.optional(Schema.String) });

const tokenFrom = (setCookie: string | null) => {
  if (setCookie === null) return undefined;
  const match = new RegExp(`${Api.CSRF_COOKIE_NAME}=([^;]+)`).exec(setCookie);
  return match?.[1];
};

/** Sends `spec` to the scenario's app and records what came back. */
export const send = Effect.fn("features.csrf.send")(function* (spec: RequestSpec) {
  return yield* sendTo(yield* appHandle(), spec);
});

/** The same, against a specific app — for scenarios that compose more than one. */
export const sendTo = Effect.fn("features.csrf.sendTo")(function* (
  app: AppHandle,
  spec: RequestSpec,
) {
  const world = yield* World;
  yield* Ref.set(app.hits, 0);
  app.originChecks.length = 0;
  const response = yield* Effect.promise(() =>
    app.handler(
      new Request(`http://localhost/${spec.group}/thing`, {
        method: spec.method,
        headers: spec.headers,
      }),
    ),
  );
  const body = yield* Effect.promise(() => response.text());
  const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody))(body);
  const setCookie = response.headers.get("set-cookie");
  const observation: Observation = {
    status: response.status,
    tag: parsed._tag === "Some" ? parsed.value._tag : undefined,
    body,
    hits: yield* Ref.get(app.hits),
    originChecks: [...app.originChecks],
    issuedToken: tokenFrom(setCookie),
    setCookie,
  };
  yield* Ref.update(world.observations, (all) => [...all, observation]);
  return observation;
});

export const pendingRequest = Effect.fn("features.csrf.pendingRequest")(function* () {
  const world = yield* World;
  return yield* Ref.get(world.pending);
});

export const arrange = Effect.fn("features.csrf.arrange")(function* (
  change: Partial<RequestSpec> & { readonly header?: readonly [string, string] },
) {
  const world = yield* World;
  yield* Ref.update(world.pending, (existing) => ({
    method: change.method ?? existing.method,
    group: change.group ?? existing.group,
    headers:
      change.header === undefined
        ? (change.headers ?? existing.headers)
        : { ...existing.headers, [change.header[0]]: change.header[1] },
  }));
});

export const lastObservation = Effect.fn("features.csrf.lastObservation")(function* () {
  const world = yield* World;
  const all = yield* Ref.get(world.observations);
  const last = all[all.length - 1];
  if (last === undefined) return yield* Effect.die(new Error("no request has been sent yet"));
  return last;
});

export const setOutcome = Effect.fn("features.csrf.setOutcome")(function* (
  key: string,
  value: unknown,
) {
  const world = yield* World;
  yield* Ref.update(world.outcomes, (existing) => ({ ...existing, [key]: value }));
});

export const getOutcome = Effect.fn("features.csrf.getOutcome")(function* (key: string) {
  const world = yield* World;
  const found = (yield* Ref.get(world.outcomes))[key];
  if (found === undefined) return yield* Effect.die(new Error(`no outcome recorded for "${key}"`));
  return found;
});

/**
 * "A signed `__Host-csrf` cookie was issued to the client": the real thing — a safe request to
 * the app, whose response sets the cookie (BEH-EA-075), the way a browser's first page load does.
 */
export const issueCookie = Effect.fn("features.csrf.issueCookie")(function* () {
  const observed = yield* send({ method: "GET", group: "app", headers: {} });
  if (observed.issuedToken === undefined) {
    return yield* Effect.die(new Error("the first safe request did not issue a __Host-csrf cookie"));
  }
  return observed.issuedToken;
});

export const setApp = Effect.fn("features.csrf.setApp")(function* (key: string, app: AppHandle) {
  const world = yield* World;
  yield* Ref.update(world.apps, (existing) => ({ ...existing, [key]: app }));
});

export const getApp = Effect.fn("features.csrf.getApp")(function* (key: string) {
  const world = yield* World;
  const found = (yield* Ref.get(world.apps))[key];
  if (found === undefined) return yield* Effect.die(new Error(`no app named "${key}"`));
  return found;
});
