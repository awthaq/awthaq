// Shared composition for the webhooks plugin's tests: the real in-memory core, a real `Encryption`
// over a fixed test key, and a programmable `HttpClient` that records every request it is asked to send.
import { AuditLog, AuthEvents, Hooks, Sessions, Users } from "@awthaq/core";
import { Encryption, HostResolver, KeyProvider, RateLimiter } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as WebhookDelivery from "../src/WebhookDelivery.ts";
import * as WebhookRecords from "../src/WebhookRecords.ts";
import * as WebhookSecrets from "../src/WebhookSecrets.ts";
import * as WebhookSignature from "../src/WebhookSignature.ts";
import * as Webhooks from "../src/Webhooks.ts";

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
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(NodeCrypto.layer),
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
  readonly config?: Partial<Webhooks.WebhooksConfigShape>;
  readonly limiter?: Layer.Layer<RateLimiter.RateLimiter>;
  readonly resolver?: Layer.Layer<HostResolver.HostResolver>;
}

/** Everything the delivery worker requires, over memory records. */
export const deliveryLayer = (options: DeliveryOptions = {}) =>
  Layer.mergeAll(
    WebhookRecords.layerMemory,
    EncryptionLive,
    options.receiver ?? fakeReceiver().layer,
    options.limiter ?? RateLimiter.layerPermissive,
    options.resolver ?? PublicResolver,
    Webhooks.config(options.config ?? {}),
  ).pipe(Layer.provideMerge(CoreLive));

/** Registers an endpoint the way the service does (sealed secret) and returns it with its plaintext secret. */
export const seedEndpoint = (
  input: {
    readonly url?: string;
    readonly eventTags?: ReadonlyArray<string>;
    readonly id?: string;
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
    });
    return { endpoint, secret };
  });

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
