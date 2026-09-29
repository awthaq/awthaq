// @awthaq/client — AuthClient
//
// spec/behaviors/22-client-effect.md, BEH-EA-169 through BEH-EA-176.
//
// BEH-EA-169: `make`/`makeWith`/`group`/`endpoint`/`urlBuilder` are direct
// re-exports of `HttpApiClient`'s own functions — not re-declared wrapper
// functions — the identical discipline `@awthaq/server`'s `AuthHttp.ts`
// documents for `HttpApiBuilder.layer`/`HttpApiScalar.layer`: re-declaring
// their generics independently would lose the literal group/endpoint
// precision the real functions carry, and would create a second place a
// future `HttpApiClient` API change would need to be mirrored by hand.
//
// **BEH-EA-169's "or `AtomHttpApi.Service` for the reactive binding" is not
// implemented in this module, but is no longer blocked.** An earlier
// revision of this comment said the only published `AtomHttpApi` was
// `@effect-atom/atom`, pinned to `effect: ^3.22.1` and therefore unusable
// against this project's catalog-pinned `effect` — that reasoning no longer
// holds: `effect` itself now ships `AtomHttpApi`/`Atom`/`AtomRegistry`
// natively at `effect/unstable/reactivity` (no external package needed).
// `@awthaq/react`'s `ReactClient.makeReactClient` builds the actual
// `AtomHttpApiClient` service over an application's composed api — this
// module stays the plain, non-reactive `HttpApiClient` binding either way
// (BEH-EA-169 offers both forms; this file is only the first of them).
//
// **BEH-EA-171's `{ csrf: false }` contract variant is still unbuilt** —
// `Auth.make` has no composition-level CSRF opt-out yet (decision ticket 24),
// so a bearer-mode client is, for now, `make(api, { baseUrl, transformClient })`
// against a contract without the `CsrfProtection` middleware, or one that
// supplies its own `csrfClientLayer`/transport. Every mutating production
// group *does* declare `CsrfProtection` (CSRF is on by default), so a
// cookie-mode client needs `CsrfClientLive` below.
import { Api, SessionContract } from "@awthaq/api";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Result from "effect/Result";
import * as Context from "effect/Context";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type { HttpApi, HttpApiEndpoint } from "effect/unstable/httpapi";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";

// ---------------------------------------------------------------------------
// BEH-EA-169/173: the generated client and URL builder
// ---------------------------------------------------------------------------

export const make: typeof HttpApiClient.make = HttpApiClient.make;
export const makeWith: typeof HttpApiClient.makeWith = HttpApiClient.makeWith;
/** A client for a single group only. */
export const group: typeof HttpApiClient.group = HttpApiClient.group;
/** A client for a single endpoint only. */
export const endpoint: typeof HttpApiClient.endpoint = HttpApiClient.endpoint;
export const urlBuilder: typeof HttpApiClient.urlBuilder = HttpApiClient.urlBuilder;

// ---------------------------------------------------------------------------
// BEH-EA-170: CsrfProtection is required by the client type
// ---------------------------------------------------------------------------

/**
 * Reads a cookie by name from `document.cookie`. Returns `undefined` outside
 * a browser (no global `document`) or when the cookie is absent — never
 * throws, since an absent CSRF cookie is an ordinary state (no mutation has
 * been attempted yet), not a client error.
 *
 * Reached via `globalThis`/`Reflect.get` rather than the bare `document`
 * identifier: this package has no `dom` lib (this monorepo's single, shared
 * `tsconfig.test.json` type-checks every package's tests — and, through
 * them, every package's source — under one `lib` setting, so adding `dom`
 * here for this one package would mean adding it everywhere); reflection
 * reads the global dynamically, without needing it declared at all.
 */
export const readCookie = (name: string): string | undefined => {
  const doc = Reflect.get(globalThis, "document");
  if (typeof doc !== "object" || doc === null) return undefined;
  const cookie = Reflect.get(doc, "cookie");
  if (typeof cookie !== "string") return undefined;
  const prefix = `${name}=`;
  const match = cookie.split("; ").find((row) => row.startsWith(prefix));
  return match === undefined ? undefined : decodeURIComponent(match.slice(prefix.length));
};

export interface CsrfClientOptions {
  /**
   * How the CSRF cookie is read (default: `document.cookie` via `readCookie`).
   * A server-side caller — a Next.js server action dispatching in-process —
   * passes a reader over its own request's `Cookie` header instead.
   */
  readonly readCookie?: ((name: string) => string | undefined) | undefined;
  /**
   * Retry a `CsrfRejected` response exactly once when a fresh CSRF cookie has
   * appeared since the request was sent (default `true`) — see `csrfClientLayer`.
   */
  readonly bootstrapRetry?: boolean | undefined;
}

