// Shipping-gap map (.scratch/shipping-gaps), ticket 25: the same real wire
// seam `packages/passkey/test/AuthHttp.test.ts` establishes — a real
// `HttpRouter.toWebHandler` app over real in-memory `Users`/`Accounts`/
// `Sessions`/`AuthEvents`/`ChallengeStore`/`PasskeyCredentials`, with only
// the `WebAuthn` port mocked (BEH-EA-195: this plugin's own wire contract
// is what's under test, not WebAuthn cryptography — that's
// `packages/ports/test/WebAuthn.test.ts`'s own job, and the real
// `WebAuthn.layerSimpleWebAuthn` composition is proven there too).
//
// Passkey registration always requires an existing session (no
// passkey-first sign-up), so this World's `signIn` issues a session
// directly against `Sessions` through the same shared `MemoMap` the app's
// own handler resolves against — the identical technique
// `AuthHttp.test.ts`'s own `issueSessionCookieHeader` uses.
import { AuthEvents, Accounts, Sessions, Users } from "@effect-auth/core";
import { WebAuthn } from "@effect-auth/ports";
import { Authentication, AuthHttp } from "@effect-auth/server";
import { Passkey, PasskeyApi, ChallengeStore, PasskeyCredentials } from "@effect-auth/passkey";
import { NodeCrypto } from "@effect/platform-node";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

export const RP_ID = "example.com";
export const ORIGIN = "https://example.com";

export const buildClientDataJSON = (input: {
  readonly type: "webauthn.create" | "webauthn.get";
  readonly challenge: string;
  readonly origin: string;
}): string =>
  Encoding.encodeBase64Url(
    JSON.stringify({ type: input.type, challenge: input.challenge, origin: input.origin }),
  );

const OptionsChallengeSchema = Schema.Struct({ challenge: Schema.String });

export const extractChallenge = (options: unknown): string => {
  const decoded = Schema.decodeUnknownOption(OptionsChallengeSchema)(options);
  if (Option.isNone(decoded)) throw new Error("expected mocked options to carry a challenge");
  return decoded.value.challenge;
};

export interface MockWebAuthnOverrides {
  readonly registrationVerified?: Partial<WebAuthn.VerifiedRegistration>;
  readonly authenticationVerified?: Partial<WebAuthn.VerifiedAuthentication>;
  readonly failVerifyRegistration?: boolean;
  readonly failVerifyAuthentication?: boolean;
}

/**
 * Reads its behavior from a live `Ref` on every call (not a value baked in
 * once at Layer-build time) — `overrideWebAuthnBehavior` below lets a step
 * flip e.g. `failVerifyRegistration` mid-Scenario, for a scenario like
 * REQ-EA-359 whose own Given text is identical to REQ-EA-358's (both
 * "a registration ceremony's challenge issued by...") and only the later
 * When step ("...and WebAuthn.verifyRegistration fails") distinguishes the
 * two — rebuilding the whole app to change this would discard the session
 * and challenge the shared Given already issued.
 */
const mockWebAuthn = (behavior: Ref.Ref<MockWebAuthnOverrides>): Layer.Layer<WebAuthn.WebAuthn> =>
  Layer.mock(WebAuthn.WebAuthn, {
    registrationOptions: (input) =>
      Effect.succeed({
        rp: { id: input.rpId, name: input.rpName },
        user: { id: input.userId, name: input.userName, displayName: input.userDisplayName },
        challenge: input.challenge,
        pubKeyCredParams: [],
        ...(input.attestation === undefined ? {} : { attestation: input.attestation }),
      }),
    verifyRegistration: (input) =>
      Effect.gen(function* () {
        const overrides = yield* Ref.get(behavior);
        if (overrides.failVerifyRegistration === true) {
          return yield* Effect.fail(
            new WebAuthn.PasskeyVerificationFailed({ message: "mocked verification failure" }),
          );
        }
        return {
          // Echoes the client-submitted credential id back through
          // (rather than a single hardcoded value) so two registration
          // ceremonies in the same scenario against different credential
          // ids don't collide on `PasskeyCredentials`' id-keyed store.
          credentialId: input.response.id,
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          aaguid: "00000000-0000-0000-0000-000000000000",
          transports: [],
          credentialDeviceType: "singleDevice" as const,
          credentialBackedUp: false,
          userVerified: true,
          ...overrides.registrationVerified,
        };
      }),
    authenticationOptions: (input) => Effect.succeed({ challenge: input.challenge }),
    verifyAuthentication: () =>
      Effect.gen(function* () {
        const overrides = yield* Ref.get(behavior);
        if (overrides.failVerifyAuthentication === true) {
          return yield* Effect.fail(
            new WebAuthn.PasskeyVerificationFailed({ message: "mocked verification failure" }),
          );
        }
        return {
          credentialId: "cred-mock-1",
          newCounter: 1,
          credentialDeviceType: "singleDevice" as const,
          credentialBackedUp: false,
          userVerified: true,
          ...overrides.authenticationVerified,
        };
      }),
  });

