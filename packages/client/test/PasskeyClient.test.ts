// BPAS-002 (.issues/high) / wayfinder ticket 32
// (browser-webauthn-ux-layer): `passkeyClient` exercised against a real
// `HttpApiClient.make(PasskeyApi.PasskeyApi)` (the same generated client an
// app would build, `CsrfClientLive` provided the way `AuthClient.test.ts`'s
// own header comment documents), talking to a fake `HttpClient` — the same
// "fake only the external non-Effect boundary, keep everything else real"
// discipline `packages/oauth/test/OAuth.test.ts`'s own `fakeHttpClient`
// already establishes. `@simplewebauthn/browser` is real and unmocked too;
// only the actual browser platform boundary it calls into
// (`navigator.credentials.create`/`.get`, the global `PublicKeyCredential`
// constructor, `document` for the autofill path) is faked, since none of
// those exist in a Node test run.
import { SessionContract } from "@awthaq/api";
import { PasskeyApi } from "@awthaq/passkey";
import { afterEach, assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import * as AuthClient from "../src/AuthClient.ts";
import * as PasskeyClient from "../src/passkey/PasskeyClient.ts";

const b64url = (value: string): string => Buffer.from(value).toString("base64url");

const arrayBuffer = (value: string): ArrayBuffer => {
  const buffer = Buffer.from(value);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
};

// ---------------------------------------------------------------------------
// The real browser platform boundary @simplewebauthn/browser itself calls
// into — never present in a Node test run, installed/removed per test.
// ---------------------------------------------------------------------------

interface FakeCredential {
  readonly id: string;
  readonly rawId: ArrayBuffer;
  readonly type: "public-key";
  readonly response: Record<string, unknown>;
  readonly getClientExtensionResults: () => Record<string, never>;
}

const fakeRegistrationCredential = (id: string): FakeCredential => ({
  id,
  rawId: arrayBuffer(id),
  type: "public-key",
  response: {
    clientDataJSON: arrayBuffer("client-data"),
    attestationObject: arrayBuffer("attestation-object"),
  },
  getClientExtensionResults: () => ({}),
});

const fakeAuthenticationCredential = (id: string): FakeCredential => ({
  id,
  rawId: arrayBuffer(id),
  type: "public-key",
  response: {
    clientDataJSON: arrayBuffer("client-data"),
    authenticatorData: arrayBuffer("authenticator-data"),
    signature: arrayBuffer("signature"),
  },
  getClientExtensionResults: () => ({}),
});

// Modern Node ships a real, read-only (getter-only, no setter) global
// `navigator` — `Reflect.set` on it silently no-ops rather than throwing,
// so it has to be deleted first (it's still configurable) before a plain
// writable stand-in can take its place. The original descriptor is
// restored in `afterEach` so this file's faking never leaks to other test
// files sharing the same worker process.
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

const installPlatform = (options: {
  readonly create?: (options: unknown) => Promise<FakeCredential>;
  readonly get?: (options: unknown) => Promise<FakeCredential>;
}): void => {
  class FakePublicKeyCredential {}
  Reflect.set(globalThis, "PublicKeyCredential", FakePublicKeyCredential);
  Reflect.deleteProperty(globalThis, "navigator");
  Reflect.set(globalThis, "navigator", {
    credentials: {
      create: options.create ?? (() => Promise.reject(new Error("create() not stubbed"))),
      get: options.get ?? (() => Promise.reject(new Error("get() not stubbed"))),
    },
  });
};

afterEach(() => {
  Reflect.deleteProperty(globalThis, "PublicKeyCredential");
  Reflect.deleteProperty(globalThis, "navigator");
  if (originalNavigatorDescriptor !== undefined) {
    Object.defineProperty(globalThis, "navigator", originalNavigatorDescriptor);
  }
  Reflect.deleteProperty(globalThis, "document");
});

// ---------------------------------------------------------------------------
// A fake HttpClient serving the real PasskeyApi contract — `passkeyClient`
// is handed the real `HttpApiClient.make` output, so every request it
// sends is genuinely encoded/decoded against `PasskeyApi.ts`'s own schemas,
// not a hand-typed stand-in.
// ---------------------------------------------------------------------------

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

interface RouteResponse {
  readonly status: number;
  readonly body?: unknown;
}

const requestBody = (request: HttpClientRequest.HttpClientRequest): unknown =>
  request.body._tag === "Uint8Array" && request.body.text !== undefined
    ? JSON.parse(request.body.text)
    : undefined;

const fakeHttpClient = (
  routes: Record<string, RouteResponse | undefined>,
  recorded: Array<RecordedRequest>,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const body = requestBody(request);
      const path = new URL(request.url).pathname;
      recorded.push({ method: request.method, path, body });
      const route = routes[`${request.method} ${path}`];
      const { status, body: responseBody } = route ?? {
        status: 404,
        body: { message: "no route stubbed" },
      };
      const webResponse =
        status === 204
          ? new Response(null, { status })
          : new Response(JSON.stringify(responseBody), { status });
      return Effect.succeed(HttpClientResponse.fromWeb(request, webResponse));
    }),
  );

