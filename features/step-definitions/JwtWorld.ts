// BDD-005/P20a: the JWT plugin's real wire-level seam — `packages/jwt/test/BearerReentry.test.ts`'s
// composition (the stateless recipe plus the bearer-credential registry), driven over
// `HttpRouter.toWebHandler` as real signed-in callers. Tokens are inspected the way a
// downstream service would: by decoding the compact JWS and by verifying against the served
// JWKS. Defective tokens are signed with the issuer's *real* current key (or a real key it
// never published) so a rejection is about the defect, not about a bad signature by accident.
import { AuditLog, AuthEvents, Hooks, Sessions, Users } from "@awthaq/core";
import { SqlTransaction } from "@awthaq/ports";
import { Authentication, AuthHttp } from "@awthaq/server";
import {
  Jwt,
  JwtApi,
  JwtCodec,
  JwtConfig,
  KeyRing,
  RevocationStore,
  SigningKeyRecords,
} from "@awthaq/jwt";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { makeNamedRegistry, TestServices } from "./shared/Harness.ts";
import { parseJson, isRecord, snapshot, type Snapshot } from "./shared/WireJson.ts";

export const ISSUER = "https://issuer.test";

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

export type JwtConfigInput = Parameters<typeof JwtConfig.config>[0];

const buildAppLayer = (config: JwtConfigInput) =>
  AuthHttp.routes(JwtApi.JwtApi).pipe(
    Layer.provideMerge(Jwt.Jwt.layer),
    Layer.provideMerge(AuthenticationLive),
    // Always composed: with `acceptAsBearer` off it changes nothing (a bearer that no
    // contribution claims falls back to the opaque session lookup), and opting in without it
    // fails the build.
    Layer.provideMerge(Authentication.CredentialResolversLive),
    Layer.provideMerge(KeyRing.KeyRing.layer),
    Layer.provideMerge(SigningKeyRecords.layerMemory),
    Layer.provideMerge(SqlTransaction.layerNoop),
    Layer.provideMerge(Sessions.layerMemory),
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layerMemory),
    Layer.provideMerge(Hooks.HooksLive),
    Layer.provideMerge(RevocationStore.layerMemory),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(TestServices),
    Layer.provideMerge(HttpRouter.layer),
    Layer.provideMerge(JwtConfig.config(config)),
  );

type AppLayer = ReturnType<typeof buildAppLayer>;
export type AppServices = Layer.Success<AppLayer>;

export interface AppHandle {
  readonly handler: (request: Request) => Promise<Response>;
  readonly withContext: <A, E>(effect: Effect.Effect<A, E, AppServices>) => Promise<A>;
  readonly close: Effect.Effect<void>;
}

const buildApp = (config: JwtConfigInput): AppHandle => {
  const layer = buildAppLayer(config);
  const memoMap = Layer.makeMemoMapUnsafe();
  const { handler } = HttpRouter.toWebHandler(layer, { memoMap });
  // One long-lived scope owns the built layer, so the key ring and stores are the very
  // instances `handler` runs on for the whole scenario.
  const scope = Effect.runSync(Scope.make());
  let built: Promise<Context.Context<AppServices>> | undefined;
  const context = () =>
    (built ??= Effect.runPromise(Layer.buildWithMemoMap(layer, memoMap, scope)));
  const withContext: AppHandle["withContext"] = (effect) =>
    context().then((services) => Effect.runPromise(effect.pipe(Effect.provide(services))));
  return { handler, withContext, close: Scope.close(scope, Exit.void) };
};

/** One signed-in caller: a real user id and a real session, with both its cookie and its raw opaque token. */
export interface Actor {
  readonly name: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly cookie: string;
  readonly sessionToken: string;
}

export interface WorldShape {
  readonly app: Ref.Ref<AppHandle>;
  readonly config: Ref.Ref<JwtConfigInput>;
  readonly users: ReturnType<typeof makeNamedRegistry<Actor>>;
  /** Compact tokens by the label the scenario gave them ("alice", "forged", "tampered"). */
  readonly tokens: ReturnType<typeof makeNamedRegistry<string>>;
  /** Every token minted through `POST /jwt/token`, per requester, oldest first: "the token minted for X" is the first. */
  readonly minted: Map<string, Array<string>>;
  readonly newest: Ref.Ref<string | undefined>;
  readonly last: Ref.Ref<Snapshot | undefined>;
  /** How many times something fetched `GET /jwt/jwks` through the in-process HTTP client. */
  readonly jwksFetches: Ref.Ref<number>;
  /** The downstream verifier a scenario built (its own key cache), if any. */
  readonly verifier: Ref.Ref<VerifierHandle | undefined>;
  /** Set once anyone signs in, so a late configuration change is a bug in the scenario, not a silent reset. */
  readonly started: Ref.Ref<boolean>;
}

