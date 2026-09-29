// Shared domain-level composition for the plugin's own test files: real,
// in-memory `Users`/`Accounts`/`Sessions`/`AuthEvents`/`ChallengeStore`/
// `PasskeyCredentials`, with only the `WebAuthn` port swapped per test.
import { AuditLog, Hooks, AuthEvents, Accounts, RateLimits, Sessions, Users } from "@awthaq/core";
import { ClientAddress, RateLimiter, WebAuthn } from "@awthaq/ports";
import { Authentication, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as ChallengeStore from "../src/ChallengeStore.ts";
import * as Passkey from "../src/Passkey.ts";
import * as PasskeyCredentials from "../src/PasskeyCredentials.ts";
import * as PasskeyUserHandles from "../src/PasskeyUserHandles.ts";
import { ORIGIN, RP_ID, registrationPayload, extractChallenge } from "./passkeyTestFixtures.ts";

/** A limiter that never rejects (the default), or a real one over the in-memory store for a rate-limit test. */
export const realRateLimiter = RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory));

export const makeCoreLive = (
  rateLimiter: Layer.Layer<RateLimiter.RateLimiter> = RateLimiter.layerPermissive,
) =>
  Layer.mergeAll(Users.layerMemory, Accounts.layerMemory, Sessions.layerMemory).pipe(
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layerMemory),
    Layer.provideMerge(Hooks.HooksLive),
    Layer.provideMerge(RateLimits.layer),
    Layer.provideMerge(rateLimiter),
    Layer.provideMerge(NodeCrypto.layer),
  );

export const CoreLive = makeCoreLive();

/**
 * The `passkey`/`passkey.credentials` groups declare `.middleware(Api.Authentication)`
 * (`PasskeyApi.ts`) — merged into `Passkey.Passkey.layer` regardless of
 * whether a test ever dispatches real HTTP, so this domain-level suite
 * still has to satisfy it, the same way `AuthHttp.test.ts` would.
 */
export const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

/**
 * CSS-001/CDS-001/APS-001/NHS-001/PIL-001/TMS-001: the passkey groups also
 * carry `.middleware(Api.CsrfProtection)` — merged into `Passkey.Passkey.layer`
 * regardless of whether a test ever dispatches real HTTP.
 */
export const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make("passkey-domain-test-csrf-secret"),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

export const PortsLive = (
  webAuthn: Layer.Layer<WebAuthn.WebAuthn>,
  challengeStore: Layer.Layer<
    ChallengeStore.ChallengeStore,
    never,
    Crypto.Crypto
  > = ChallengeStore.layerMemory,
) =>
  Layer.mergeAll(
    webAuthn,
    challengeStore,
    PasskeyCredentials.layerMemory,
    PasskeyUserHandles.layerMemory,
    ClientAddress.layerDirect,
  ).pipe(Layer.provideMerge(NodeCrypto.layer));

export const buildLayer = (
  webAuthn: Layer.Layer<WebAuthn.WebAuthn>,
  configOverrides?: Partial<Passkey.PasskeyConfigShape>,
  options?: {
    readonly challengeStore?: Layer.Layer<ChallengeStore.ChallengeStore, never, Crypto.Crypto>;
    readonly rateLimiter?: Layer.Layer<RateLimiter.RateLimiter>;
  },
) =>
  Passkey.Passkey.layer.pipe(
    Layer.provide(Passkey.config({ rpId: RP_ID, origins: [ORIGIN], ...configOverrides })),
    Layer.provide(AuthenticationLive),
    Layer.provide(CsrfProtectionLive),
    Layer.provideMerge(makeCoreLive(options?.rateLimiter)),
    Layer.provideMerge(PortsLive(webAuthn, options?.challengeStore)),
  );

/** Creates a user, issues a session, and registers `cred-mock-1` for that user — the shared setup every credential-management/authentication test starts from. */
export const registerNewUser = (email: string, credentialId = "cred-mock-1") =>
  Effect.gen(function* () {
    const passkey = yield* Passkey.Passkey;
    const users = yield* Users.Users;
    const sessions = yield* Sessions.Sessions;
    const user = yield* users.create({ email, name: email });
    const issued = yield* sessions.issue({ userId: user.id });
    const options = yield* passkey.registerOptions(user.id, issued.session.id);
    yield* passkey.registerVerify(
      user.id,
      issued.session.id,
      registrationPayload({ options, id: credentialId }),
    );
    return { userId: user.id, sessionId: issued.session.id };
  });

export { extractChallenge };