const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

const CoreLive = Layer.mergeAll(Users.layerMemory, Accounts.layerMemory, Sessions.layerMemory).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

export interface AppOptions {
  readonly rpId?: string;
  readonly origins?: ReadonlyArray<string>;
  readonly attestation?: WebAuthn.AttestationConveyance;
  readonly conditionalCreate?: boolean;
  readonly webAuthn?: MockWebAuthnOverrides;
}

const buildAppLayer = (options: AppOptions, webAuthnBehavior: Ref.Ref<MockWebAuthnOverrides>) =>
  Layer.mergeAll(
    AuthHttp.routes(PasskeyApi.PasskeyApi, { openapiPath: "/openapi.json" }).pipe(
      Layer.provide(Passkey.Passkey.layer),
      Layer.provide(
        Passkey.config({
          rpId: options.rpId ?? RP_ID,
          origins: options.origins ?? [ORIGIN],
          ...(options.attestation === undefined ? {} : { attestation: options.attestation }),
          ...(options.conditionalCreate === undefined
            ? {}
            : { conditionalCreate: options.conditionalCreate }),
        }),
      ),
      Layer.provide(AuthenticationLive),
    ),
    AuthHttp.docs(PasskeyApi.PasskeyApi),
  ).pipe(
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(
      Layer.mergeAll(
        mockWebAuthn(webAuthnBehavior),
        ChallengeStore.layerMemory,
        PasskeyCredentials.layerMemory,
      ).pipe(Layer.provideMerge(NodeCrypto.layer)),
    ),
    Layer.provideMerge(TestServices),
    Layer.provideMerge(HttpRouter.layer),
  );

export interface AppHandle {
  readonly handler: (request: Request) => Promise<Response>;
  readonly memoMap: Layer.MemoMap;
  readonly appLayer: ReturnType<typeof buildAppLayer>;
  readonly webAuthnBehavior: Ref.Ref<MockWebAuthnOverrides>;
}

export interface WorldShape {
  readonly app: Ref.Ref<AppHandle | undefined>;
  readonly appOptions: Ref.Ref<AppOptions>;
  readonly lastResponse: Ref.Ref<Response | undefined>;
  readonly outcomes: Ref.Ref<Record<string, unknown>>;
}

export class World extends Context.Service<World, WorldShape>()("features/PasskeyWorld") {}

export const WorldLive = Layer.effect(
  World,
  Effect.gen(function* () {
    return World.of({
      app: yield* Ref.make<AppHandle | undefined>(undefined),
      appOptions: yield* Ref.make<AppOptions>({}),
      lastResponse: yield* Ref.make<Response | undefined>(undefined),
      outcomes: yield* Ref.make<Record<string, unknown>>({}),
    });
  }),
);

/** Merges (not replaces) — the same `PasswordWorld.configureApp` pattern, so two Given steps compose. */
export const configureApp = Effect.fn("features.passkey.configureApp")(function* (
  options: AppOptions,
) {
  const world = yield* World;
  const merged = { ...(yield* Ref.get(world.appOptions)), ...options };
  yield* Ref.set(world.appOptions, merged);
  const webAuthnBehavior = Ref.makeUnsafe<MockWebAuthnOverrides>(merged.webAuthn ?? {});
  const appLayer = buildAppLayer(merged, webAuthnBehavior);
  const memoMap = Layer.makeMemoMapUnsafe();
  const { handler } = HttpRouter.toWebHandler(appLayer, { memoMap });
  yield* Ref.set(world.app, { handler, memoMap, appLayer, webAuthnBehavior });
});

/**
 * Flips the running app's mocked `WebAuthn` behavior in place — without
 * rebuilding the app (which would discard any session/challenge state a
 * prior `signIn`/`register/options` call already created). Use this
 * instead of `configureApp({ webAuthn: ... })` once a session already
 * exists this Scenario.
 */
export const overrideWebAuthnBehavior = Effect.fn("features.passkey.overrideWebAuthnBehavior")(
  function* (overrides: MockWebAuthnOverrides) {
    const { webAuthnBehavior } = yield* appHandle();
    yield* Ref.set(webAuthnBehavior, overrides);
  },
);

const appHandle = Effect.fn("features.passkey.appHandle")(function* () {
  const world = yield* World;
  const found = yield* Ref.get(world.app);
  if (found === undefined) yield* configureApp({});
  return (yield* Ref.get(world.app))!;
});

