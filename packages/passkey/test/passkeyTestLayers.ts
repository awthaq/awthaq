// Shared domain-level composition for the plugin's own test files: real,
// in-memory `Users`/`Accounts`/`Sessions`/`AuthEvents`/`ChallengeStore`/
// `PasskeyCredentials`, with only the `WebAuthn` port swapped per test.
import { Auth, Sessions, Users } from "@awthaq/core";
import type { WebAuthn } from "@awthaq/ports";
import { TestAuth } from "@awthaq/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Passkey from "../src/Passkey.ts";
import { ORIGIN, RP_ID, registrationPayload } from "./passkeyTestFixtures.ts";

const built = Auth.make([Passkey.Passkey]);

/** The plugin through `TestAuth.layer(Auth.make([Passkey]))`, with only the `WebAuthn` port swapped per test. */
export const buildLayer = (
  webAuthn: Layer.Layer<WebAuthn.WebAuthn>,
  configOverrides?: Partial<Passkey.PasskeyConfigShape>,
  options?: {
    /** `"enforcing"` is the real limiter over the in-memory store, for a rate-limit test. */
    readonly rateLimiter?: "permissive" | "enforcing";
    /** Wraps a core service the plugin captures at construction (for example to simulate a store outage). */
    readonly coreOverride?: Layer.Layer<Sessions.Sessions, never, Sessions.Sessions>;
  },
) =>
  TestAuth.layer(built, {
    services: Layer.mergeAll(
      webAuthn,
      Passkey.config({ rpId: RP_ID, origins: [ORIGIN], ...configOverrides }),
    ),
    ...(options?.rateLimiter === undefined ? {} : { rateLimiter: options.rateLimiter }),
    ...(options?.coreOverride === undefined ? {} : { decorate: options.coreOverride }),
  });

/** Creates a user, issues a session, and registers `cred-mock-1` for that user — the shared setup every credential-management/authentication test starts from. */
export const registerNewUser = (email: string, credentialId = "cred-mock-1") =>
  Effect.gen(function* () {
    const passkey = yield* Passkey.Passkey;
    const users = yield* Users.Users;
    const sessions = yield* Sessions.Sessions;
    const user = yield* users.create({ identity: { _tag: "Email", email }, name: email });
    const issued = yield* sessions.issue({ userId: user.id });
    const options = yield* passkey.registerOptions(user.id, issued.session.id);
    yield* passkey.registerVerify(
      user.id,
      issued.session.id,
      registrationPayload({ options, id: credentialId }),
    );
    return { userId: user.id, sessionId: issued.session.id };
  });