export interface VerifierHandle {
  readonly verify: (token: string) => Promise<Exit.Exit<Record<string, unknown>, unknown>>;
}

export class World extends Context.Service<World, WorldShape>()("features/JwtWorld") {}

const DEFAULT_CONFIG: JwtConfigInput = { issuer: ISSUER };

export const WorldLive = Layer.effect(
  World,
  Effect.gen(function* () {
    const app = yield* Ref.make(buildApp(DEFAULT_CONFIG));
    yield* Effect.addFinalizer(() => Ref.get(app).pipe(Effect.flatMap((handle) => handle.close)));
    return World.of({
      app,
      config: yield* Ref.make(DEFAULT_CONFIG),
      users: makeNamedRegistry<Actor>("user"),
      tokens: makeNamedRegistry<string>("token"),
      minted: new Map(),
      newest: yield* Ref.make<string | undefined>(undefined),
      last: yield* Ref.make<Snapshot | undefined>(undefined),
      jwksFetches: yield* Ref.make(0),
      verifier: yield* Ref.make<VerifierHandle | undefined>(undefined),
      started: yield* Ref.make(false),
    });
  }),
);

export const currentApp = Effect.gen(function* () {
  const { app } = yield* World;
  return yield* Ref.get(app);
});

/** Merges `config` over what earlier Givens set and rebuilds the app; only before anyone signs in. */
export const configureApp = Effect.fn("features.jwt.configureApp")(function* (
  config: Partial<JwtConfigInput>,
) {
  const world = yield* World;
  if (yield* Ref.get(world.started)) {
    return yield* Effect.die(new Error("configure the app before anyone signs in"));
  }
  const merged: JwtConfigInput = { ...(yield* Ref.get(world.config)), ...config };
  yield* Ref.set(world.config, merged);
  yield* Ref.set(world.app, buildApp(merged));
});

export const signInUser = Effect.fn("features.jwt.signInUser")(function* (name: string) {
  const world = yield* World;
  const app = yield* currentApp;
  yield* Ref.set(world.started, true);
  const userId = `user-${name}`;
  const actor = yield* Effect.promise(() =>
    app.withContext(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const issued = yield* sessions.issue({ userId: Users.UserId(userId) }).pipe(Effect.orDie);
        const token = Redacted.value(issued.token);
        return {
          name,
          userId,
          sessionId: issued.session.id,
          cookie: `${Sessions.SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
          sessionToken: token,
        };
      }),
    ),
  );
  yield* world.users.set(name, actor);
  return actor;
});

/** A second session of an already signed-in user, registered under `sessionName`. */
export const openSession = Effect.fn("features.jwt.openSession")(function* (
  sessionName: string,
  userName: string,
) {
  const world = yield* World;
  const app = yield* currentApp;
  const owner = yield* world.users.get(userName);
  const actor = yield* Effect.promise(() =>
    app.withContext(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const issued = yield* sessions
          .issue({ userId: Users.UserId(owner.userId) })
          .pipe(Effect.orDie);
        const token = Redacted.value(issued.token);
        return {
          ...owner,
          sessionId: issued.session.id,
          cookie: `${Sessions.SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
          sessionToken: token,
        };
      }),
    ),
  );
  yield* world.users.set(sessionName, actor);
});