export const request = Effect.fn("features.passkey.request")(function* (
  method: string,
  path: string,
  options?: { readonly body?: unknown; readonly headers?: Record<string, string> },
) {
  const { handler } = yield* appHandle();
  const response = yield* Effect.promise(() =>
    handler(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: {
          ...(options?.body === undefined ? {} : { "content-type": "application/json" }),
          ...options?.headers,
        },
        ...(options?.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }),
    ),
  );
  const world = yield* World;
  yield* Ref.set(world.lastResponse, response);
  return response;
});

export const cookieFrom = (response: Response): string => {
  const raw = response.headers.get("set-cookie");
  if (raw === null) throw new Error("expected a set-cookie header");
  return raw.split(";")[0] ?? raw;
};

/**
 * Issues a real session directly against `Sessions`, reaching into the
 * same running services `handler` uses via the shared `MemoMap` — the
 * identical technique `AuthHttp.test.ts`'s own `issueSessionCookieHeader`
 * uses, including its `Effect.runPromise` (not `yield*`) boundary. That
 * boundary is load-bearing, not stylistic: `HttpRouter.toWebHandler`'s own
 * per-request execution (`HttpEffect.toWebHandlerWith`'s own
 * `Effect.runForkWith`, a plain JS function call boundary) always runs on
 * the real global runtime — real `Clock`, never whatever ambient
 * `TestClock` a `@effect-cucumber/vitest` step happens to be running
 * under. Composing this via a bare `yield*` instead (an earlier draft of
 * this World did) lets `Sessions.issue` inherit the *caller's* ambient
 * `TestClock` — frozen at epoch 0 — so the session's own
 * `absoluteExpiresAt`/`idleExpiresAt` land in January 1970, while the
 * later real HTTP request validating that same cookie runs under real
 * wall-clock time: every session looks expired, and every authenticated
 * request answers 401 `Unauthenticated`. This was a real, reproduced bug
 * (not a hypothetical), root-caused by directly comparing a working
 * `Sessions.issue`/`verify` round trip under `it.effect`'s ambient
 * `TestClock` (fine, self-consistent) against the same round trip through
 * a real HTTP request (401) before finding the clock mismatch. Routing
 * through `Effect.runPromise` keeps this bootstrap on the same real clock
 * `handler` itself is always on, regardless of what `TestClock` state the
 * calling step (e.g. REQ-EA-367's own `TestClock.adjust`) is in.
 */
export const signIn = Effect.fn("features.passkey.signIn")(function* (email: string) {
  const { appLayer, memoMap } = yield* appHandle();
  return yield* Effect.promise(() =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.scope;
          const context = yield* Layer.buildWithMemoMap(appLayer, memoMap, scope);
          return yield* Effect.gen(function* () {
            const users = yield* Users.Users;
            const sessions = yield* Sessions.Sessions;
            const user = yield* users.create({ email, name: email });
            const issued = yield* sessions.issue({ userId: user.id });
            return `__Host-session=${encodeURIComponent(Redacted.value(issued.token))}`;
          }).pipe(Effect.provide(context));
        }),
      ),
    ),
  );
});

/**
 * Links an extra `Accounts` row directly (domain-level) — used to give a
 * user a non-passkey credential (password/OAuth) without wiring those
 * whole plugins. Routed through `Effect.runPromise` for the same reason
 * `signIn` above is — see its own comment.
 */
export const linkOtherAccount = Effect.fn("features.passkey.linkOtherAccount")(function* (
  email: string,
  providerId: string,
) {
  const { appLayer, memoMap } = yield* appHandle();
  yield* Effect.promise(() =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.scope;
          const context = yield* Layer.buildWithMemoMap(appLayer, memoMap, scope);
          return yield* Effect.gen(function* () {
            const users = yield* Users.Users;
            const accounts = yield* Accounts.Accounts;
            const userOpt = yield* users.findByEmail(email);
            if (Option.isNone(userOpt)) throw new Error(`no user found for ${email}`);
            yield* accounts.link({
              userId: userOpt.value.id,
              providerId,
              subject: `${providerId}-subject-${email}`,
            });
          }).pipe(Effect.provide(context));
        }),
      ),
    ),
  );
});

export const setOutcome = Effect.fn("features.passkey.setOutcome")(function* (
  key: string,
  value: unknown,
) {
  const { outcomes } = yield* World;
  yield* Ref.update(outcomes, (existing) => ({ ...existing, [key]: value }));
});

export const getOutcome = Effect.fn("features.passkey.getOutcome")(function* (key: string) {
  const { outcomes } = yield* World;
  const found = (yield* Ref.get(outcomes))[key];
  if (found === undefined) throw new Error(`no outcome recorded for "${key}"`);
  return found;
});

export const getLastResponse = Effect.fn("features.passkey.getLastResponse")(function* () {
  const { lastResponse } = yield* World;
  const found = yield* Ref.get(lastResponse);
  if (found === undefined) throw new Error("no response recorded yet — call request() first");
  return found;
});