const BASE_URL = "https://app.example.com";

const buildClient = (
  routes: Record<string, RouteResponse | undefined>,
  recorded: Array<RecordedRequest>,
): Effect.Effect<PasskeyClient.PasskeyApiClient> =>
  HttpApiClient.make(PasskeyApi.PasskeyApi, { baseUrl: BASE_URL }).pipe(
    Effect.provide(Layer.mergeAll(AuthClient.CsrfClientLive, fakeHttpClient(routes, recorded))),
  );

const creationOptionsJSON = {
  rp: { id: "example.com", name: "Example" },
  user: { id: b64url("user-1"), name: "user@example.com", displayName: "User" },
  challenge: b64url("creation-challenge"),
  pubKeyCredParams: [{ alg: -7, type: "public-key" }],
};

const requestOptionsJSON = {
  challenge: b64url("request-challenge"),
  allowCredentials: [],
};

const credentialDtoJSON = {
  id: "cred-1",
  name: "Passkey",
  deviceType: "singleDevice" as const,
  backedUp: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastUsedAt: "2026-01-01T00:00:00.000Z",
};

const sessionDtoJSON = {
  id: "session-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastActiveAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-02-01T00:00:00.000Z",
  userAgent: null,
  current: true,
};

// The real client decodes wire JSON into real `Schema.Class` instances, not
// plain objects — these are what `deepStrictEqual` compares a decoded
// result against, built from the same JSON these fake routes serve.
const credentialDto = new PasskeyApi.PasskeyCredentialDto(credentialDtoJSON);
const sessionDto = new SessionContract.SessionDto(sessionDtoJSON);

describe("PasskeyClient.passkeyClient — registerPasskey", () => {
  it.effect("happy path: converts the returned credential and calls registerVerify with it", () =>
    Effect.gen(function* () {
      installPlatform({ create: () => Promise.resolve(fakeRegistrationCredential("new-cred")) });
      const recorded: Array<RecordedRequest> = [];
      const rawClient = yield* buildClient(
        {
          "POST /passkey/register/options": { status: 200, body: creationOptionsJSON },
          "POST /passkey/register/verify": { status: 200, body: credentialDtoJSON },
        },
        recorded,
      );
      const client = PasskeyClient.passkeyClient(rawClient);
      const result = yield* client.registerPasskey();
      assert.deepStrictEqual(result, credentialDto);
      const verifyCall = recorded.find((r) => r.path === "/passkey/register/verify");
      assert.deepStrictEqual(verifyCall?.body, {
        credential: {
          id: "new-cred",
          rawId: b64url("new-cred"),
          response: {
            clientDataJSON: b64url("client-data"),
            attestationObject: b64url("attestation-object"),
          },
          type: "public-key",
        },
      });
    }),
  );

  it.effect(
    "no PublicKeyCredential global at all fails PasskeyNotSupported without ever calling registerOptions",
    () =>
      Effect.gen(function* () {
        const recorded: Array<RecordedRequest> = [];
        const rawClient = yield* buildClient({}, recorded);
        const client = PasskeyClient.passkeyClient(rawClient);
        const failure = yield* client.registerPasskey().pipe(Effect.flip);
        assert.strictEqual(failure._tag, "PasskeyNotSupported");
        assert.strictEqual(recorded.length, 0);
      }),
  );

  it.effect("a declined platform prompt (NotAllowedError) fails PasskeyUserCancelled", () =>
    Effect.gen(function* () {
      installPlatform({
        create: () => Promise.reject(new DOMException("declined", "NotAllowedError")),
      });
      const recorded: Array<RecordedRequest> = [];
      const rawClient = yield* buildClient(
        { "POST /passkey/register/options": { status: 200, body: creationOptionsJSON } },
        recorded,
      );
      const client = PasskeyClient.passkeyClient(rawClient);
      const failure = yield* client.registerPasskey().pipe(Effect.flip);
      assert.strictEqual(failure._tag, "PasskeyUserCancelled");
      // The ceremony never completed: registerVerify must never be reached.
      assert.isUndefined(recorded.find((r) => r.path === "/passkey/register/verify"));
    }),
  );

  it.effect(
    "a malformed registerOptions response (missing pubKeyCredParams) fails PasskeyCeremonyFailed without ever attempting the ceremony",
    () =>
      Effect.gen(function* () {
        let createCalls = 0;
        installPlatform({
          create: () => {
            createCalls++;
            return Promise.resolve(fakeRegistrationCredential("new-cred"));
          },
        });
        const recorded: Array<RecordedRequest> = [];
        const rawClient = yield* buildClient(
          {
            "POST /passkey/register/options": {
              status: 200,
              // `@simplewebauthn/browser`'s own `startRegistration` never
              // reads `pubKeyCredParams` directly (only spreads the whole
              // options object into `navigator.credentials.create`'s own
              // arguments) — so, unlike a missing `challenge`, a missing
              // `pubKeyCredParams` would NOT crash the library on its own;
              // this genuinely exercises `isCreationOptionsJSON`'s own
              // guard, not just downstream library behavior it happens to
              // share.
              body: {
                rp: creationOptionsJSON.rp,
                user: creationOptionsJSON.user,
                challenge: creationOptionsJSON.challenge,
              },
            },
          },
          recorded,
        );
        const client = PasskeyClient.passkeyClient(rawClient);
        const failure = yield* client.registerPasskey().pipe(Effect.flip);
        assert.strictEqual(failure._tag, "PasskeyCeremonyFailed");
        assert.strictEqual(createCalls, 0);
      }),
  );
});