/** CDS-007: is this response the contract's own `CsrfRejected` (403 + its `_tag`)? Reading the body is safe — `HttpClientResponse` caches it for the decode that follows. */
const isCsrfRejected = (response: HttpClientResponse.HttpClientResponse) =>
  response.status === 403
    ? response.json.pipe(
        Effect.map(
          (body) =>
            typeof body === "object" &&
            body !== null &&
            Reflect.get(body, "_tag") === "CsrfRejected",
        ),
        Effect.orElseSucceed(() => false),
      )
    : Effect.succeed(false);

/**
 * BEH-EA-170: a cookie-mode client program does not type-check without
 * providing this — `Api.CsrfProtection` declares `requiredForClient: true`,
 * so `HttpApiMiddleware.ForClient<Api.CsrfProtection>` is a real requirement
 * `HttpApiClient.make` leaves in the built client's own `R` until something
 * satisfies it.
 *
 * CDS-007 — self-bootstrapping. The server mints `__Host-csrf` from a
 * pre-response handler on *any* response through a CSRF-guarded group
 * (including `GET /session`, and including the 403 that rejects a request for
 * lacking it), so a cold browser's first unsafe call carries no cookie and is
 * rejected — once. The layer therefore (1) omits the header when no cookie is
 * readable rather than sending an empty one, and (2) on a `CsrfRejected`
 * response, when a cookie the rejected request did not carry is now readable
 * (the browser stored the 403's `Set-Cookie`), re-issues the request once with
 * it. A second rejection, or a rejection with the same cookie as was sent (a
 * genuinely bad token), surfaces to the caller untouched. Safe to repeat: the
 * guard rejects before any handler work runs.
 */
export const csrfClientLayer = (options?: CsrfClientOptions) => {
  const read = options?.readCookie ?? readCookie;
  const retry = options?.bootstrapRetry ?? true;
  // An empty cookie value is as unusable as an absent one.
  const readToken = () => {
    const token = read(Api.CSRF_COOKIE_NAME);
    return token === "" ? undefined : token;
  };
  const withToken = (request: HttpClientRequest.HttpClientRequest, token: string | undefined) =>
    token === undefined
      ? request
      : HttpClientRequest.setHeader(request, Api.CSRF_HEADER_NAME, token);
  return HttpApiMiddleware.layerClient(Api.CsrfProtection, ({ next, request }) => {
    const sent = readToken();
    const first = next(withToken(request, sent));
    if (!retry) return first;
    return first.pipe(
      Effect.flatMap((response) =>
        isCsrfRejected(response).pipe(
          Effect.flatMap((rejected) => {
            if (!rejected) return Effect.succeed(response);
            const fresh = readToken();
            return fresh === undefined || fresh === sent
              ? Effect.succeed(response)
              : next(withToken(request, fresh));
          }),
        ),
      ),
    );
  });
};

export const CsrfClientLive: Layer.Layer<HttpApiMiddleware.ForClient<Api.CsrfProtection>> =
  csrfClientLayer();

// ---------------------------------------------------------------------------
// BEH-EA-172: error codes are derived from the contract
// ---------------------------------------------------------------------------

type AnyEndpoint = HttpApiEndpoint.ConstraintRequest;

type GroupEndpoints<Group> = Group extends {
  readonly endpoints: infer Endpoints extends Record<string, AnyEndpoint>;
}
  ? Endpoints[keyof Endpoints]
  : never;

/**
 * Every declared error a request against `Endpoint` may fail with — its own
 * `error` schema *and* whatever its attached middleware (e.g. `Authentication`'s
 * `Unauthenticated`) declares — mirroring exactly the union
 * `HttpApiClient`'s own `Client.Method`/`MethodReturn` types already compute
 * for the real generated method (see that module's own `MethodReturn`
 * type), so this cannot drift from what a real client call can actually fail
 * with.
 */
type EndpointErrorType<Endpoint extends AnyEndpoint> =
  | HttpApiMiddleware.Error<Endpoint["~Middleware"]>
  | Endpoint["~Error"]["Type"];

/**
 * BEH-EA-172: `AuthClient.ErrorCodes<typeof AuthApi>` — the set of `_tag`
 * literals an i18n catalog must cover, derived mechanically from the
 * compiled contract rather than a hand-maintained list.
 */
export type ErrorCodes<App extends HttpApi.Constraint> =
  App extends HttpApi.HttpApi<infer _Id, infer Groups>
    ? EndpointErrorType<GroupEndpoints<Groups>> extends { readonly _tag: infer Tag extends string }
      ? Tag
      : never
    : never;

// ---------------------------------------------------------------------------
// BEH-EA-174: session helpers — the hand-written remainder
// ---------------------------------------------------------------------------

/** The wire shape of the core `session` group's own `SessionDto` (`@awthaq/api`'s `Session.ts`) — one source of truth, not a parallel type. */
export type Session = SessionContract.SessionDto;

