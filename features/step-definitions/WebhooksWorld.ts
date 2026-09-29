// P20a: 34-webhooks.feature's World over the shipped `@awthaq/webhooks` plugin. The real in-memory
// core, the in-memory delivery records, a real `Encryption` over a fixed test key and the plugin's own
// service. Two things are programmable: the receiver (a fake `HttpClient` that records every request
// it is asked to send, including the fetch `redirect` mode in force, and answers as a step told it to)
// and the plugin configuration (a Given sets it before the app is first used).
//
// The app is built lazily on first use, inside the scenario's own fiber, so every clock read (the
// backoff schedule, the rotation grace window, leases, retention) goes through the scenario's
// `TestClock`. A second, HTTP-served composition is built only by the scenarios about the admin tier.
import { Api } from "@awthaq/api";
import {
  AuditLog,
  AuthEvents,
  DataExport,
  Erasure,
  EventRelay,
  Hooks,
  Sessions,
  Users,
} from "@awthaq/core";
import { Encryption, HostResolver, KeyProvider, RateLimiter } from "@awthaq/ports";
import { Authentication, AuthHttp, Csrf } from "@awthaq/server";
import { WebhookDelivery, WebhookRecords, Webhooks, WebhooksApi } from "@awthaq/webhooks";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { createHmac, randomBytes } from "node:crypto";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { makeNamedRegistry, TestServices } from "./shared/Harness.ts";
import { makeOutcomes } from "./shared/Outcomes.ts";

// ---- the receiver ---------------------------------------------------------------------------

/** What the fake receiver saw. */
export interface SentRequest {
  /** The fetch `redirect` mode in force for the call (`manual`: a redirect is never followed). */
  readonly redirect: string | undefined;
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type Reply =
  | { readonly status: number; readonly body?: string }
  | { readonly transportError: true }
  | { readonly never: true };

export type ReplyFn = (request: SentRequest) => Reply;

/** A programmable receiver: the current `reply` decides every answer; every request is appended to `sent`. */
const makeReceiver = () => {
  const sent = Effect.runSync(Ref.make<ReadonlyArray<SentRequest>>([]));
  const reply = Effect.runSync(Ref.make<ReplyFn>(() => ({ status: 200 })));
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, _url, _signal, fiber) =>
      Effect.gen(function* () {
        const init = Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit);
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        const seen: SentRequest = {
          redirect: init?.redirect,
          url: request.url,
          method: request.method,
          headers: Object.fromEntries(Object.entries(request.headers)),
          body,
        };
        yield* Ref.update(sent, (all) => [...all, seen]);
        const answer = (yield* Ref.get(reply))(seen);
        if ("transportError" in answer) {
          return yield* Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request }),
            }),
          );
        }
        if ("never" in answer) return yield* Effect.never;
        return HttpClientResponse.fromWeb(
          request,
          new Response(answer.body ?? null, {
            status: answer.status,
            // A redirect target the client must never chase (the cloud metadata address).
            headers: { location: "http://169.254.169.254/" },
          }),
        );
      }),
    ),
  );
  return { layer, sent: Ref.get(sent), setReply: (next: ReplyFn) => Ref.set(reply, next) };
};

// ---- the composition ---------------------------------------------------------------------

const EncryptionLive = Encryption.layer.pipe(
  Layer.provide(
    KeyProvider.layerEnv.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { AWTHAQ_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") },
          }),
        ),
      ),
    ),
  ),
  Layer.provide(NodeCrypto.layer),
);

const CoreLive = Layer.mergeAll(Sessions.layerMemory, Users.layerMemory).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(NodeCrypto.layer),
);

/** Names the fake resolver knows; "rebind" answers with a private address (DNS rebinding), anything else does not resolve. */
const PublicResolver = HostResolver.layerStatic({
  "hooks.example.com": ["93.184.216.34"],
  "other.example.com": ["93.184.216.35"],
  "rebind.example.com": ["10.0.0.5"],
});

const CSRF_SECRET = "webhooks-bdd-csrf-secret-padded-to-thirty-two-bytes";

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make(CSRF_SECRET),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

const AdminAuthenticationLive = Authentication.AdminAuthenticationLive.pipe(
  Layer.provide(
    Authentication.AuthenticationLive.pipe(Layer.provide(Authentication.PrincipalResolverLive)),
  ),
);

