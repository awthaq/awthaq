// Shared composition for the webhooks plugin's tests: the real in-memory core, a real `Encryption`
// over a fixed test key, and a programmable `HttpClient` that records every request it is asked to send.
import { Api } from "@awthaq/api";
import { AuthEvents, Sessions, Users } from "@awthaq/core";
import { Encryption, HostResolver, KeyProvider, RateLimiter } from "@awthaq/ports";
import { Authentication, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as WebhookDelivery from "../src/WebhookDelivery.ts";
import * as WebhookRecords from "../src/WebhookRecords.ts";
import * as WebhookSecrets from "../src/WebhookSecrets.ts";
import * as WebhookSignature from "../src/WebhookSignature.ts";
import * as WebhookTransport from "../src/WebhookTransport.ts";
import * as Webhooks from "../src/Webhooks.ts";
import { TestAuth } from "@awthaq/test";

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

export const CoreLive = Layer.mergeAll(Sessions.layerMemory, Users.layerMemory).pipe(
  Layer.provideMerge(TestAuth.memoryFoundation),
);

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
  | { readonly status: number }
  | { readonly transportError: true }
  | { readonly never: true };

/** A programmable receiver: `reply` decides the answer per request; every request is appended to `sent`. */
export const fakeReceiver = (reply: (request: SentRequest) => Reply = () => ({ status: 200 })) => {
  const sent: Array<SentRequest> = [];
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
        sent.push(seen);
        const answer = reply(seen);
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
          new Response(null, {
            status: answer.status,
            headers: { location: "http://169.254.169.254/" },
          }),
        );
      }),
    ),
  );
  return { sent, layer };
};

const PublicResolver = HostResolver.layerStatic({
  "hooks.example.com": ["93.184.216.34"],
  "other.example.com": ["93.184.216.35"],
  "rebind.example.com": ["10.0.0.5"],
});

export interface DeliveryOptions {
  readonly receiver?: Layer.Layer<HttpClient.HttpClient>;
  /** Replaces the transport built over `receiver` (the pinning tests capture what the transport is asked to do). */
  readonly transport?: Layer.Layer<WebhookTransport.WebhookTransport>;
  readonly config?: Partial<Webhooks.WebhooksConfigShape>;
  readonly limiter?: Layer.Layer<RateLimiter.RateLimiter>;
  readonly resolver?: Layer.Layer<HostResolver.HostResolver>;
}

/** Everything the delivery worker requires, over memory records. */
export const deliveryLayer = (options: DeliveryOptions = {}) => {
  const receiver = options.receiver ?? fakeReceiver().layer;
  return Layer.mergeAll(
    WebhookRecords.layerMemory,
    EncryptionLive,
    receiver,
    options.transport ?? WebhookTransport.layerHttpClient.pipe(Layer.provide(receiver)),
    options.limiter ?? RateLimiter.layerPermissive,
    options.resolver ?? PublicResolver,
    Webhooks.config(options.config ?? {}),
  ).pipe(Layer.provideMerge(CoreLive));
};

/** Registers an endpoint the way the service does (sealed secret) and returns it with its plaintext secret. */
export const seedEndpoint = (
  input: {
    readonly url?: string;
    readonly eventTags?: ReadonlyArray<string>;
    readonly id?: string;
    readonly tenantId?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const records = yield* WebhookRecords.WebhookRecords;
    const encryption = yield* Encryption.Encryption;
    const id = input.id ?? `ep-${Math.random().toString(16).slice(2)}`;
    const secret = yield* WebhookSignature.generateSecret;
    const endpoint = yield* records.createEndpoint({
      id,
      url: input.url ?? "https://hooks.example.com/awthaq",
      eventTags: input.eventTags ?? ["*"],
      secret: yield* WebhookSecrets.seal(encryption, id, "secret", secret),
      createdBy: "admin-1",
      tenantId: input.tenantId,
    });
    return { endpoint, secret };
  });

/** The API a real deployment mounts the admin group behind, for tests that call the service as an administrator. */
const AdminAuthenticationLive = Authentication.AdminAuthenticationLive.pipe(
  Layer.provide(
    Authentication.AuthenticationLive.pipe(Layer.provide(Authentication.PrincipalResolverLive)),
  ),
);
const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make("webhooks-admin-test-csrf-secret-padded-to-32-bytes"),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

/** The plugin (service and handlers) over `deliveryLayer`, with a gate that lets every call through unless `config` says otherwise. */
export const adminLayer = (options: DeliveryOptions = {}) =>
  Webhooks.Webhooks.layer.pipe(
    Layer.provide(AdminAuthenticationLive),
    Layer.provide(CsrfProtectionLive),
    Layer.provideMerge(
      deliveryLayer({
        ...options,
        config: { canManageWebhooks: () => Effect.succeed(true), ...options.config },
      }),
    ),
  );

export const adminPrincipal = (id = "admin-1") =>
  new Api.UserPrincipal({
    ref: new Api.PrincipalRef({ type: "user", id }),
    sessionId: `${id}-session`,
  });

/** A transport that records what it is asked to send and answers by `reply` (default 200): what the pinning tests inspect. */
export const fakeTransport = (
  reply: (
    request: WebhookTransport.TransportRequest,
  ) => Effect.Effect<{ readonly status: number }, WebhookTransport.WebhookTransportError> = () =>
    Effect.succeed({ status: 200 }),
) => {
  const sent: Array<WebhookTransport.TransportRequest> = [];
  const layer = Layer.succeed(
    WebhookTransport.WebhookTransport,
    WebhookTransport.WebhookTransport.of({
      send: (request) => {
        sent.push(request);
        return reply(request);
      },
    }),
  );
  return { sent, layer };
};

let counter = 0;

/** A published event with its envelope, `occurredAt` at the ambient clock (or `at`). */
export const published = <E extends AuthEvents.AuthEvent>(
  event: E,
  extra: Partial<AuthEvents.EventMetadata> = {},
) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    counter += 1;
    return {
      ...event,
      eventId: `018f0000-0000-7000-8000-${String(counter).padStart(12, "0")}`,
      occurredAt: now,
      correlationId: Option.none<string>(),
      traceId: Option.none<string>(),
      spanId: Option.none<string>(),
      ip: Option.none<string>(),
      userAgent: Option.none<string>(),
      tenantId: Option.none<string>(),
      ...extra,
    } satisfies AuthEvents.Published<E>;
  });

export const signedIn = (userId = "user-1") => ({
  _tag: "auth.user.signedIn" as const,
  userId: Users.UserId(userId),
  strategy: "password",
});

/** Enqueue one event for every matching endpoint, then run one worker tick. */
export const enqueueAndDrain = (event: AuthEvents.Published) =>
  Effect.gen(function* () {
    yield* WebhookDelivery.enqueue([event]);
    return yield* WebhookDelivery.drainDue;
  });
