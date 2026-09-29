// @awthaq/ports — PinnedHttp
//
// BEH-EA-303 (webhooks) and BEH-EA-306 (SAML metadata import): the one place this codebase makes an outbound HTTP
// request to an address it has just judged, so DNS rebinding has nothing to flip. A caller resolves the URL's host once
// (`HostResolver.pin`) and hands the pinned address here; the request connects to THAT address as an IP literal (so the
// platform never resolves the name), while the URL's own host name stays the `Host` header and the TLS server name (SNI,
// and the name the certificate is verified against).
//
//   - The address is judged again here (`OutboundUrl.isPublicAddress`), so a caller that skips the check still cannot make
//     this reach a private address. `allowPrivate` (development and test only) lifts that, and the pin.
//   - A redirect is never followed (a 3xx is just a status), and a fresh connection is used for every request (never a
//     pooled socket that was opened to some other address).
//   - The response body is not read unless the caller asks for it with `maxResponseBytes`, and then never beyond that
//     many bytes: a receiver that keeps sending is cut off (`tooLarge`), not buffered.
//   - Failures are reported as a CLASS only (`timeout`, `connect`, `blocked`, `tooLarge`), never a message: what a hostile
//     receiver or resolver says is untrusted text that must not reach a log, a delivery row or an API response.
//
// Node only (`node:http`/`node:https`, loaded lazily so this module stays bundler-neutral like `HostResolver.layerNode`); a
// runtime without them uses its own client and cannot pin.

import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { PinnedTarget } from "./HostResolver.ts";
import * as OutboundUrl from "./OutboundUrl.ts";

export interface PinnedRequest {
  readonly method: "GET" | "POST";
  /** The URL as registered: its host is what `Host` and SNI say. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string | undefined;
  /** The address to connect to (`HostResolver.pin`); `None` only with `allowPrivate`, in development. */
  readonly pin: Option.Option<PinnedTarget>;
  /** Development and test only: connect to a private/loopback address (the address check is lifted). */
  readonly allowPrivate: boolean;
  readonly timeout: Duration.Duration;
  /** Read the response body, up to this many bytes; absent, the body is never read. */
  readonly maxResponseBytes?: number | undefined;
}

/** `timeout`: no answer in time. `connect`: the connection or the exchange failed. `blocked`: the address is not a public one. `tooLarge`: the body exceeded `maxResponseBytes`. */
export type PinnedFailureClass = "timeout" | "connect" | "blocked" | "tooLarge";

export class PinnedHttpError extends Data.TaggedError("PinnedHttpError")<{
  readonly failure: PinnedFailureClass;
}> {}

export interface PinnedResponse {
  readonly status: number;
  /** The body (UTF-8), only when `maxResponseBytes` was asked for. */
  readonly body: string | undefined;
}

/** What `node:http(s).request` is called with. Exported so the pinning is testable without a network. */
export interface PinnedRequestOptions {
  readonly secure: boolean;
  readonly host: string;
  readonly port: number;
  readonly path: string;
  /** The TLS server name: the URL's own host name (absent for an IP-literal URL, where SNI does not apply). */
  readonly servername: string | undefined;
  readonly headers: Readonly<Record<string, string>>;
}

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

/**
 * The connection options for `request`, `"blocked"` when the pinned address is not a public one (and private targets are
 * not allowed), or `"unpinned"` when there is no pin (development mode: an ordinary connection). `host` is the pinned IP
 * literal, so the platform never resolves a name; `headers.host` and `servername` keep the original name.
 */
export const pinnedRequestOptions = (
  request: PinnedRequest,
): PinnedRequestOptions | "blocked" | "unpinned" => {
  const url = URL.parse(request.url);
  if (url === null) return "blocked";
  if (Option.isNone(request.pin)) return "unpinned";
  const { address, hostname } = request.pin.value;
  if (!request.allowPrivate && !OutboundUrl.isPublicAddress(address)) return "blocked";
  const secure = url.protocol === "https:";
  return {
    secure,
    host: address,
    port: url.port === "" ? (secure ? 443 : 80) : Number(url.port),
    path: `${url.pathname}${url.search}`,
    servername: OutboundUrl.isIpLiteral(hostname) ? undefined : hostname,
    headers: {
      ...request.headers,
      host: url.host,
      ...(request.body === undefined ? {} : { "content-length": String(bytesOf(request.body)) }),
    },
  };
};

const failure = (failureClass: PinnedFailureClass) =>
  Effect.fail(new PinnedHttpError({ failure: failureClass }));

/** Sends one request as described above. The deadline is `request.timeout`; an interrupted send destroys its socket. */
export const send = (request: PinnedRequest): Effect.Effect<PinnedResponse, PinnedHttpError> => {
  const options = pinnedRequestOptions(request);
  if (options === "blocked") return failure("blocked");
  const url = new URL(request.url);
  const secure = options === "unpinned" ? url.protocol === "https:" : options.secure;
  const limit = request.maxResponseBytes;
  return Effect.promise(async () => ({
    http: await import("node:http"),
    https: await import("node:https"),
  })).pipe(
    Effect.flatMap(({ http, https }) =>
      Effect.callback<PinnedResponse, PinnedHttpError>((resume) => {
        const client = secure ? https : http;
        const outgoing = client.request(
          {
            method: request.method,
            agent: false,
            host: options === "unpinned" ? url.hostname.replace(/^\[|\]$/g, "") : options.host,
            port:
              options === "unpinned"
                ? url.port === ""
                  ? secure
                    ? 443
                    : 80
                  : Number(url.port)
                : options.port,
            path: options === "unpinned" ? `${url.pathname}${url.search}` : options.path,
            ...(options === "unpinned" || options.servername === undefined
              ? {}
              : { servername: options.servername }),
            headers:
              options === "unpinned"
                ? {
                    ...request.headers,
                    ...(request.body === undefined
                      ? {}
                      : { "content-length": String(bytesOf(request.body)) }),
                  }
                : options.headers,
          },
          (response) => {
            const status = response.statusCode ?? 0;
            if (limit === undefined) {
              // Only the status line is wanted: destroy the socket rather than read what a receiver sends back.
              response.destroy();
              resume(Effect.succeed({ status, body: undefined }));
              return;
            }
            const chunks: Array<Buffer> = [];
            let received = 0;
            response.on("data", (chunk: Buffer) => {
              received += chunk.length;
              if (received > limit) {
                response.destroy();
                resume(failure("tooLarge"));
                return;
              }
              chunks.push(chunk);
            });
            response.on("end", () => {
              resume(Effect.succeed({ status, body: Buffer.concat(chunks).toString("utf8") }));
            });
            response.on("error", () => resume(failure("connect")));
          },
        );
        outgoing.on("error", () => resume(failure("connect")));
        outgoing.end(request.body);
        return Effect.sync(() => outgoing.destroy());
      }),
    ),
    Effect.timeoutOrElse({
      duration: request.timeout,
      orElse: () => failure("timeout"),
    }),
  );
};