export const request = Effect.fn("features.jwt.request")(function* (
  init: {
    readonly method: string;
    readonly path: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: unknown;
  },
  options: { readonly observe?: boolean } = {},
) {
  const world = yield* World;
  const { handler } = yield* currentApp;
  const response = yield* Effect.promise(() =>
    handler(
      new Request(`http://localhost${init.path}`, {
        method: init.method,
        headers: {
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...init.headers,
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    ),
  );
  const drained = yield* snapshot(response);
  if (options.observe !== true) yield* Ref.set(world.last, drained);
  return drained;
});

export const requestAs = Effect.fn("features.jwt.requestAs")(function* (
  who: string,
  init: { readonly method: string; readonly path: string; readonly body?: unknown },
  options: { readonly observe?: boolean } = {},
) {
  const world = yield* World;
  const actor = yield* world.users.get(who);
  return yield* request({ ...init, headers: { cookie: actor.cookie } }, options);
});

export const lastResponse = Effect.gen(function* () {
  const { last } = yield* World;
  const found = yield* Ref.get(last);
  if (found === undefined) return yield* Effect.die(new Error("no request has been made yet"));
  return found;
});

// ---- compact tokens, read the way a downstream service would ----------------------------

const decodeSegment = (segment: string | undefined): Readonly<Record<string, unknown>> => {
  if (segment === undefined) throw new Error("not a compact JWS");
  const decoded = parseJson(Buffer.from(segment, "base64url").toString("utf8"));
  if (!isRecord(decoded)) throw new Error("a JWS segment is not a JSON object");
  return decoded;
};

export const headerOf = (token: string) => decodeSegment(token.split(".")[0]);
export const claimsOf = (token: string) => decodeSegment(token.split(".")[1]);

const encodeSegment = (value: unknown) =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

/** The token with one header member replaced — the signature no longer matches, and that is the point. */
export const withHeader = (token: string, member: string, value: unknown) => {
  const [, payload, signature] = token.split(".");
  return `${encodeSegment({ ...headerOf(token), [member]: value })}.${payload}.${signature}`;
};

export const withPayload = (token: string, member: string, value: unknown) => {
  const [header, , signature] = token.split(".");
  return `${header}.${encodeSegment({ ...claimsOf(token), [member]: value })}.${signature}`;
};

export const withFlippedSignature = (token: string) => {
  const [header, payload, signature] = token.split(".");
  if (signature === undefined) throw new Error("not a compact JWS");
  const flipped = Buffer.from(signature, "base64url");
  flipped[0] = (flipped[0] ?? 0) ^ 0xff;
  return `${header}.${payload}.${flipped.toString("base64url")}`;
};

/** A defect a signed-by-the-real-key token can carry; each is refused by strict verification. */
export type Defect =
  | "none"
  | "expired"
  | "from another issuer"
  | "for another audience"
  | "of an unexpected class"
  | "not valid yet";

export const isDefect = (value: string): value is Defect =>
  value === "none" ||
  value === "expired" ||
  value === "from another issuer" ||
  value === "for another audience" ||
  value === "of an unexpected class" ||
  value === "not valid yet";

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Signs `claims` with the issuer's real current key, header `typ` as given. */
export const signWithCurrentKey = Effect.fn("features.jwt.signWithCurrentKey")(function* (
  typ: string,
  claims: Readonly<Record<string, unknown>>,
) {
  const app = yield* currentApp;
  return yield* Effect.promise(() =>
    app.withContext(
      Effect.gen(function* () {
        const key = yield* KeyRing.current;
        const material = yield* Option.match(key.privateKeyJwk, {
          onSome: (redacted) => Effect.succeed(Redacted.value(redacted)),
          onNone: () => Effect.die(new Error("the current signing key has no local private key")),
        });
        const iat = nowSeconds();
        return yield* JwtCodec.sign({
          kid: key.kid,
          alg: key.alg,
          typ,
          signer: JwtCodec.localSigner(material),
          claims: { iss: ISSUER, aud: ISSUER, sub: "user-forged", iat, exp: iat + 900, ...claims },
        }).pipe(Effect.orDie);
      }),
    ),
  );
});

export const forgeDefective = Effect.fn("features.jwt.forgeDefective")(function* (defect: Defect) {
  const iat = nowSeconds();
  switch (defect) {
    // The control: signed exactly like the defective ones, minus the defect, so a rejection
    // below is about the defect and not about how the test forged the token.
    case "none":
      return yield* signWithCurrentKey("at+jwt", {});
    case "expired":
      return yield* signWithCurrentKey("at+jwt", { iat: iat - 7200, exp: iat - 3600 });
    case "from another issuer":
      return yield* signWithCurrentKey("at+jwt", { iss: "https://someone-else.test" });
    case "for another audience":
      return yield* signWithCurrentKey("at+jwt", { aud: "https://another-api.test" });
    case "of an unexpected class":
      return yield* signWithCurrentKey("application/octet-stream", {});
    case "not valid yet":
      return yield* signWithCurrentKey("at+jwt", { nbf: iat + 3600 });
  }
});

/** A token signed by a genuine key pair the issuer never published in its JWKS. */
export const signWithUnpublishedKey = Effect.fn("features.jwt.signWithUnpublishedKey")(
  function* () {
    const { privateKeyJwk } = yield* JwtCodec.generateKeyJwks("EdDSA", {
      rsaModulusLength: 2048,
    }).pipe(Effect.orDie);
    const iat = nowSeconds();
    return yield* JwtCodec.sign({
      kid: "kid-the-issuer-never-published",
      alg: "EdDSA",
      typ: "at+jwt",
      signer: JwtCodec.localSigner(privateKeyJwk),
      claims: { iss: ISSUER, aud: ISSUER, sub: "user-forged", iat, exp: iat + 900 },
    }).pipe(Effect.orDie);
  },
);

// ---- the downstream verifier ------------------------------------------------------------

/** An HTTP client whose transport is the API's own handler, so `Verify.makeVerifier` fetches the real JWKS in-process. */
export const inProcessHttpClient = Effect.fn("features.jwt.inProcessHttpClient")(function* () {
  const world = yield* World;
  const { handler } = yield* currentApp;
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        yield* Ref.update(world.jwksFetches, (count) => count + 1);
        const response = yield* Effect.promise(() => handler(new Request(request.url)));
        return HttpClientResponse.fromWeb(request, response);
      }),
    ),
  );
});
