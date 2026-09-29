// BEH-EA-169..176 (22-client-effect.feature): the Effect client derived from the merged contract.
// Every scenario builds the client from a real `Auth.make(...)`'s api and observes what it puts on
// the wire through a stub `HttpClient` that records requests — no server is started (the point of
// the behavior: the client is a function of the contract).
import { AuthClient } from "@awthaq/client";
import { Auth } from "@awthaq/core";
import { OAuth } from "@awthaq/oauth";
import { Password } from "@awthaq/password";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { makeOutcomes, type Outcomes } from "./shared/Outcomes.ts";

/** The merged `AuthApi` the scenarios name: core's session/account groups plus the "Password" and "OAuth" plugins' own. */
export const mergedTuple = Auth.make([Password.Password, OAuth.OAuth]);
export const mergedApi = mergedTuple.api;

export const BASE_URL = "http://auth.test";

export interface StubHttp {
  /** Every request the client issued, in order. */
  readonly requests: Effect.Effect<ReadonlyArray<HttpClientRequest.HttpClientRequest>>;
  readonly layer: Layer.Layer<HttpClient.HttpClient>;
}

/** An `HttpClient` that answers `204` (or whatever `respond` says) and remembers what it was asked. */
export const makeStubHttp = (
  respond: (request: HttpClientRequest.HttpClientRequest) => Response = () =>
    new Response(null, { status: 204 }),
): StubHttp => {
  const seen = Effect.runSync(Ref.make<ReadonlyArray<HttpClientRequest.HttpClientRequest>>([]));
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Ref.update(seen, (existing) => [...existing, request]).pipe(
        Effect.as(HttpClientResponse.fromWeb(request, respond(request))),
      ),
    ),
  );
  return { requests: Ref.get(seen), layer };
};

export interface WorldShape {
  readonly outcomes: Outcomes;
  /** BEH-EA-174: the session store the scenario's "authClient.session" reads and hydrates. */
  readonly sessionStore: AuthClient.SessionStoreShape;
  /** Requests the scenario's default client issued — a store read must not add to it. */
  readonly stub: StubHttp;
}

export class World extends Context.Service<World, WorldShape>()("features/ClientEffectWorld") {}

export const WorldLive = Layer.effect(
  World,
  Effect.gen(function* () {
    return World.of({
      outcomes: yield* makeOutcomes,
      // A `Ref` over plain state: nothing here needs the layer's scope to stay open.
      sessionStore: yield* Effect.gen(function* () {
        return yield* AuthClient.SessionStore;
      }).pipe(Effect.provide(AuthClient.SessionStoreLive)),
      stub: makeStubHttp(),
    });
  }),
);

/** One endpoint of a contract, addressed the way a generated client addresses it. */
export interface DeclaredEndpoint {
  readonly group: string;
  readonly endpoint: string;
  readonly topLevel: boolean;
}

/** Every `(group, endpoint)` a contract declares — the source of truth a client's methods are compared against. */
export const declaredEndpoints = (api: {
  readonly groups: Readonly<Record<string, { readonly topLevel: boolean; readonly endpoints: Readonly<Record<string, unknown>> }>>;
}): ReadonlyArray<DeclaredEndpoint> =>
  Object.entries(api.groups).flatMap(([group, definition]) =>
    Object.keys(definition.endpoints).map((endpoint) => ({
      group,
      endpoint,
      topLevel: definition.topLevel,
    })),
  );

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

/** The methods a built client actually exposes, addressed like `declaredEndpoints`. */
export const exposedMethods = (
  client: unknown,
  declared: ReadonlyArray<DeclaredEndpoint>,
): ReadonlyArray<DeclaredEndpoint> => {
  if (!isRecord(client)) return [];
  const topLevelGroups = new Set(declared.filter((entry) => entry.topLevel).map((entry) => entry.group));
  const found: Array<DeclaredEndpoint> = [];
  for (const [key, value] of Object.entries(client)) {
    if (typeof value === "function") {
      // A method directly on the client belongs to a top-level group (its group id is not a namespace).
      found.push({ group: "", endpoint: key, topLevel: true });
    } else if (isRecord(value)) {
      for (const [method, fn] of Object.entries(value)) {
        if (typeof fn === "function") {
          found.push({ group: key, endpoint: method, topLevel: topLevelGroups.has(key) });
        }
      }
    }
  }
  return found;
};