export type Gate = "allow" | "deny" | "readOnly";

export interface Options {
  readonly config: Partial<Webhooks.WebhooksConfigShape>;
  readonly limiter: "permissive" | "memory";
  readonly gate: Gate;
}

const gateFor = (gate: Gate): Webhooks.WebhooksConfigShape["canManageWebhooks"] => {
  switch (gate) {
    case "allow":
      return () => Effect.succeed(true);
    case "readOnly":
      return ({ action }) => Effect.succeed(action.startsWith("list"));
    case "deny":
      return () => Effect.succeed(false);
  }
};

const baseLayer = (options: Options, receiver: ReturnType<typeof makeReceiver>) =>
  Layer.mergeAll(
    WebhookRecords.layerMemory,
    EncryptionLive,
    receiver.layer,
    options.limiter === "memory" ? RateLimiter.layerMemory : RateLimiter.layerPermissive,
    PublicResolver,
    Webhooks.config({ canManageWebhooks: gateFor(options.gate), ...options.config }),
    EventRelay.layerCursorMemory,
  ).pipe(Layer.provideMerge(CoreLive));

/** What the steps may ask of the built app. */
export type AppServices =
  | Webhooks.Webhooks
  | WebhookRecords.WebhookRecords
  | Encryption.Encryption
  | AuthEvents.AuthEvents
  | AuditLog.AuditLog
  | EventRelay.RelayCursorStore
  | Crypto.Crypto
  | Erasure.ErasureRegistry
  | DataExport.DataExportRegistry
  | RateLimiter.RateLimiter
  | HttpClient.HttpClient
  | HostResolver.HostResolver;

export interface App {
  readonly run: <A, E>(effect: Effect.Effect<A, E, AppServices>) => Effect.Effect<A, E>;
  readonly receiver: ReturnType<typeof makeReceiver>;
}

const buildApp = (options: Options, scope: Scope.Scope) =>
  Effect.gen(function* () {
    const receiver = makeReceiver();
    const layer = Webhooks.Webhooks.layer.pipe(
      Layer.provide(AdminAuthenticationLive),
      Layer.provide(CsrfProtectionLive),
      Layer.provideMerge(baseLayer(options, receiver)),
    );
    const context = yield* Layer.buildWithScope(layer, scope);
    const app: App = { run: (effect) => Effect.provide(effect, context), receiver };
    return app;
  });

// ---- the HTTP-served composition (the admin-tier scenarios) --------------------------------

const ORIGIN = "http://localhost:3000";

/** `<iat>.<random>.<hmac(iat.random)>`, computed with `node:crypto`, independent of `Csrf.ts`. */
const CSRF_VALUE: string = (() => {
  const signed = `${Math.floor(Date.now() / 1000)}.${randomBytes(32).toString("hex")}`;
  return `${signed}.${createHmac("sha256", CSRF_SECRET).update(signed).digest("hex")}`;
})();

export interface HttpApp {
  readonly sessionCookie: () => Promise<string>;
  readonly call: (
    method: string,
    path: string,
    options?: {
      readonly cookie?: string;
      readonly body?: unknown;
      readonly csrf?: boolean;
    },
  ) => Promise<{ readonly status: number; readonly tag: string | undefined }>;
}