describe("PasskeyClient.passkeyClient — registerPasskeyConditional (research/06:195 silent failure)", () => {
  it.effect("a ceremony failure resolves to void, never surfacing an error", () =>
    Effect.gen(function* () {
      installPlatform({
        create: () => Promise.reject(new DOMException("declined", "NotAllowedError")),
      });
      const recorded: Array<RecordedRequest> = [];
      const rawClient = yield* buildClient(
        {
          "POST /passkey/register/options/conditional": { status: 200, body: creationOptionsJSON },
        },
        recorded,
      );
      const client = PasskeyClient.passkeyClient(rawClient);
      // Would throw/reject if this leaked an error instead of resolving.
      yield* client.registerPasskeyConditional();
      assert.isDefined(recorded.find((r) => r.path === "/passkey/register/options/conditional"));
      assert.isUndefined(recorded.find((r) => r.path === "/passkey/register/verify"));
    }),
  );

  it.effect("a successful ceremony still calls registerVerify to persist the credential", () =>
    Effect.gen(function* () {
      installPlatform({
        create: () => Promise.resolve(fakeRegistrationCredential("conditional-cred")),
      });
      const recorded: Array<RecordedRequest> = [];
      const rawClient = yield* buildClient(
        {
          "POST /passkey/register/options/conditional": { status: 200, body: creationOptionsJSON },
          "POST /passkey/register/verify": { status: 200, body: credentialDtoJSON },
        },
        recorded,
      );
      const client = PasskeyClient.passkeyClient(rawClient);
      yield* client.registerPasskeyConditional();
      assert.isDefined(recorded.find((r) => r.path === "/passkey/register/verify"));
    }),
  );

  it.effect(
    "registerOptionsConditional's own declared error (disabled) still propagates, not swallowed",
    () =>
      Effect.gen(function* () {
        installPlatform({});
        const recorded: Array<RecordedRequest> = [];
        const rawClient = yield* buildClient(
          {
            "POST /passkey/register/options/conditional": {
              status: 404,
              body: { _tag: "PasskeyConditionalCreateDisabled" },
            },
          },
          recorded,
        );
        const client = PasskeyClient.passkeyClient(rawClient);
        const failure = yield* client.registerPasskeyConditional().pipe(Effect.flip);
        assert.strictEqual(failure._tag, "PasskeyConditionalCreateDisabled");
      }),
  );
});

