// A fake provider transport shared by the oauth test files: routes by URL
// fragment, and a route value can be
//   - plain JSON            -> 200 with that body,
//   - `FakeReply`           -> that status and body (503s, 400 invalid_grant, ...),
//   - `HANG`                -> a request that never answers (deadline tests),
//   - a function of the request returning any of the above (call counting,
//     inspecting headers/body, answering differently on the Nth call).
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

export class FakeReply {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown = {}) {
    this.status = status;
    this.body = body;
  }
}

const HANG = Symbol("hang");

/**
 * A route that never answers, plus `reached` — resolves once a request has
 * actually arrived at it. A forked callback does real (async) crypto before
 * its first outbound call, so a deadline test must wait for the call to be
 * pending before advancing the TestClock, or the clock moves before the
 * timeout is even armed.
 */
export const hangingRoute = () => {
  let hits = 0;
  return {
    route: () => {
      hits += 1;
      return HANG;
    },
    reached: Effect.promise(async () => {
      for (let turn = 0; hits === 0 && turn < 1000; turn++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }),
  };
};

export interface FakeRoutes {
  readonly [urlFragment: string]: unknown;
}

export const fakeHttpClient = (routes: FakeRoutes): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
      const match = Object.entries(routes).find(([fragment]) => request.url.includes(fragment));
      if (match === undefined) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("not found", { status: 404 })),
        );
      }
      const route = match[1];
      const value: unknown = typeof route === "function" ? route(request) : route;
      if (value === HANG) return Effect.never;
      const reply = value instanceof FakeReply ? value : new FakeReply(200, value);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(reply.body), { status: reply.status }),
        ),
      );
    }),
  );