const buildHttpApp = (options: Options): HttpApp => {
  const receiver = makeReceiver();
  const AppLayer = AuthHttp.routes(WebhooksApi.WebhooksApi).pipe(
    Layer.provide(Webhooks.Webhooks.layer),
    Layer.provide(AdminAuthenticationLive),
    Layer.provide(CsrfProtectionLive),
    Layer.provideMerge(baseLayer(options, receiver)),
    Layer.provideMerge(TestServices),
    Layer.provideMerge(HttpRouter.layer),
  );
  const memoMap = Layer.makeMemoMapUnsafe();
  const { handler } = HttpRouter.toWebHandler(AppLayer, { memoMap });
  // The web handler runs on the real clock, so the session it authenticates is issued on the real
  // clock too, against the very services the handler runs on (one shared memo map).
  const sessionCookie = () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.scope;
          const context = yield* Layer.buildWithMemoMap(AppLayer, memoMap, scope);
          return yield* Effect.gen(function* () {
            const sessions = yield* Sessions.Sessions;
            const issued = yield* sessions.issue({ userId: Users.UserId("admin-1") });
            return `__Host-session=${encodeURIComponent(Redacted.value(issued.token))}`;
          }).pipe(Effect.provide(context));
        }),
      ),
    );
  const call: HttpApp["call"] = async (method, path, callOptions = {}) => {
    const withCsrf = callOptions.csrf !== false;
    const response = await handler(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: {
          ...(callOptions.body === undefined ? {} : { "content-type": "application/json" }),
          cookie: [
            callOptions.cookie,
            withCsrf ? `${Api.CSRF_COOKIE_NAME}=${CSRF_VALUE}` : undefined,
          ]
            .filter((part) => part !== undefined && part !== "")
            .join("; "),
          ...(withCsrf ? { "x-csrf-token": CSRF_VALUE } : {}),
        },
        ...(callOptions.body === undefined ? {} : { body: JSON.stringify(callOptions.body) }),
      }),
    );
    const parsed: unknown = await response.json().catch(() => undefined);
    const tag =
      typeof parsed === "object" &&
      parsed !== null &&
      "_tag" in parsed &&
      typeof parsed._tag === "string"
        ? parsed._tag
        : undefined;
    return { status: response.status, tag };
  };
  return { sessionCookie, call };
};

// ---- the World ---------------------------------------------------------------------------

export interface NamedEndpoint {
  readonly id: string;
  readonly url: string;
  /** The plaintext secret shown at creation (or the latest rotation). */
  readonly secret: string;
}

export interface WorldShape {
  readonly scope: Scope.Scope;
  readonly options: Ref.Ref<Options>;
  readonly app: Ref.Ref<App | undefined>;
  readonly httpApp: Ref.Ref<HttpApp | undefined>;
  readonly endpoints: ReturnType<typeof makeNamedRegistry<NamedEndpoint>>;
  readonly secrets: ReturnType<typeof makeNamedRegistry<string>>;
  readonly events: ReturnType<typeof makeNamedRegistry<AuthEvents.Published>>;
  readonly out: Effect.Success<typeof makeOutcomes>;
  readonly replies: Ref.Ref<Replies>;
  /** The delivery counter per outcome when the scenario began (the counter is process-wide). */
  readonly metricBase: Readonly<Record<string, number>>;
}

/** How the receiver answers: the default, and per-URL overrides (an endpoint that is down while another is healthy). */
export interface Replies {
  readonly base: ReplyFn;
  readonly byUrl: Readonly<Record<string, ReplyFn>>;
}

const OUTCOMES: ReadonlyArray<string> = ["succeeded", "retry", "dead", "deferred"];

export const metricCount = (outcome: string) =>
  Effect.map(
    Metric.value(Metric.withAttributes(WebhookDelivery.deliveries, { outcome })),
    (state) => Number(state.count),
  );

export class World extends Context.Service<World, WorldShape>()("features/WebhooksWorld") {}

export const WorldLive = Layer.effect(
  World,
  Effect.gen(function* () {
    return World.of({
      scope: yield* Effect.scope,
      options: yield* Ref.make<Options>({ config: {}, limiter: "permissive", gate: "allow" }),
      app: yield* Ref.make<App | undefined>(undefined),
      httpApp: yield* Ref.make<HttpApp | undefined>(undefined),
      endpoints: makeNamedRegistry<NamedEndpoint>("endpoint"),
      secrets: makeNamedRegistry<string>("secret"),
      events: makeNamedRegistry<AuthEvents.Published>("event"),
      out: yield* makeOutcomes,
      replies: yield* Ref.make<Replies>({ base: () => ({ status: 200 }), byUrl: {} }),
      metricBase: yield* Effect.map(Effect.forEach(OUTCOMES, metricCount), (counts) =>
        Object.fromEntries(OUTCOMES.map((outcome, index) => [outcome, counts[index] ?? 0])),
      ),
    });
  }),
);

/** A Given that configures the plugin before the app is first built. */
export const configure = (
  patch:
    | Partial<Options["config"]>
    | { readonly gate: Gate }
    | { readonly limiter: Options["limiter"] },
) =>
  Effect.gen(function* () {
    const world = yield* World;
    if (yield* Ref.get(world.app)) {
      return yield* Effect.die(new Error("the plugin is configured before its first use"));
    }
    yield* Ref.update(world.options, (options) => {
      if ("gate" in patch) return { ...options, gate: patch.gate };
      if ("limiter" in patch) return { ...options, limiter: patch.limiter };
      return { ...options, config: { ...options.config, ...patch } };
    });
  });