describe("PasskeyClient.passkeyClient — authenticate", () => {
  it.effect(
    "button-triggered flow: happy path calls authenticateVerify with the ceremonyId and converted credential",
    () =>
      Effect.gen(function* () {
        installPlatform({ get: () => Promise.resolve(fakeAuthenticationCredential("auth-cred")) });
        const recorded: Array<RecordedRequest> = [];
        const rawClient = yield* buildClient(
          {
            "POST /passkey/authenticate/options": {
              status: 200,
              body: { ceremonyId: "ceremony-1", options: requestOptionsJSON },
            },
            "POST /passkey/authenticate/verify": { status: 200, body: sessionDtoJSON },
          },
          recorded,
        );
        const client = PasskeyClient.passkeyClient(rawClient);
        const result = yield* client.authenticate();
        assert.deepStrictEqual(result, sessionDto);
        const optionsCall = recorded.find((r) => r.path === "/passkey/authenticate/options");
        assert.deepStrictEqual(optionsCall?.body, {});
        const verifyCall = recorded.find((r) => r.path === "/passkey/authenticate/verify");
        assert.deepStrictEqual(verifyCall?.body, {
          ceremonyId: "ceremony-1",
          credential: {
            id: "auth-cred",
            rawId: b64url("auth-cred"),
            response: {
              clientDataJSON: b64url("client-data"),
              authenticatorData: b64url("authenticator-data"),
              signature: b64url("signature"),
            },
            type: "public-key",
          },
        });
      }),
  );

  it.effect("passes the given email through to authenticateOptions", () =>
    Effect.gen(function* () {
      installPlatform({ get: () => Promise.resolve(fakeAuthenticationCredential("auth-cred")) });
      const recorded: Array<RecordedRequest> = [];
      const rawClient = yield* buildClient(
        {
          "POST /passkey/authenticate/options": {
            status: 200,
            body: { ceremonyId: "ceremony-1", options: requestOptionsJSON },
          },
          "POST /passkey/authenticate/verify": { status: 200, body: sessionDtoJSON },
        },
        recorded,
      );
      const client = PasskeyClient.passkeyClient(rawClient);
      yield* client.authenticate({ email: "user@example.com" });
      const optionsCall = recorded.find((r) => r.path === "/passkey/authenticate/options");
      assert.deepStrictEqual(optionsCall?.body, { email: "user@example.com" });
    }),
  );

  it.effect(
    "no PublicKeyCredential global fails PasskeyNotSupported without calling authenticateOptions",
    () =>
      Effect.gen(function* () {
        const recorded: Array<RecordedRequest> = [];
        const rawClient = yield* buildClient({}, recorded);
        const client = PasskeyClient.passkeyClient(rawClient);
        const failure = yield* client.authenticate().pipe(Effect.flip);
        assert.strictEqual(failure._tag, "PasskeyNotSupported");
        assert.strictEqual(recorded.length, 0);
      }),
  );

  it.effect(
    "a malformed authenticateOptions response (missing challenge) fails PasskeyCeremonyFailed",
    () =>
      Effect.gen(function* () {
        installPlatform({ get: () => Promise.resolve(fakeAuthenticationCredential("auth-cred")) });
        const recorded: Array<RecordedRequest> = [];
        const rawClient = yield* buildClient(
          {
            "POST /passkey/authenticate/options": {
              status: 200,
              body: { ceremonyId: "ceremony-1", options: { not: "a real options object" } },
            },
          },
          recorded,
        );
        const client = PasskeyClient.passkeyClient(rawClient);
        const failure = yield* client.authenticate().pipe(Effect.flip);
        assert.strictEqual(failure._tag, "PasskeyCeremonyFailed");
      }),
  );

  it.effect(
    "autoFill: true without a browser document available fails PasskeyCeremonyFailed rather than silently ignoring autoFill",
    () =>
      Effect.gen(function* () {
        installPlatform({ get: () => Promise.resolve(fakeAuthenticationCredential("auth-cred")) });
        class WithAutofillSupport {
          static isConditionalMediationAvailable = () => Promise.resolve(true);
        }
        Reflect.set(globalThis, "PublicKeyCredential", WithAutofillSupport);
        const recorded: Array<RecordedRequest> = [];
        const rawClient = yield* buildClient(
          {
            "POST /passkey/authenticate/options": {
              status: 200,
              body: { ceremonyId: "ceremony-1", options: requestOptionsJSON },
            },
          },
          recorded,
        );
        const client = PasskeyClient.passkeyClient(rawClient);
        // No `document` global installed at all: the real library's own
        // conditional-UI path reads `document.querySelectorAll(...)` to
        // verify an eligible `<input>` exists — this must fail the
        // ceremony, not silently fall back to the button flow (which would
        // defeat BPAS-002's own "mandatory fallback" requirement in the
        // other direction — silently downgrading autoFill rather than
        // surfacing that it couldn't run).
        const failure = yield* client.authenticate({ autoFill: true }).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "PasskeyCeremonyFailed");
        assert.isUndefined(recorded.find((r) => r.path === "/passkey/authenticate/verify"));
      }),
  );
});

