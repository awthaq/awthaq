// @awthaq/cli — Session
//
// spec/behaviors/26-cli.md BEH-EA-227 (CTA-001, CTA-002, DAG-002, CTA-005; decision 06): `login`,
// `logout` and `whoami` — the one command family that is an *outbound client of a running auth
// server*. It never starts a listener and never accepts an inbound request (BEH-EA-208, class 3: no
// CLI-hosted redirect callback, no loopback server), which is exactly why the device flow, not a
// browser redirect, is the interactive path.
//
// Transport is `@awthaq/client`'s generated `HttpApiClient` over the core `session` group (and the
// `subject` group for `whoami`), not the React/atom surface: `AuthClient.bearerTransformClient` attaches
// `Authorization: Bearer <token>` and captures a *rotated* token from any response (BEH-EA-052 —
// the replaced secret survives only `SessionConfig.rotationGrace`, so a missed rotation logs the user out once that passes), which this module persists.
//
// - `login --token <t>` (or `AWTHAQ_TOKEN`) is the non-interactive path CI needs from day one. The token
//   is validated against `GET /session` and stored only when the server accepts it; a rejected token
//   stores nothing. Prefer `AWTHAQ_TOKEN` to `--token`: argv is visible to a process listing.
// - Interactive `login` is the device authorization grant (RFC 8628), which needs the
//   `DeviceAuthorization` plugin (spec/models/13-device-authorization.md) — not built yet — so it fails
//   with `DeviceAuthorizationUnavailable` naming that requirement instead of guessing at endpoints
//   that do not exist. The credential store, transport and commands are ready for it.
// - `logout` clears the local credential and revokes the session server-side on a best-effort basis
//   (`POST /session/sign-out`); a server that cannot be reached does not stop the local logout.
// - `whoami` prints who the stored (or `AWTHAQ_TOKEN`) credential resolves to: the session, and the
//   authorization subject when the server exposes `/subject`. No credential, or a rejected one, is
//   `AuthenticationRequired` (exit 8).
//
// Nothing here prints the token.

import { SessionContract, SubjectContract } from "@awthaq/api";
import { AuthClient } from "@awthaq/client";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import {
  AuthenticationRequired,
  DeviceAuthorizationUnavailable,
  ServerUnavailable,
  UsageError,
} from "./CliErrors.ts";
import type { Credential } from "./CredentialStore.ts";
import { CredentialStore } from "./CredentialStore.ts";
import * as Output from "./Output.ts";

const sessionApi = HttpApi.make("auth").add(SessionContract.SessionGroup);
const subjectApi = HttpApi.make("auth").add(SubjectContract.SubjectGroup);

/** BEH-EA-226: `--base-url` decodes as an http(s) URL before anything is contacted. */
export const BaseUrl = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) =>
      URL.canParse(value) && /^https?:\/\//.test(value)
        ? undefined
        : "an http(s) URL of the auth server",
    ),
  ),
);

/** The client's bearer store, backed by the credential: a rotated token is persisted, not just remembered. */
const bearerFor = Effect.fnUntraced(function* (credential: Credential) {
  const store = yield* CredentialStore;
  const current = yield* Ref.make(Option.some(credential.token));
  const shape: AuthClient.BearerTokenStoreShape = {
    get: Ref.get(current),
    set: (token) =>
      Ref.set(current, Option.some(token)).pipe(
        Effect.andThen(store.set({ baseUrl: credential.baseUrl, token }).pipe(Effect.ignore)),
      ),
    clear: Ref.set(current, Option.none()),
  };
  return shape;
});

const unreachable = (baseUrl: string) => () =>
  new ServerUnavailable({ message: `could not reach the auth server at ${baseUrl}` });

const unauthenticated = (message: string) => () => new AuthenticationRequired({ message });

/** Asks the server who the credential is: `GET /session`. `Unauthenticated` -> exit 8, a network failure -> exit 9. */
const currentSession = Effect.fnUntraced(function* (credential: Credential) {
  const bearer = yield* bearerFor(credential);
  const client = yield* AuthClient.make(sessionApi, {
    baseUrl: credential.baseUrl,
    transformClient: AuthClient.bearerTransformClient(bearer),
  }).pipe(Effect.provide(AuthClient.CsrfClientLive));
  return yield* client.session.current().pipe(
    Effect.catchTag(
      "Unauthenticated",
      unauthenticated(
        "the server rejected the token (expired, revoked or wrong server); run `awthaq login` again",
      ),
    ),
    Effect.mapError((error) =>
      error._tag === "AuthenticationRequired" ? error : unreachable(credential.baseUrl)(),
    ),
  );
});

