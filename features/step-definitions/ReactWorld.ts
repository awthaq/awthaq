// BEH-EA-177..184 (23-react.feature): the React bindings' atoms — `sessionAtom`, `subjectAtom`,
// the reactivity-keyed mutations — driven against a real awthaq server, with no DOM.
//
// `@awthaq/react`'s atoms talk to `fetch` (`FetchHttpClient`) and read the CSRF cookie from
// `document.cookie`. This World stands in for the browser: a delegating `fetch` that dispatches to
// the composed application's web handler through one `UserAgent` (`@awthaq/web`: its cookie store takes
// `Set-Cookie` in and sends `Cookie` out by a browser's rules), and a `document.cookie` getter exposing
// the store's script-readable (non-`HttpOnly`) cookies. The atoms, the CSRF client
// middleware and the server are all the real ones.
//
// `FetchHttpClient` memoizes `globalThis.fetch` the first time it is read (packages/react's own
// `stubFetch.ts` documents this), so one delegating function is installed for the whole file and
// the browser it delegates to is swapped per Scenario.
import { Auth, Users } from "@awthaq/core";
import { Password } from "@awthaq/password";
import { AuthorizedSubject, SubjectApi } from "@awthaq/qadi";
import { TestAuth, UserAgent } from "@awthaq/test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { STRONG_PASSWORD } from "./shared/Harness.ts";
import { makeOutcomes, type Outcomes } from "./shared/Outcomes.ts";

const NoBreachHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
  ),
);

const ReactServices = Layer.mergeAll(
  SubjectApi.SubjectHandlers.pipe(Layer.provide(AuthorizedSubject.AuthorizedSubjectLive)),
  NoBreachHttpClient,
);

/** Password + core's session/account groups + qadi's `GET /subject`, exactly what an app's `Providers` talks to. */
export const reactTuple = Auth.make([Password.Password], {
  extraGroups: [SubjectApi.SubjectGroup],
});

const appLayer = TestAuth.layer(reactTuple, { services: ReactServices });

const makeApp = () => TestAuth.app(appLayer);

/** One request the "browser" sent. */
export interface SentRequest {
  readonly method: string;
  readonly pathname: string;
  readonly headers: Headers;
}

/** A browser session: a user agent (cookie store, request log) over the composed handler. */
export interface Browser {
  readonly agent: UserAgent.UserAgent;
  /** Every request the page made, oldest first. */
  readonly sent: ReadonlyArray<SentRequest>;
  /** Pathnames whose requests the "network" never answers — a fetch still in flight. */
  readonly hanging: Set<string>;
}

let currentBrowser: Browser | undefined;

const makeBrowser = (handler: (request: Request) => Promise<Response>): Browser => {
  const hanging = new Set<string>();
  const agent = UserAgent.make({ handler, hold: (url) => hanging.has(url.pathname) });
  return {
    agent,
    get sent() {
      return agent.sent.map((entry) => ({
        method: entry.method,
        pathname: entry.url.pathname,
        headers: entry.headers,
      }));
    },
    hanging,
  };
};

/** The page's `fetch`: the agent's network (its cookies out, every `Set-Cookie` back in). */
const browserFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const browser = currentBrowser;
  if (browser === undefined) throw new Error("no browser installed for this Scenario");
  return browser.agent.fetch(input, init);
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
        return currentBrowser?.agent.cookies.scriptVisible() ?? "";
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
    const browser = makeBrowser(app.handler);
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
        }).pipe(TestAuth.withoutRequest),
      ),
    );
  });

export const requestsTo = (method: string, pathname: string) =>
  Effect.gen(function* () {
    const { browser } = yield* World;
    return browser.sent.filter((entry) => entry.method === method && entry.pathname === pathname);
  });
