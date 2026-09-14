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
// against this project's `effect@4.0.0-rc.115` — that reasoning no longer
// holds: `effect` itself now ships `AtomHttpApi`/`Atom`/`AtomRegistry`
// natively at `effect/unstable/reactivity` (confirmed present in this
// repo's own installed `effect` dependency, no external package needed).
// `@awthaq/react`'s own reactive bindings (M5, not yet built) are the
// right place to build the actual `AtomHttpApiClient` service over this
// package's `Api` contract — this module stays the plain, non-reactive
// `HttpApiClient` binding either way (BEH-EA-169 offers both forms; this
// file is only the first of them).
//
// **BEH-EA-171's `{ csrf: false }` contract variant has nothing to build
// against yet.** No plugin's `HttpApiGroup` in this repository currently
// declares `.middleware(Api.CsrfProtection)` at all — `Password`/`OAuth`/the
// core `session` group all use `Authentication`/`OptionalAuthentication`
// only — so there is no real, CSRF-carrying contract for a `{ csrf: false }`
// variant to strip `CsrfProtection` middleware *from* today. A bearer-mode
// client is, for now, simply `make(api, { baseUrl, transformClient })` with
// no `CsrfClientLive` provided, which already type-checks and behaves
// correctly against every contract this repository currently composes.
import { Api, SessionContract } from "@awthaq/api";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Context from "effect/Context";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
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

/**
 * BEH-EA-170: a cookie-mode client program does not type-check without
 * providing this — `Api.CsrfProtection` declares `requiredForClient: true`,
 * so `HttpApiMiddleware.ForClient<Api.CsrfProtection>` is a real requirement
 * `HttpApiClient.make` leaves in the built client's own `R` until something
 * satisfies it.
 */
export const CsrfClientLive: Layer.Layer<HttpApiMiddleware.ForClient<Api.CsrfProtection>> =
  HttpApiMiddleware.layerClient(Api.CsrfProtection, ({ next, request }) =>
    next(
      HttpClientRequest.setHeader(
        request,
        Api.CSRF_HEADER_NAME,
        readCookie(Api.CSRF_COOKIE_NAME) ?? "",
      ),
    ),
  );

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
 */
export function toPromiseFacade<A extends Readonly<Record<string, unknown>>>(
  client: A,
): PromiseFacade<A>;
export function toPromiseFacade(client: Readonly<Record<string, unknown>>): unknown {
  const wrap = (value: unknown): unknown => {
    if (typeof value === "function") {
      return (...args: ReadonlyArray<unknown>) => Effect.runPromise(value(...args));
    }
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, wrap(nested)]));
    }
    return value;
  };
  return wrap(client);
}