/** The authorization subject, when the server serves `/subject` (the qadi bridge); absent otherwise. */
const currentSubject = Effect.fnUntraced(function* (credential: Credential) {
  const bearer = yield* bearerFor(credential);
  const client = yield* AuthClient.make(subjectApi, {
    baseUrl: credential.baseUrl,
    transformClient: AuthClient.bearerTransformClient(bearer),
  }).pipe(Effect.provide(AuthClient.CsrfClientLive));
  return yield* client.subject.current().pipe(
    Effect.map(Option.some),
    Effect.orElseSucceed(() => Option.none<SubjectContract.SubjectDto>()),
  );
});

export interface LoginInput {
  /** `--token`, or `AWTHAQ_TOKEN` through the flag's fallback. */
  readonly token: Option.Option<Redacted.Redacted<string>>;
  /** `--base-url`, or `AWTHAQ_BASE_URL` through the flag's fallback. */
  readonly baseUrl: Option.Option<string>;
}

/** BEH-EA-227: validates a token against the server and stores it only when the server accepts it. */
export const login = (input: LoginInput) =>
  Effect.gen(function* () {
    const store = yield* CredentialStore;
    const stored = yield* store.get;
    const baseUrl = Option.orElse(input.baseUrl, () =>
      Option.map(stored, (credential) => credential.baseUrl).pipe(
        Option.filter((url) => url !== ""),
      ),
    );
    if (Option.isNone(baseUrl)) {
      return yield* new UsageError({
        message: "the auth server is unknown: pass --base-url (or set AWTHAQ_BASE_URL)",
      });
    }
    if (Option.isNone(input.token)) {
      return yield* new DeviceAuthorizationUnavailable({
        message:
          "interactive login uses the device authorization grant, which needs the DeviceAuthorization plugin (spec/models/13-device-authorization.md); it is not available yet. Pass --token or set AWTHAQ_TOKEN.",
      });
    }
    const credential: Credential = { baseUrl: baseUrl.value, token: input.token.value };
    const session = yield* currentSession(credential);
    yield* store.set(credential);
    const result = {
      baseUrl: credential.baseUrl,
      sessionId: session.id,
      expiresAt: session.expiresAt,
      store: store.backend,
    };
    yield* Output.report(result, (value) => [
      `logged in to ${value.baseUrl} (session ${value.sessionId}, expires ${value.expiresAt}; credential kept in: ${value.store})`,
    ]);
  });

/** BEH-EA-227: clears the local credential and revokes the session server-side, best effort. */
export const logout = Effect.gen(function* () {
  const store = yield* CredentialStore;
  const out = yield* Output.Output;
  const credential = yield* store.get;
  if (Option.isSome(credential)) {
    const revoked = yield* Effect.gen(function* () {
      const bearer = yield* bearerFor(credential.value);
      const client = yield* AuthClient.make(sessionApi, {
        baseUrl: credential.value.baseUrl,
        transformClient: AuthClient.bearerTransformClient(bearer),
      }).pipe(Effect.provide(AuthClient.CsrfClientLive));
      yield* client.session.signOut();
      return true;
    }).pipe(Effect.orElseSucceed(() => false));
    if (!revoked) {
      yield* out.warn(
        "awthaq: could not revoke the session on the server; the local credential is cleared anyway",
      );
    }
  }
  yield* store.clear;
  yield* Output.report({ loggedOut: Option.isSome(credential) }, (value) => [
    value.loggedOut ? "logged out" : "not logged in",
  ]);
});

/** BEH-EA-227: who the stored credential resolves to; `AuthenticationRequired` (exit 8) when there is none or it is rejected. */
export const whoami = Effect.gen(function* () {
  const store = yield* CredentialStore;
  const found = yield* store.get;
  if (Option.isNone(found) || found.value.baseUrl === "") {
    return yield* new AuthenticationRequired({
      message:
        "not logged in: run `awthaq login --token …` (or set AWTHAQ_TOKEN and AWTHAQ_BASE_URL)",
    });
  }
  const credential = found.value;
  const session = yield* currentSession(credential);
  const subject = yield* currentSubject(credential);
  const result = {
    baseUrl: credential.baseUrl,
    sessionId: session.id,
    expiresAt: session.expiresAt,
    subject: Option.match(subject, {
      onNone: () => undefined,
      onSome: (dto) => ({ id: dto.id, roles: dto.roles, permissions: dto.permissions }),
    }),
  };
  yield* Output.report(result, (value) => [
    ...(value.subject === undefined
      ? []
      : [`subject:  ${value.subject.id}`, `roles:    ${value.subject.roles.join(", ") || "-"}`]),
    `session:  ${value.sessionId} (expires ${value.expiresAt})`,
    `server:   ${value.baseUrl}`,
  ]);
});
