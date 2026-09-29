// @awthaq/webhooks — WebhookTransport
//
// BEH-EA-303 (closes the DNS-rebinding gap the SSRF checks alone leave open): the one place a delivery leaves the
// process. `WebhookDelivery.attempt` resolves the endpoint's host ONCE (`HostResolver.pin`), judges every address it got,
// and hands this transport the pinned address; the transport connects to THAT address and never asks DNS again, while the
// request still says the original host name in `Host` and as the TLS server name (SNI), so virtual hosting works and the
// certificate is verified against the name the administrator registered.
//
//   - `layerNodePinned`: `PinnedHttp` (`@awthaq/ports`): `node:http`/`node:https` connecting to the pinned IP literal. No
//     lookup happens at all, so there is nothing to rebind. The address is judged again there so a caller that skips the
//     check still cannot make this transport reach a private address. Redirects are never followed and the response body is
//     never read: the socket is destroyed as soon as the status line is in.
//   - `layerHttpClient`: any `HttpClient` (`fetch`). It cannot pin: the client resolves the name itself, so this narrows
//     rebinding (the pre-connect check) but does not close it. For runtimes without `node:https`, and for tests.
//
// The transport reports only a failure CLASS (`timeout`, `connect`, `blocked`), never a message: what a hostile receiver or
// resolver says is untrusted text that must not reach a log or the delivery table.

import type { HostResolver } from "@awthaq/ports";
import { PinnedHttp } from "@awthaq/ports";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

export interface TransportRequest {
  /** The endpoint's own URL: its host is what `Host` and SNI say. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** The address the attempt is pinned to (`HostResolver.pin`); `None` only with `allowPrivateTargets`, in development. */
  readonly pin: Option.Option<HostResolver.PinnedTarget>;
  /** Development and test only: connect to a private/loopback address (the pin's public-address check is lifted). */
  readonly allowPrivate: boolean;
  readonly timeout: Duration.Duration;
}

/** `timeout`: no answer in time. `connect`: the connection or the exchange failed. `blocked`: the address is not a public one. */
export type TransportFailureClass = "timeout" | "connect" | "blocked";

export class WebhookTransportError extends Data.TaggedError("WebhookTransportError")<{
  readonly failure: TransportFailureClass;
}> {}

export interface WebhookTransportShape {
  /** Sends one POST and resolves to the response's status; never reads the response body and never follows a redirect. */
  readonly send: (
    request: TransportRequest,
  ) => Effect.Effect<{ readonly status: number }, WebhookTransportError>;
}

export class WebhookTransport extends Context.Service<WebhookTransport, WebhookTransportShape>()(
  "awthaq/webhooks/WebhookTransport",
) {}

// ---- the pinned Node transport -----------------------------------------------------------------

/** Connects to the pinned address with the original Host/SNI. Requires no service: it is `node:http(s)` directly. */
export const layerNodePinned = Layer.succeed(
  WebhookTransport,
  WebhookTransport.of({
    send: (request) =>
      PinnedHttp.send({ ...request, method: "POST" }).pipe(
        Effect.map((response) => ({ status: response.status })),
        // `tooLarge` cannot happen (the body is never asked for); anything else keeps its class.
        Effect.mapError(
          (error) =>
            new WebhookTransportError({
              failure: error.failure === "tooLarge" ? "connect" : error.failure,
            }),
        ),
      ),
  }),
);

// ---- the HttpClient transport ------------------------------------------------------------------

/** Over any `HttpClient`. It cannot pin (the client resolves the name itself), so DNS rebinding is narrowed, not closed. */
export const layerHttpClient = Layer.effect(
  WebhookTransport,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return WebhookTransport.of({
      send: (request) =>
        client
          .execute(
            HttpClientRequest.post(request.url).pipe(
              HttpClientRequest.setHeaders(request.headers),
              HttpClientRequest.bodyText(request.body, "application/json"),
            ),
          )
          .pipe(
            // A redirect is never followed (the fetch client would, by default); the 3xx is the outcome.
            Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
            Effect.map((response) => ({ status: response.status })),
            Effect.catch(() => Effect.fail(new WebhookTransportError({ failure: "connect" }))),
          ),
    });
  }),
);