describe("PasskeyClient.passkeyClient — credential management", () => {
  it.effect("listPasskeys calls passkey.credentials.list", () =>
    Effect.gen(function* () {
      const recorded: Array<RecordedRequest> = [];
      const rawClient = yield* buildClient(
        { "GET /passkey/credentials": { status: 200, body: [credentialDtoJSON] } },
        recorded,
      );
      const client = PasskeyClient.passkeyClient(rawClient);
      const result = yield* client.listPasskeys();
      assert.deepStrictEqual(result, [credentialDto]);
    }),
  );

  it.effect("renamePasskey PATCHes /passkey/credentials/:id with the new name", () =>
    Effect.gen(function* () {
      const recorded: Array<RecordedRequest> = [];
      const rawClient = yield* buildClient(
        {
          "PATCH /passkey/credentials/cred-1": {
            status: 200,
            body: { ...credentialDtoJSON, name: "New Name" },
          },
        },
        recorded,
      );
      const client = PasskeyClient.passkeyClient(rawClient);
      const result = yield* client.renamePasskey("cred-1", "New Name");
      assert.strictEqual(result.name, "New Name");
      const call = recorded.find((r) => r.path === "/passkey/credentials/cred-1");
      assert.deepStrictEqual(call?.body, { name: "New Name" });
    }),
  );

  it.effect("deletePasskey DELETEs /passkey/credentials/:id", () =>
    Effect.gen(function* () {
      const recorded: Array<RecordedRequest> = [];
      const rawClient = yield* buildClient(
        { "DELETE /passkey/credentials/cred-1": { status: 204 } },
        recorded,
      );
      const client = PasskeyClient.passkeyClient(rawClient);
      yield* client.deletePasskey("cred-1");
      assert.isDefined(recorded.find((r) => r.path === "/passkey/credentials/cred-1"));
    }),
  );
});

describe("PasskeyClient.passkeyClient — getClientCapabilities", () => {
  it.effect("no PublicKeyCredential global at all resolves every capability to 'unsupported'", () =>
    Effect.gen(function* () {
      const recorded: Array<RecordedRequest> = [];
      const rawClient = yield* buildClient({}, recorded);
      const client = PasskeyClient.passkeyClient(rawClient);
      const capabilities = yield* client.getClientCapabilities();
      assert.deepStrictEqual(capabilities, {
        conditionalCreate: "unsupported",
        conditionalGet: "unsupported",
        hybridTransport: "unsupported",
        passkeyPlatformAuthenticator: "unsupported",
        userVerifyingPlatformAuthenticator: "unsupported",
      });
      assert.strictEqual(recorded.length, 0);
    }),
  );

  it.effect("a browser reporting getClientCapabilities() is passed straight through", () =>
    Effect.gen(function* () {
      class WithCapabilities {
        static getClientCapabilities = () =>
          Promise.resolve({
            conditionalCreate: true,
            conditionalGet: false,
            hybridTransport: true,
            passkeyPlatformAuthenticator: true,
            userVerifyingPlatformAuthenticator: false,
            relatedOrigins: false,
            signalAllAcceptedCredentials: false,
            signalCurrentUserDetails: false,
            signalUnknownCredential: false,
          });
      }
      Reflect.set(globalThis, "PublicKeyCredential", WithCapabilities);
      const recorded: Array<RecordedRequest> = [];
      const rawClient = yield* buildClient({}, recorded);
      const client = PasskeyClient.passkeyClient(rawClient);
      const capabilities = yield* client.getClientCapabilities();
      assert.deepStrictEqual(capabilities, {
        conditionalCreate: "supported",
        conditionalGet: "unsupported",
        hybridTransport: "supported",
        passkeyPlatformAuthenticator: "supported",
        userVerifyingPlatformAuthenticator: "unsupported",
      });
    }),
  );
});
