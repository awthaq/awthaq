// EAR-004: a tiny fetch router for the live-path suites. Every request must
// match a registered route (method + pathname) or the stub throws — an
// unstubbed request is a test bug, not a socket hang-up to shrug off.
//
// One delegating function is installed for the whole file rather than a new
// stub per test: `FetchHttpClient`'s `Fetch` reference memoizes
// `globalThis.fetch` the first time it is read, so a later `vi.stubGlobal`
// would never be seen by an already-warm client. The route table it reads is
// what changes between tests.
import { vi } from "vitest";

interface RecordedRequest {
  readonly method: string;
  readonly pathname: string;
  readonly url: string;
  readonly headers: Headers;
}

export type Handler = (request: RecordedRequest) => Response | Promise<Response>;

export const jsonResponse = (body: unknown, status = 200, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    ...init,
    status,
    headers: { "content-type": "application/json", ...init?.headers },
  });

/** Each call takes the next handler; the last one repeats. */
export const sequence = (...handlers: ReadonlyArray<Handler>): Handler => {
  const queue = [...handlers];
  return (request) => {
    const handler = queue.length > 1 ? queue.shift() : queue[0];
    if (handler === undefined) throw new Error(`stubFetch: empty sequence for ${request.pathname}`);
    return handler(request);
  };
};

let current:
  | { routes: Readonly<Record<string, Handler>>; requests: Array<RecordedRequest> }
  | undefined;

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  // Not `new Request(...)`: happy-dom's `Request` rejects some absolute
  // cross-origin URLs, and the router only needs method/url/headers.
  const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  if (current === undefined) {
    throw new Error(`stubFetch: request with no stub installed: ${method} ${url.pathname}`);
  }
  const recorded = {
    method,
    pathname: url.pathname,
    url: url.href,
    headers: new Headers(init?.headers),
  };
  current.requests.push(recorded);
  const handler = current.routes[`${method} ${url.pathname}`];
  if (handler === undefined) {
    throw new Error(`stubFetch: unexpected request ${method} ${url.pathname}`);
  }
  return handler(recorded);
};

export const installFetchStub = (routes: Readonly<Record<string, Handler>>) => {
  const requests: Array<RecordedRequest> = [];
  current = { routes, requests };
  vi.stubGlobal("fetch", stub);
  return requests;
};

export const restoreFetch = (): void => {
  current = undefined;
  vi.unstubAllGlobals();
};