export const app = Effect.gen(function* () {
  const world = yield* World;
  const existing = yield* Ref.get(world.app);
  if (existing !== undefined) return existing;
  const built = yield* buildApp(yield* Ref.get(world.options), world.scope);
  yield* Ref.set(world.app, built);
  return built;
});

export const httpApp = Effect.gen(function* () {
  const world = yield* World;
  const existing = yield* Ref.get(world.httpApp);
  if (existing !== undefined) return existing;
  const built = buildHttpApp(yield* Ref.get(world.options));
  yield* Ref.set(world.httpApp, built);
  return built;
});

/** Changes how the receiver answers, from now on. */
export const updateReplies = (change: (current: Replies) => Replies) =>
  Effect.gen(function* () {
    const world = yield* World;
    const built = yield* app;
    const next = change(yield* Ref.get(world.replies));
    yield* Ref.set(world.replies, next);
    yield* built.receiver.setReply((request) => (next.byUrl[request.url] ?? next.base)(request));
  });

export const run = <A, E>(effect: Effect.Effect<A, E, AppServices>) =>
  Effect.flatMap(app, (built) => built.run(effect));

// ---- events ------------------------------------------------------------------------------------

export const ADMIN = new Api.UserPrincipal({
  ref: new Api.PrincipalRef({ type: "user", id: "admin-1" }),
  sessionId: "admin-session",
});

export const otherAdmin = new Api.UserPrincipal({
  ref: new Api.PrincipalRef({ type: "user", id: "admin-2" }),
  sessionId: "admin-session-2",
});

let counter = 0;

/** A published event with its envelope, `occurredAt` at the scenario's clock. */
export const publishedEvent = (
  event: AuthEvents.AuthEvent,
  extra: Partial<AuthEvents.EventMetadata> = {},
) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    counter += 1;
    const published: AuthEvents.Published = {
      ...event,
      eventId: `018f0000-0000-7000-8000-${String(counter).padStart(12, "0")}`,
      occurredAt: now,
      correlationId: Option.none<string>(),
      traceId: Option.none<string>(),
      spanId: Option.none<string>(),
      ip: Option.none<string>(),
      userAgent: Option.none<string>(),
      ...extra,
    };
    return published;
  });

/** The event a scenario names by tag: only the shapes the scenarios use. */
export const eventOfTag = (tag: string, userId: string): Effect.Effect<AuthEvents.AuthEvent> => {
  switch (tag) {
    case "auth.user.signedIn":
      return Effect.succeed({
        _tag: "auth.user.signedIn",
        userId: Users.UserId(userId),
        strategy: "password",
      });
    case "auth.user.created":
      return Effect.succeed({ _tag: "auth.user.created", userId: Users.UserId(userId) });
    case "auth.organization.created":
      return Effect.succeed({
        _tag: "auth.organization.created",
        organizationId: "org-1",
        creatorUserId: Users.UserId(userId),
      });
    case "auth.organization.updated":
      return Effect.succeed({ _tag: "auth.organization.updated", organizationId: "org-1" });
    default:
      return Effect.die(new Error(`the World has no sample event for "${tag}"`));
  }
};

// ---- delivery ------------------------------------------------------------------------------------

export const enqueue = (events: ReadonlyArray<AuthEvents.Published>) =>
  run(WebhookDelivery.enqueue(events));

export const drain = run(WebhookDelivery.drainDue);

export const deliver = (events: ReadonlyArray<AuthEvents.Published>) =>
  Effect.gen(function* () {
    const queued = yield* enqueue(events);
    const attempted = yield* drain;
    return { queued, attempted };
  });

export const deliveriesOf = (endpointId: string) =>
  run(
    Effect.flatMap(WebhookRecords.WebhookRecords, (records) =>
      records.listDeliveries({ endpointId, limit: 100 }),
    ),
  );

export const requestsTo = (endpoint: NamedEndpoint) =>
  Effect.gen(function* () {
    const built = yield* app;
    return (yield* built.receiver.sent).filter((request) => request.url === endpoint.url);
  });

export const allRequests = Effect.gen(function* () {
  const built = yield* app;
  return yield* built.receiver.sent;
});

export const advance = (by: Duration.Input) => TestClock.adjust(by);
