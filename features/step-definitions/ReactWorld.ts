// BEH-EA-177..184 (23-react.feature): the React bindings' atoms — `sessionAtom`, `subjectAtom`,
// the reactivity-keyed mutations — driven against a real awthaq server, with no DOM.
//
// `@awthaq/react`'s atoms talk to `fetch` (`FetchHttpClient`) and read the CSRF cookie from
// `document.cookie`. This World stands in for the browser: a delegating `fetch` that dispatches to
// the composed application's web handler and keeps a cookie jar (`Set-Cookie` in, `Cookie` out), and
// a `document.cookie` getter exposing the jar's script-readable cookies. The atoms, the CSRF client
// middleware and the server are all the real ones.
//
// `FetchHttpClient` memoizes `globalThis.fetch` the first time it is read (packages/react's own
// `stubFetch.ts` documents this), so one delegating function is installed for the whole file and
// the browser it delegates to is swapped per Scenario.
import { Auth, Users } from "@awthaq/core";
import { Password } from "@awthaq/password";
import { AuthorizedSubject, SubjectApi } from "@awthaq/qadi";
import { Authentication, Csrf } from "@awthaq/server";
import { TestAuth } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { CsrfConfigForTests } from "./CsrfTestSupport.ts";
import { STRONG_PASSWORD } from "./shared/Harness.ts";
import { makeOutcomes, type Outcomes } from "./shared/Outcomes.ts";

const NoBreachHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
  ),
);

const OptionalAuthenticationLive = Authentication.OptionalAuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const ReactServices = Layer.mergeAll(
  Authentication.AuthenticationLive.pipe(Layer.provide(Authentication.PrincipalResolverLive)),
  Csrf.CsrfProtectionLive.pipe(Layer.provide(Layer.succeed(Csrf.CsrfConfig, CsrfConfigForTests))),
  SubjectApi.SubjectHandlers.pipe(Layer.provide(AuthorizedSubject.AuthorizedSubjectLive)),
  NoBreachHttpClient,
).pipe(Layer.provideMerge(OptionalAuthenticationLive), Layer.provide(NodeCrypto.layer));

/** Password + core's session/account groups + qadi's `GET /subject`, exactly what an app's `Providers` talks to. */
export const reactTuple = Auth.make([Password.Password], {
  extraGroups: [SubjectApi.SubjectGroup],
});

const appLayer = TestAuth.layer(reactTuple, ReactServices);

const makeApp = () => {
  const memoMap = Layer.makeMemoMapUnsafe();
  const { handler, dispose } = HttpRouter.toWebHandler(appLayer, { memoMap });
  const runtime = ManagedRuntime.make(appLayer, { memoMap });
  return { handler, runtime, dispose: () => Promise.all([dispose(), runtime.dispose()]) };
};

/** One request the "browser" sent. */
export interface SentRequest {
  readonly method: string;
  readonly pathname: string;
  readonly headers: Headers;
}

/** A browser session: a cookie jar and a log of every request the page made. */
export interface Browser {
  readonly handler: (request: Request) => Promise<Response>;
  readonly jar: Map<string, string>;
  readonly sent: Array<SentRequest>;
  /** Pathnames whose requests the "network" never answers — a fetch still in flight. */
  readonly hanging: Set<string>;
}

let currentBrowser: Browser | undefined;

const cookieHeaderOf = (jar: ReadonlyMap<string, string>) =>
  [...jar].map(([name, value]) => `${name}=${value}`).join("; ");

/** The `Set-Cookie` values of a response, one per cookie (not folded into one header). */
const setCookiesOf = (response: Response): ReadonlyArray<string> => response.headers.getSetCookie();

const browserFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const browser = currentBrowser;
  if (browser === undefined) throw new Error("no browser installed for this Scenario");
  const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const headers = new Headers(init?.headers);
  if (browser.jar.size > 0) headers.set("cookie", cookieHeaderOf(browser.jar));
  browser.sent.push({ method, pathname: url.pathname, headers });
  if (browser.hanging.has(url.pathname)) return new Promise<Response>(() => undefined);
  const response = await browser.handler(
    new Request(url, { method, headers, ...(init?.body === undefined ? {} : { body: init.body }) }),
  );
  for (const raw of setCookiesOf(response)) {
    const [pair = ""] = raw.split(";");
    const separator = pair.indexOf("=");
    if (separator > 0) {
      const value = pair.slice(separator + 1);
      // An expired cookie (`Max-Age=0` / empty) leaves the jar, as a browser would.
      if (/max-age=0/i.test(raw) || value === "") browser.jar.delete(pair.slice(0, separator));
      else browser.jar.set(pair.slice(0, separator), value);
    }
  }
  return response;
};

let installed = false;
/** `document.cookie` as a page script sees it: only the cookies that are not `HttpOnly`. */
const installBrowserGlobals = () => {
  if (installed) return;
  installed = true;
  Reflect.set(globalThis, "fetch", browserFetch);
  // Relative request URLs ("/session") resolve against the page's location, as they do in a browser.
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: "http://localhost", pathname: "/" },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      get cookie() {
        const visible = [...(currentBrowser?.jar ?? [])].filter(([name]) => name === "__Host-csrf");
        return visible.map(([name, value]) => `${name}=${value}`).join("; ");
      },
    },
  });
};

export interface WorldShape {
  readonly outcomes: Outcomes;
  readonly browser: Browser;
  readonly runtime: ReturnType<typeof makeApp>["runtime"];
}

export class World extends Context.Service<World, WorldShape>()("features/ReactWorld") {}

export const WorldLive = Layer.effect(
  World,
  Effect.gen(function* () {
    installBrowserGlobals();
    const app = yield* Effect.acquireRelease(
      Effect.sync(() => makeApp()),
      (built) =>
        Effect.promise(() => built.dispose()).pipe(
          Effect.andThen(
            Effect.sync(() => {
              currentBrowser = undefined;
            }),
          ),
        ),
    );
    const browser: Browser = { handler: app.handler, jar: new Map(), sent: [], hanging: new Set() };
    currentBrowser = browser;
    return World.of({ outcomes: yield* makeOutcomes, browser, runtime: app.runtime });
  }),
);

/** A verified account with a password, the one thing an app has before its sign-in form is used. */
export const registerUser = (email: string) =>
  Effect.gen(function* () {
    const { runtime } = yield* World;
    yield* Effect.promise(() =>
      runtime.runPromise(
        Effect.gen(function* () {
          const passwords = yield* Password.Password;
          const users = yield* Users.Users;
          const signedUp = yield* passwords.signUp({
            email,
            password: Redacted.make(STRONG_PASSWORD),
          });
          yield* users.verifyEmail(signedUp.session.userId);
        }),
      ),
    );
  });

export const requestsTo = (method: string, pathname: string) =>
  Effect.gen(function* () {
    const { browser } = yield* World;
    return browser.sent.filter((entry) => entry.method === method && entry.pathname === pathname);
  });