export interface SessionStoreShape {
  readonly get: Effect.Effect<Option.Option<Session>>;
  /** Always overwrites — the result of a real sign-in/sign-out/refresh. */
  readonly set: (session: Session | null) => Effect.Effect<void>;
  /**
   * BEH-EA-174: SSR seeding — the *first* non-null value ever hydrated wins;
   * a later `hydrate` call is a no-op once anything (hydrated or `set`) has
   * already populated the store, so a slow client-side refetch can never
   * clobber a value the server already committed to the initial render.
   */
  readonly hydrate: (initial: Session) => Effect.Effect<void>;
}

export class SessionStore extends Context.Service<SessionStore, SessionStoreShape>()(
  "awthaq/client/SessionStore",
) {}

export const SessionStoreLive: Layer.Layer<SessionStore> = Layer.effect(
  SessionStore,
  Effect.gen(function* () {
    const state = yield* Ref.make(Option.none<Session>());
    return {
      get: Ref.get(state),
      set: (session) => Ref.set(state, Option.fromNullOr(session)),
      hydrate: (initial) =>
        Ref.update(
          state,
          Option.orElse(() => Option.some(initial)),
        ),
    };
  }),
);

// ---------------------------------------------------------------------------
// BEH-EA-176: a Promise facade is opt-in, never a second client
// ---------------------------------------------------------------------------

type AnyClientMethod = (...args: ReadonlyArray<never>) => Effect.Effect<unknown, unknown, never>;

/** Mirrors a generated client's shape, replacing every `R = never` method with a `Promise`-returning one. */
export type PromiseFacade<A> = A extends AnyClientMethod
  ? (...args: Parameters<A>) => Promise<Effect.Success<ReturnType<A>>>
  : A extends Readonly<Record<string, unknown>>
    ? { readonly [K in keyof A]: PromiseFacade<A[K]> }
    : A;

/**
 * EHA-005: like {@link PromiseFacade}, but every method resolves a
 * `Result<A, E>` — `E` the method's own error union — instead of rejecting.
 */
export type ResultFacade<A> = A extends AnyClientMethod
  ? (
      ...args: Parameters<A>
    ) => Promise<Result.Result<Effect.Success<ReturnType<A>>, Effect.Error<ReturnType<A>>>>
  : A extends Readonly<Record<string, unknown>>
    ? { readonly [K in keyof A]: ResultFacade<A[K]> }
    : A;

/**
 * BEH-EA-176: wraps an already-built client (every method's own `R` already
 * discharged to `never` — the ordinary shape once `baseUrl`/`HttpClient`/any
 * required client middleware have been provided) so a non-Effect caller gets
 * `Promise`s back. Calls the *same* generated methods this module's own
 * `make` produces — never a second, independently implemented transport —
 * the identical discipline `usage-qadi.md`'s `makeQadi` documents for
 * wrapping "the same Layer as the server."
 *
 * Declared as an overload rather than one generic arrow function so the
 * *implementation* can be typed against its own honest, checkable signature
 * (`Readonly<Record<string, unknown>> => unknown`) instead of a cast at the
 * boundary between a runtime-generic recursive walk and the precise
 * `PromiseFacade<A>` conditional type no such walk can structurally prove
 * itself against — the same overload-vs-implementation split
 * `@awthaq/core`'s `Auth.make` already uses for the identical reason
 * (that module's own doc comment explains it in more depth).
 *
 * EHA-005 — two modes, the same generated methods either way:
 *
 * - default: a Promise per call that **rejects** with the endpoint's tagged
 *   contract error (`switch (error._tag)` in a `catch`, cf. `ErrorCodes<Api>`),
 *   but whose *type* says nothing about it — a rejection is untyped in
 *   TypeScript;
 * - `{ mode: "result" }` ({@link ResultFacade}): a Promise that always
 *   **resolves** to a `Result<A, E>`, `E` being the endpoint's contract error
 *   union, so a non-Effect caller narrows `result.failure._tag` with
 *   exhaustiveness checking.
 *
 * In both modes a defect (a network or decoding failure the contract does not
 * declare) still rejects.
 */
export function toPromiseFacade<A extends Readonly<Record<string, unknown>>>(
  client: A,
): PromiseFacade<A>;
export function toPromiseFacade<A extends Readonly<Record<string, unknown>>>(
  client: A,
  options: { readonly mode: "result" },
): ResultFacade<A>;
export function toPromiseFacade(
  client: Readonly<Record<string, unknown>>,
  options?: { readonly mode?: "promise" | "result" },
): unknown {
  const run = (effect: Effect.Effect<unknown, unknown, never>) =>
    Effect.runPromise(options?.mode === "result" ? Effect.result(effect) : effect);
  const wrap = (value: unknown): unknown => {
    if (typeof value === "function") {
      return (...args: ReadonlyArray<unknown>) => run(value(...args));
    }
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, wrap(nested)]));
    }
    return value;
  };
  return wrap(client);
}
