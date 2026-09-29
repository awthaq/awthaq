// BEH-EA-185..192 (24-nextjs-ssr.feature): what a Next.js app's server side does with awthaq.
// `getSession`, `hasSessionCookie` and `withNextCookies` are called exactly as a Server Component,
// `proxy.ts` and a server action call them: `getSession` over a real `ManagedRuntime` built from a
// `TestAuth.layer` composition (memory `Sessions`/`Users`, the real `PrincipalResolver`), so a
// session row really exists (or does not) behind each cookie; `withNextCookies` over a recording
// cookie jar standing in for `next/headers`' `cookies()`.
import { Api } from "@awthaq/api";
import { Auth } from "@awthaq/core";
import { Password } from "@awthaq/password";
import { SubjectResolver } from "@awthaq/qadi";
import { Authentication, Csrf } from "@awthaq/server";
import { TestAuth } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { makeSubject } from "@qadi/core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { CsrfConfigForTests } from "./CsrfTestSupport.ts";
import { makeOutcomes, type Outcomes } from "./shared/Outcomes.ts";

const NoBreachHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
  ),
);

// The CSRF secret every BDD World shares (CsrfTestSupport.ts), so a cookie pair minted there is
// accepted by this composition's `CsrfProtection`.
const NextServices = Layer.mergeAll(
  Authentication.AuthenticationLive.pipe(Layer.provide(Authentication.PrincipalResolverLive)),
  Csrf.CsrfProtectionLive.pipe(Layer.provide(Layer.succeed(Csrf.CsrfConfig, CsrfConfigForTests))),
  NoBreachHttpClient,
).pipe(Layer.provide(NodeCrypto.layer));

const nextTuple = Auth.make([Password.Password]);

export interface RecordedCookie {
  readonly name: string;
  readonly value: string;
}

export interface WorldShape {
  readonly outcomes: Outcomes;
  /** What `next/headers`' `cookies().set(...)` was asked to write. */
  readonly jar: {
    readonly set: (name: string, value: string) => void;
    readonly written: Ref.Ref<ReadonlyArray<RecordedCookie>>;
  };
  /** The roles the scenario's application-owned `SubjectResolver` currently grants everyone. */
  readonly roles: Ref.Ref<ReadonlyArray<string>>;
  /** How many times the `SubjectResolver` was consulted. */
  readonly resolverCalls: Ref.Ref<number>;
  readonly runtime: ReturnType<typeof makeApp>["runtime"];
  /** The web handler over the same running services — real responses, `Set-Cookie` included. */
  readonly handler: ReturnType<typeof makeApp>["handler"];
}

export class World extends Context.Service<World, WorldShape>()("features/NextSsrWorld") {}

/** A `SubjectResolver` that reads its roles from a `Ref` and counts consultations — the seam `getSession`'s caller resolves a subject through (BEH-EA-190/191). */
const countingResolver = (roles: Ref.Ref<ReadonlyArray<string>>, calls: Ref.Ref<number>) =>
  Layer.succeed(SubjectResolver.SubjectResolver, {
    resolve: (principal) =>
      Ref.update(calls, (count) => count + 1).pipe(
        Effect.andThen(Ref.get(roles)),
        Effect.map((granted) =>
          principal._tag === "User"
            ? makeSubject({
                id: `user:${principal.ref.id}`,
                roles: granted,
                // Whoever holds a role may act on projects; a subject with no roles holds nothing.
                permissions:
                  granted.length === 0 ? [] : ["project:read", "project:delete", "project:invite"],
              })
            : makeSubject({ id: "anonymous" }),
        ),
      ),
  });

const appLayer = (roles: Ref.Ref<ReadonlyArray<string>>, calls: Ref.Ref<number>) =>
  countingResolver(roles, calls).pipe(
    Layer.provideMerge(Authentication.PrincipalResolverLive),
    Layer.provideMerge(TestAuth.layer(nextTuple, NextServices)),
  );

/**
 * One application, two ways in: the web `handler` (what a server action's in-process client
 * dispatches to — the only path that applies pre-response handlers, so the only one whose responses
 * carry `Set-Cookie`) and a `ManagedRuntime` (what `getSession` runs on). Both resolve against one
 * `MemoMap`, so they share the very same `Sessions`/`Users` instances — a session issued through
 * either is visible to the other.
 */
const makeApp = (roles: Ref.Ref<ReadonlyArray<string>>, calls: Ref.Ref<number>) => {
  const layer = appLayer(roles, calls);
  const memoMap = Layer.makeMemoMapUnsafe();
  const { handler, dispose } = HttpRouter.toWebHandler(layer, { memoMap });
  const runtime = ManagedRuntime.make(layer, { memoMap });
  return { handler, runtime, dispose: () => Promise.all([dispose(), runtime.dispose()]) };
};

export const WorldLive = Layer.effect(
  World,
  Effect.gen(function* () {
    const roles = yield* Ref.make<ReadonlyArray<string>>([]);
    const resolverCalls = yield* Ref.make(0);
    const written = yield* Ref.make<ReadonlyArray<RecordedCookie>>([]);
    const app = yield* Effect.acquireRelease(
      Effect.sync(() => makeApp(roles, resolverCalls)),
      (built) => Effect.promise(() => built.dispose()),
    );
    return World.of({
      outcomes: yield* makeOutcomes,
      jar: {
        set: (name, value) => Effect.runSync(Ref.update(written, (all) => [...all, { name, value }])),
        written,
      },
      roles,
      resolverCalls,
      runtime: app.runtime,
      handler: app.handler,
    });
  }),
);

/** The `Headers`-like a Server Component gets from `await headers()`. */
export const headersWithCookie = (cookieHeader: string | null) => ({
  get: (name: string) => (name.toLowerCase() === "cookie" ? cookieHeader : null),
});

export const SESSION_COOKIE = Api.SessionCookie.key;

/** Sends a web `Request` through the composed application, the way a server action's in-process client does. */
export const send = (request: Request) =>
  Effect.gen(function* () {
    const { handler } = yield* World;
    return yield* Effect.promise(() => handler(request));
  });
