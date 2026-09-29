// @awthaq/device-authorization — DeviceAuthorization
//
// BEH-EA-310 to BEH-EA-317, spec/models/13-device-authorization.md, RFC 8628 (DAG-004/005/007, wayfinder tickets
// 06 and 10). The device authorization grant: an input-constrained client — the `awthaq` CLI, a TV, a set-top box —
// shows a short code, the person approves it on a second, signed-in device, and the first device's poll receives an
// ordinary bearer session. Everything the numbers and the state machine must be is written in the model; this file
// is where they run.
//
// - **`requestCode`** (`POST /device/code`): a registered public client asks for a grant; the answer is a
//   32-byte `device_code` (kept by the device) and an 8-symbol `user_code` (shown to the person), both stored only as
//   SHA-256 hashes. Rate limited per source and per registered client.
// - **`verify`** (`POST /device/verify`, the verification page): a signed-in user *claims* an unclaimed pending
//   code by opening it — a compare-and-swap, idempotent for the same user, impossible for another — and only the
//   claiming user sees which client asks for what; anyone else sees `{ user_code, status }`. Failed lookups spend a
//   budget per source and per session.
// - **`approve` / `deny`**: compare-and-swap on `pending`, only for the claiming user, never from an impersonation
//   session; approving records the approving session's `amr` and can require an assurance level (`Assurance`).
// - **`poll`** (`POST /device/token`): the RFC 8628 §3.5 answers. Every fallible check — client and grant, user,
//   `assertCanSignIn`, `BeforeSignIn`, the `BeforeSessionIssue` divert — runs *before* the atomic consume, and the
//   session is minted only after the consume was won, so under concurrent polls exactly one receives it and the
//   other is answered `invalid_grant` (design constraint 3).
//
// The session is the ordinary one: `Sessions.issue` for the approving user, recorded with the device's address and
// user agent, the approving session's `amr`, delivered as a bearer token (`SessionDelivery`) — so it is revoked,
// listed and expired like every other session, and a second factor or a policy hook applies exactly as it does to a
// password sign-in.

import { Api } from "@awthaq/api";
import {
  Assurance,
  AuthEvents,
  AuthPlugin,
  ConfigDescriptor,
  DataExport,
  Erasure,
  HookPoint,
  Hooks,
  Migrations,
  RateLimits,
  Sessions,
  Users,
} from "@awthaq/core";
import type { Errors } from "@awthaq/core";
import { ClientAddress, Defects, RateLimiter } from "@awthaq/ports";
import { SessionDelivery } from "@awthaq/server";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as DeviceAuthorizationApi from "./DeviceAuthorizationApi.ts";
import * as DeviceClientRecords from "./DeviceClientRecords.ts";
import * as DeviceGrantRecords from "./DeviceGrantRecords.ts";
import * as UserCode from "./UserCode.ts";

// ---- config: a Context.Reference with a default (ADR-EA-011) ---------------------------------------------------------

/** A public client: it has no secret (RFC 8628: the device code is the credential), only a name the person sees. */
export interface DeviceClient {
  readonly clientId: string;
  /** Shown on the approval page: "<name> wants to sign in as you". */
  readonly name: string;
  /** The scopes the client may request. Unset: none, i.e. a plain login. */
  readonly scopes?: ReadonlyArray<string> | undefined;
}

export interface RateLimit {
  readonly limit: number;
  readonly window: Duration.Duration;
}

export interface DeviceAuthorizationConfigShape {
  /** How long a grant lives from `POST /device/code` (RFC 8628 `expires_in`). Default 15 minutes. */
  readonly expiresIn: Duration.Duration;
  /** The poll interval a grant starts with (RFC 8628 `interval`); each `slow_down` adds 5 seconds to it. Default 5 seconds. */
  readonly interval: Duration.Duration;
  /**
   * The absolute URL of the page the person opens to enter the code (`verification_uri`); the code rides in its
   * `?user_code=` (`verification_uri_complete`). Unset: `<origin of the request>/device`, which trusts the `Host` and
   * `X-Forwarded-Proto` headers, so a production deployment behind a proxy should set it (`doctor` says so).
   */
  readonly verificationUri?: string | undefined;
  /**
   * The clients that may ask for a code, beside any registered at runtime (`registerClient`). The default is the
   * `awthaq` CLI's own `awthaq-cli`: installing this plugin is what enables `awthaq login`.
   */
  readonly clients: ReadonlyArray<DeviceClient>;
  /**
   * The weakest authentication an approving session may have (P15, `Assurance`): a session whose `amr` does not
   * reach it cannot approve a device. Unset: any session may.
   */
  readonly requiredAssurance?: Assurance.AssuranceLevel | undefined;
  /** `POST /device/code`: per source address, and per registered client (a flood aimed at one client). */
  readonly codeRateLimit: { readonly ip: RateLimit; readonly client: RateLimit };
  /** The budget of *failed* user-code lookups on the verification and decision endpoints: per source and per session. */
  readonly userCodeRateLimit: { readonly ip: RateLimit; readonly session: RateLimit };
  /** The budget of unknown, foreign or spent device codes per source at `POST /device/token`. */
  readonly invalidGrantRateLimit: RateLimit;
}

export const CLI_CLIENT: DeviceClient = { clientId: "awthaq-cli", name: "awthaq CLI" };

const minutes15 = Duration.minutes(15);

const defaultConfig: DeviceAuthorizationConfigShape = {
  expiresIn: minutes15,
  interval: Duration.seconds(5),
  clients: [CLI_CLIENT],
  codeRateLimit: {
    ip: { limit: 5, window: minutes15 },
    client: { limit: 600, window: minutes15 },
  },
  userCodeRateLimit: {
    ip: { limit: 5, window: minutes15 },
    session: { limit: 5, window: minutes15 },
  },
  invalidGrantRateLimit: { limit: 50, window: minutes15 },
};

export const DeviceAuthorizationConfig = Context.Reference<DeviceAuthorizationConfigShape>(
  "awthaq/device-authorization/Config",
  { defaultValue: () => defaultConfig },
);

export const config = (partial: Partial<DeviceAuthorizationConfigShape>) =>
  Layer.succeed(DeviceAuthorizationConfig, { ...defaultConfig, ...partial });

/** RFC 8628 §3.5: a `slow_down` adds this many seconds to the interval. */
export const SLOW_DOWN_STEP_SECONDS = 5;

/** The strategy label of a device login in `BeforeSignIn`, `BeforeSessionIssue`, `auth.user.signedIn` and webhooks. */
export const STRATEGY = "deviceAuthorization";

// ---- hook points: a veto before an approval, an observe after ------------------------------------------------------------

const ApprovalInput = Schema.Struct({
  userId: Schema.String,
  clientId: Schema.String,
  scope: Schema.Array(Schema.String),
});

/** A tap can refuse an approval (a policy on who may sign a device in, or for which client); it cannot change it. */
export class BeforeDeviceApproval extends HookPoint.veto<BeforeDeviceApproval>()(
  "deviceAuthorization.approval.before",
  ApprovalInput,
) {}

export class AfterDeviceApproval extends HookPoint.observe<AfterDeviceApproval>()(
  "deviceAuthorization.approval.after",
  ApprovalInput,
) {}

export const DeviceAuthorizationHooksLive = Layer.mergeAll(
  BeforeDeviceApproval.layer,
  AfterDeviceApproval.layer,
);

// ---- internal errors -------------------------------------------------------------------------------------------------------------

/** A programmatic `registerClient` named a `clientId` that is already registered (in the config or the table). */
export class ClientExists extends Data.TaggedError("DeviceAuthorization/ClientExists")<{
  readonly clientId: string;
}> {}

/** A programmatic `registerClient` gave an unusable `clientId`, `name` or scope. */
export class ClientInvalid extends Data.TaggedError("DeviceAuthorization/ClientInvalid")<{
  readonly reason: string;
}> {}

// ---- migrations (append-only, dialect-branched) -----------------------------------------------------------------------------------------

const deviceAuthorizationMigrations: Migrations.Migrations = [
  {
    name: "create_device_authorization_grant",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE device_authorization_grant (
            id TEXT PRIMARY KEY,
            "deviceCodeHash" TEXT NOT NULL,
            "userCodeHash" TEXT NOT NULL,
            "clientId" TEXT NOT NULL,
            scopes TEXT NOT NULL,
            status TEXT NOT NULL,
            "userId" TEXT,
            amr TEXT NOT NULL,
            "pollInterval" INTEGER NOT NULL,
            "createdAt" TIMESTAMPTZ NOT NULL,
            "expiresAt" TIMESTAMPTZ NOT NULL,
            "lastPolledAt" TIMESTAMPTZ
          )`,
        sqlite: () => sql`
          CREATE TABLE device_authorization_grant (
            id TEXT PRIMARY KEY,
            "deviceCodeHash" TEXT NOT NULL,
            "userCodeHash" TEXT NOT NULL,
            "clientId" TEXT NOT NULL,
            scopes TEXT NOT NULL,
            status TEXT NOT NULL,
            "userId" TEXT,
            amr TEXT NOT NULL,
            "pollInterval" INTEGER NOT NULL,
            "createdAt" TEXT NOT NULL,
            "expiresAt" TEXT NOT NULL,
            "lastPolledAt" TEXT
          )`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
      // Both codes are looked up by their hash, and a hash is unique for as long as the row lives.
      yield* sql`CREATE UNIQUE INDEX device_authorization_grant_device_idx ON device_authorization_grant ("deviceCodeHash")`;
      yield* sql`CREATE UNIQUE INDEX device_authorization_grant_user_code_idx ON device_authorization_grant ("userCodeHash")`;
      yield* sql`CREATE INDEX device_authorization_grant_user_idx ON device_authorization_grant ("userId")`;
      yield* sql`CREATE INDEX device_authorization_grant_expiry_idx ON device_authorization_grant ("expiresAt")`;
    }),
  },
  {
    name: "create_device_authorization_client",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE device_authorization_client (
            "clientId" TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            scopes TEXT NOT NULL,
            "createdAt" TIMESTAMPTZ NOT NULL,
            "revokedAt" TIMESTAMPTZ
          )`,
        sqlite: () => sql`
          CREATE TABLE device_authorization_client (
            "clientId" TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            scopes TEXT NOT NULL,
            "createdAt" TEXT NOT NULL,
            "revokedAt" TEXT
          )`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
];

// ---- rate limits -----------------------------------------------------------------------------------------------------------------------------

/** One budget: where it is enforced, what it is keyed by, how much it allows. */
interface Budget<Input> {
  readonly group: string;
  readonly endpoint: string;
  readonly rule: string;
  readonly dimension: RateLimits.EnforceMeta["dimension"];
  readonly limit: number;
  readonly window: Duration.Duration;
  readonly keyOf: (input: Input) => string;
}

const ipKey = (prefix: string) => (input: { readonly ip?: string | undefined }) =>
  `${prefix}:ip:${input.ip ?? "unknown"}`;

const metaOf = (budget: Budget<never>): RateLimits.EnforceMeta => ({
  group: budget.group,
  endpoint: budget.endpoint,
  rule: budget.rule,
  dimension: budget.dimension,
});

const makeBudgets = (settings: DeviceAuthorizationConfigShape) => {
  const lookup = (group: string, endpoint: string) => ({
    byIp: {
      group,
      endpoint,
      rule: `${endpoint}-ip`,
      dimension: "ip",
      ...settings.userCodeRateLimit.ip,
      // One budget for all three endpoints that look a code up: a guesser cannot spread attempts across them.
      keyOf: ipKey("device:user-code"),
    } satisfies Budget<{ readonly ip?: string | undefined }>,
    bySession: {
      group,
      endpoint,
      rule: `${endpoint}-session`,
      dimension: "principal",
      ...settings.userCodeRateLimit.session,
      keyOf: (input: { readonly sessionId: string }) =>
        `device:user-code:session:${input.sessionId}`,
    } satisfies Budget<{ readonly sessionId: string }>,
  });
  return {
    codeByIp: {
      group: "device_authorization",
      endpoint: "code",
      rule: "code-ip",
      dimension: "ip",
      ...settings.codeRateLimit.ip,
      keyOf: ipKey("device:code"),
    } satisfies Budget<{ readonly ip?: string | undefined }>,
    codeByClient: {
      group: "device_authorization",
      endpoint: "code",
      rule: "code-client",
      dimension: "custom",
      ...settings.codeRateLimit.client,
      keyOf: (input: { readonly clientId: string }) => `device:code:client:${input.clientId}`,
    } satisfies Budget<{ readonly clientId: string }>,
    invalidGrantByIp: {
      group: "device_authorization",
      endpoint: "token",
      rule: "token-invalid-ip",
      dimension: "ip",
      ...settings.invalidGrantRateLimit,
      keyOf: ipKey("device:token-invalid"),
    } satisfies Budget<{ readonly ip?: string | undefined }>,
    verify: lookup("device_authorization.verification", "verify"),
    approve: lookup("device_authorization.decision", "approve"),
    deny: lookup("device_authorization.decision", "deny"),
  };
};

// ---- the service ---------------------------------------------------------------------------------------------------------------------------------------

export interface CodeIssued {
  /** Shown to the device only; never stored or logged. */
  readonly deviceCode: Redacted.Redacted<string>;
  /** Displayed `XXXX-XXXX`. */
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresIn: number;
  readonly interval: number;
}

/** What the verification page shows: always the code and its status; the context only to the user who claimed it. */
export interface VerificationView {
  readonly userCode: string;
  readonly status: DeviceGrantRecords.GrantStatus;
  readonly context: Option.Option<{
    readonly client: { readonly clientId: string; readonly name: string };
    readonly scopes: ReadonlyArray<string>;
    readonly expiresAt: DateTime.Utc;
  }>;
}

export interface RedeemedGrant {
  readonly session: Sessions.SessionView;
  readonly token: Redacted.Redacted<string>;
  readonly scope: ReadonlyArray<string>;
}

/** The caller of the verification and decision endpoints: the user's principal, when there is a user. */
export interface Caller {
  readonly userId: Users.UserId;
  readonly sessionId: string;
  /** `true` for an impersonation session: it may look, never decide. */
  readonly impersonated: boolean;
  readonly amr: ReadonlyArray<Sessions.AuthMethod>;
}

interface Source {
  readonly ip?: string | undefined;
}

export interface DeviceClientView {
  readonly clientId: string;
  readonly name: string;
  readonly scopes: ReadonlyArray<string>;
  /** `config` for a client in `DeviceAuthorizationConfig.clients`, `registered` for one in the table. */
  readonly source: "config" | "registered";
  readonly revoked: boolean;
}

export type PollError =
  | DeviceAuthorizationApi.AuthorizationPending
  | DeviceAuthorizationApi.SlowDown
  | DeviceAuthorizationApi.AccessDenied
  | DeviceAuthorizationApi.ExpiredToken
  | DeviceAuthorizationApi.InvalidGrant
  | Api.RateLimited
  | HookPoint.HookAborted
  | Users.UserSuspended
  | Errors.StoreUnavailable;

export interface DeviceAuthorizationShape {
  /** BEH-EA-310: a fresh grant for a registered client. */
  readonly requestCode: (
    input: Source & { readonly clientId: string; readonly scope: ReadonlyArray<string> },
    context: { readonly verificationBase: string },
  ) => Effect.Effect<
    CodeIssued,
    DeviceAuthorizationApi.InvalidClient | DeviceAuthorizationApi.InvalidScope | Api.RateLimited
  >;
  /** BEH-EA-311/315: one poll. Resolves only for the poll that wins the redemption claim. */
  readonly poll: (
    input: Source & { readonly deviceCode: Redacted.Redacted<string>; readonly clientId: string },
    context?: { readonly userAgent?: string | undefined },
  ) => Effect.Effect<RedeemedGrant, PollError>;
  /** BEH-EA-312: the verification page — claims an unclaimed pending code for `caller`, when there is one. */
  readonly verify: (
    input: Source & { readonly userCode: string },
    caller: Option.Option<Caller>,
  ) => Effect.Effect<VerificationView, DeviceAuthorizationApi.InvalidUserCode | Api.RateLimited>;
  /** BEH-EA-313: approves a code the caller has claimed; a `BeforeDeviceApproval` tap can refuse it. */
  readonly approve: (
    input: Source & { readonly userCode: string },
    caller: Caller,
  ) => Effect.Effect<
    VerificationView,
    | DeviceAuthorizationApi.InvalidUserCode
    | DeviceAuthorizationApi.UserCodeNotClaimed
    | DeviceAuthorizationApi.DeviceApprovalRefused
    | Api.RateLimited
    | HookPoint.HookAborted
  >;
  /** BEH-EA-313: denies a code the caller has claimed. */
  readonly deny: (
    input: Source & { readonly userCode: string },
    caller: Caller,
  ) => Effect.Effect<
    VerificationView,
    | DeviceAuthorizationApi.InvalidUserCode
    | DeviceAuthorizationApi.UserCodeNotClaimed
    | DeviceAuthorizationApi.DeviceApprovalRefused
    | Api.RateLimited
  >;
  /** BEH-EA-316: registers a public client at runtime (an operator or seed script, never an end user). */
  readonly registerClient: (input: {
    readonly name: string;
    readonly clientId?: string | undefined;
    readonly scopes?: ReadonlyArray<string> | undefined;
  }) => Effect.Effect<DeviceClientView, ClientExists | ClientInvalid>;
  /** Revokes a registered client: it can no longer ask for a code (grants it already holds run out). `false` when there was none to revoke. */
  readonly revokeClient: (clientId: string) => Effect.Effect<boolean>;
  readonly listClients: Effect.Effect<ReadonlyArray<DeviceClientView>>;
  /** BEH-EA-317: physically deletes grants that expired before `before` (default: now); an operator's retention job calls it. */
  readonly purgeExpired: (before?: DateTime.Utc) => Effect.Effect<number>;
}

/** The address (through the application-provided `ClientAddress` port) and user agent of a request. */
const currentClient = Effect.fnUntraced(function* (
  clientAddress: ClientAddress.ClientAddressShape,
  request: HttpServerRequest.HttpServerRequest,
) {
  const resolved = yield* clientAddress.resolve(request);
  const userAgent = Headers.get(request.headers, "user-agent");
  return {
    ip: Option.getOrUndefined(resolved),
    context: Option.isSome(userAgent) ? { userAgent: userAgent.value } : {},
  };
});

const originOf = (request: HttpServerRequest.HttpServerRequest): string =>
  Option.match(HttpServerRequest.toURL(request), {
    onNone: () => "http://localhost",
    onSome: (url) => url.origin,
  });

/** The caller behind `Authentication`/`OptionalAuthentication`: a user principal, else nobody. */
const currentCaller = Effect.gen(function* () {
  const principal = yield* Api.CurrentPrincipal;
  if (principal._tag !== "User") return Option.none<Caller>();
  return Option.some<Caller>({
    userId: Users.UserId(principal.ref.id),
    sessionId: principal.sessionId,
    impersonated: principal.actingAs !== undefined,
    amr: (principal.amr ?? []).filter(Sessions.isAuthMethod),
  });
});

const toVerificationDto = (view: VerificationView) =>
  new DeviceAuthorizationApi.VerificationDto({
    user_code: view.userCode,
    status: view.status,
    ...Option.match(view.context, {
      onNone: () => ({}),
      onSome: (context) => ({
        client: new DeviceAuthorizationApi.VerificationClient({
          client_id: context.client.clientId,
          name: context.client.name,
        }),
        scope: context.scopes,
        expires_at: DateTime.formatIso(context.expiresAt),
      }),
    }),
  });

const scopesOf = (scope: string | undefined): ReadonlyArray<string> => [
  ...new Set((scope ?? "").split(" ").filter((token) => token !== "")),
];

export const DeviceAuthorizationHandlers = Layer.mergeAll(
  HttpApiBuilder.group(
    DeviceAuthorizationApi.DeviceAuthorizationApi,
    "device_authorization",
    Effect.fnUntraced(function* (handlers) {
      const deviceAuthorization = yield* DeviceAuthorization;
      const settings = yield* DeviceAuthorizationConfig;
      const clientAddress = yield* ClientAddress.ClientAddress;
      return handlers.handleAll({
        code: Effect.fnUntraced(function* ({
          payload,
          request,
        }: {
          payload: DeviceAuthorizationApi.CodePayload;
          request: HttpServerRequest.HttpServerRequest;
        }) {
          const client = yield* currentClient(clientAddress, request);
          const issued = yield* deviceAuthorization.requestCode(
            { clientId: payload.client_id, scope: scopesOf(payload.scope), ip: client.ip },
            { verificationBase: settings.verificationUri ?? `${originOf(request)}/device` },
          );
          return new DeviceAuthorizationApi.CodeResponse({
            device_code: Redacted.value(issued.deviceCode),
            user_code: issued.userCode,
            verification_uri: issued.verificationUri,
            verification_uri_complete: issued.verificationUriComplete,
            expires_in: issued.expiresIn,
            interval: issued.interval,
          });
        }),
        token: Effect.fnUntraced(function* ({
          payload,
          request,
        }: {
          payload: DeviceAuthorizationApi.TokenPayload;
          request: HttpServerRequest.HttpServerRequest;
        }) {
          if (payload.grant_type !== DeviceAuthorizationApi.DEVICE_CODE_GRANT_TYPE) {
            return yield* new DeviceAuthorizationApi.UnsupportedGrantType();
          }
          if (payload.device_code === "" || payload.client_id === "") {
            return yield* new DeviceAuthorizationApi.InvalidRequest();
          }
          const client = yield* currentClient(clientAddress, request);
          const redeemed = yield* deviceAuthorization.poll(
            {
              deviceCode: Redacted.make(payload.device_code),
              clientId: payload.client_id,
              ip: client.ip,
            },
            client.context,
          );
          // MNA-001: a device has no cookie jar — the session always travels as a bearer token, `no-store`.
          const delivered = yield* SessionDelivery.deliver("bearer", redeemed);
          if (delivered.token === undefined) {
            return yield* Defects.invariantViolation(
              "DeviceTokenNotDelivered",
              "awthaq/device-authorization: bearer delivery returned no token",
            );
          }
          const now = yield* DateTime.now;
          return new DeviceAuthorizationApi.TokenResponse({
            access_token: delivered.token,
            token_type: "Bearer",
            expires_in: Math.max(
              0,
              Math.floor(
                (DateTime.toEpochMillis(redeemed.session.idleExpiresAt) -
                  DateTime.toEpochMillis(now)) /
                  1000,
              ),
            ),
            scope: redeemed.scope.join(" "),
          });
        }),
      });
    }),
  ),
  HttpApiBuilder.group(
    DeviceAuthorizationApi.DeviceAuthorizationApi,
    "device_authorization.verification",
    Effect.fnUntraced(function* (handlers) {
      const deviceAuthorization = yield* DeviceAuthorization;
      const clientAddress = yield* ClientAddress.ClientAddress;
      return handlers.handleAll({
        verify: Effect.fnUntraced(function* ({
          payload,
          request,
        }: {
          payload: DeviceAuthorizationApi.UserCodePayload;
          request: HttpServerRequest.HttpServerRequest;
        }) {
          const client = yield* currentClient(clientAddress, request);
          const caller = yield* currentCaller;
          const view = yield* deviceAuthorization.verify(
            { userCode: payload.user_code, ip: client.ip },
            // An impersonation session may look at a code's status but must not claim it.
            Option.filter(caller, (found) => !found.impersonated),
          );
          return toVerificationDto(view);
        }),
      });
    }),
  ),
  HttpApiBuilder.group(
    DeviceAuthorizationApi.DeviceAuthorizationApi,
    "device_authorization.decision",
    Effect.fnUntraced(function* (handlers) {
      const deviceAuthorization = yield* DeviceAuthorization;
      const clientAddress = yield* ClientAddress.ClientAddress;
      /** Behind `Authentication` there is always a user principal; anything else is a wiring defect. */
      const decisionCaller = Effect.gen(function* () {
        const caller = yield* currentCaller;
        if (Option.isNone(caller)) {
          return yield* Defects.invariantViolation(
            "NonUserPrincipal",
            "awthaq/device-authorization: a decision reached without a user principal",
          );
        }
        return caller.value;
      });
      const toDecisionDto = (view: VerificationView) =>
        new DeviceAuthorizationApi.DecisionDto({ user_code: view.userCode, status: view.status });
      return handlers.handleAll({
        approve: Effect.fnUntraced(function* ({
          payload,
          request,
        }: {
          payload: DeviceAuthorizationApi.UserCodePayload;
          request: HttpServerRequest.HttpServerRequest;
        }) {
          const client = yield* currentClient(clientAddress, request);
          const caller = yield* decisionCaller;
          return toDecisionDto(
            yield* deviceAuthorization.approve(
              { userCode: payload.user_code, ip: client.ip },
              caller,
            ),
          );
        }),
        deny: Effect.fnUntraced(function* ({
          payload,
          request,
        }: {
          payload: DeviceAuthorizationApi.UserCodePayload;
          request: HttpServerRequest.HttpServerRequest;
        }) {
          const client = yield* currentClient(clientAddress, request);
          const caller = yield* decisionCaller;
          return toDecisionDto(
            yield* deviceAuthorization.deny({ userCode: payload.user_code, ip: client.ip }, caller),
          );
        }),
      });
    }),
  ),
);

// ---- erasure and export (CSG-001/CSG-005) ---------------------------------------------------------------------------------------------------------------

/** Account erasure: every grant the person claimed or decided. No foreign keys, so this is the cascade. */
export const deviceAuthorizationErasure = Erasure.contribute({
  id: "device_authorization",
  make: Effect.gen(function* () {
    const grants = yield* DeviceGrantRecords.DeviceGrantRecords;
    return (subject: Erasure.ErasureSubject) => grants.deleteByUser(subject.userId);
  }),
});

/** Data-subject export: which client asked, the scope and the state of each grant — never a code or a hash. */
export const deviceAuthorizationExport = DataExport.contribute({
  id: "device_authorization",
  make: Effect.gen(function* () {
    const grants = yield* DeviceGrantRecords.DeviceGrantRecords;
    return (subject: DataExport.DataExportSubject) =>
      grants.listByUser(subject.userId).pipe(
        Effect.map((records) => ({
          grants: records.map((record) => ({
            clientId: record.clientId,
            scope: [...record.scopes],
            status: record.status,
            createdAt: DateTime.formatIso(record.createdAt),
            expiresAt: DateTime.formatIso(record.expiresAt),
          })),
        })),
      );
  }),
});

// ---- the plugin ----------------------------------------------------------------------------------------------------------------------------------------------------

const CLIENT_ID = /^[\x21-\x7E]{1,128}$/;
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/;

export class DeviceAuthorization extends AuthPlugin.Service<
  DeviceAuthorization,
  DeviceAuthorizationShape
>()("device_authorization", {
  apiVersion: 1,
  contract: DeviceAuthorizationApi.DeviceAuthorizationApi,
  tables: ["device_authorization_grant", "device_authorization_client"],
  migrations: deviceAuthorizationMigrations,
  // ECS-008/BEH-EA-229: what `doctor` audits and `config list` prints.
  config: [
    ConfigDescriptor.make(DeviceAuthorizationConfig, {
      audit: (value, environment) =>
        environment.production && value.verificationUri === undefined
          ? [
              ConfigDescriptor.finding(
                "warning",
                "device-authorization-verification-uri",
                "verificationUri is unset: the verification URL a device shows is derived from the request's Host and X-Forwarded-Proto headers (set the application's own page)",
              ),
            ]
          : [],
    }),
  ],
}) {
  static readonly layer = AuthPlugin.layer(DeviceAuthorization, {
    handlers: DeviceAuthorizationHandlers,
    contributes: Layer.mergeAll(deviceAuthorizationErasure, deviceAuthorizationExport),
    make: Effect.gen(function* () {
      const grants = yield* DeviceGrantRecords.DeviceGrantRecords;
      const clients = yield* DeviceClientRecords.DeviceClientRecords;
      const users = yield* Users.Users;
      const sessions = yield* Sessions.Sessions;
      const events = yield* AuthEvents.AuthEvents;
      const crypto = yield* Crypto.Crypto;
      const limiter = yield* RateLimiter.RateLimiter;
      const rateLimitsRegistry = yield* RateLimits.RateLimitsRegistry;
      const settings = yield* DeviceAuthorizationConfig;
      const beforeApproval = yield* BeforeDeviceApproval;
      const afterApproval = yield* AfterDeviceApproval;
      const beforeSignIn = yield* Hooks.BeforeSignIn;
      const beforeSessionIssue = yield* Hooks.BeforeSessionIssue;
      const afterSignIn = yield* Hooks.AfterSignIn;

      const budgets = makeBudgets(settings);

      // Every budget is introspectable through the registry (BEH-EA-111). The callback's return type is annotated
      // to break the inference cycle through `DeviceAuthorization.layer` (its own initializer names the class) —
      // the narrow exception `MagicLink`/`Password` document too.
      const registered: ReadonlyArray<Budget<never>> = [
        budgets.codeByIp,
        budgets.codeByClient,
        budgets.invalidGrantByIp,
        budgets.verify.byIp,
        budgets.verify.bySession,
        budgets.approve.byIp,
        budgets.approve.bySession,
        budgets.deny.byIp,
        budgets.deny.bySession,
      ];
      yield* Effect.all(
        registered.map((budget): Effect.Effect<void, RateLimits.RateLimitScopeViolation> =>
          rateLimitsRegistry.register(DeviceAuthorization, {
            group: budget.group,
            endpoint: budget.endpoint,
            key: budget.dimension === "ip" ? "ip" : () => `device:${budget.rule}`,
            limit: budget.limit,
            window: budget.window,
          }),
        ),
      ).pipe(Effect.orDie);

      /** Consumes one unit of a budget; a breach is published, logged and counted (EOTS-007), and answers 429. */
      const spend = <I>(budget: Budget<I>, input: I): Effect.Effect<void, Api.RateLimited> =>
        RateLimits.enforce({
          key: budget.keyOf(input),
          limit: budget.limit,
          window: budget.window,
          meta: metaOf(budget),
        }).pipe(
          Effect.provideService(RateLimiter.RateLimiter, limiter),
          Effect.provideService(AuthEvents.AuthEvents, events),
          Effect.catchTag(
            "RateLimitExceeded",
            (error) => new Api.RateLimited({ retryAfterMillis: error.retryAfterMillis }),
          ),
        );

      /** The read half of a failure budget (BCR-006): refuses once it is spent, without counting this call. */
      const assertBudget = <I>(budget: Budget<I>, input: I): Effect.Effect<void, Api.RateLimited> =>
        limiter
          .check({ key: budget.keyOf(input), limit: budget.limit, window: budget.window })
          .pipe(
            Effect.catchTag("RateLimitExceeded", (error) =>
              events
                .publish({
                  _tag: "auth.rateLimit.exceeded",
                  ...metaOf(budget),
                  retryAfterMillis: error.retryAfterMillis,
                })
                .pipe(
                  Effect.andThen(
                    Effect.fail(new Api.RateLimited({ retryAfterMillis: error.retryAfterMillis })),
                  ),
                ),
            ),
          );

      /** Charges one failure; a race past the limit is ignored, the next `assertBudget` refuses it. */
      const charge = <I>(budget: Budget<I>, input: I) =>
        limiter
          .consume({ key: budget.keyOf(input), limit: budget.limit, window: budget.window })
          .pipe(Effect.ignore);

      // ---- clients ---------------------------------------------------------------------------------

      const fromConfig = (found: DeviceClient): DeviceClientView => ({
        clientId: found.clientId,
        name: found.name,
        scopes: found.scopes ?? [],
        source: "config",
        revoked: false,
      });

      const fromRecord = (record: DeviceClientRecords.DeviceClientRecord): DeviceClientView => ({
        clientId: record.clientId,
        name: record.name,
        scopes: record.scopes,
        source: "registered",
        revoked: Option.isSome(record.revokedAt),
      });

      /** A client that may ask for a code: a configured one, else a registered one that is not revoked. */
      const liveClient = Effect.fnUntraced(function* (clientId: string) {
        const configured = settings.clients.find((found) => found.clientId === clientId);
        if (configured !== undefined) return Option.some(fromConfig(configured));
        const record = yield* clients.findById(clientId);
        return Option.filter(Option.map(record, fromRecord), (view) => !view.revoked);
      });

      const registerClient: DeviceAuthorizationShape["registerClient"] = Effect.fnUntraced(
        function* (input) {
          const name = input.name.trim();
          const scopes = [...new Set(input.scopes ?? [])];
          if (name === "" || name.length > 128) {
            return yield* new ClientInvalid({ reason: "name must be 1 to 128 characters" });
          }
          if (input.clientId !== undefined && !CLIENT_ID.test(input.clientId)) {
            return yield* new ClientInvalid({
              reason: "clientId must be 1 to 128 printable ASCII characters",
            });
          }
          if (scopes.some((scope) => !SCOPE_TOKEN.test(scope))) {
            return yield* new ClientInvalid({ reason: "a scope is not an RFC 6749 scope-token" });
          }
          const clientId = input.clientId ?? `dc_${yield* crypto.randomUUIDv7.pipe(Effect.orDie)}`;
          if (settings.clients.some((found) => found.clientId === clientId)) {
            return yield* new ClientExists({ clientId });
          }
          const record: DeviceClientRecords.DeviceClientRecord = {
            clientId,
            name,
            scopes,
            createdAt: yield* DateTime.now,
            revokedAt: Option.none(),
          };
          if (!(yield* clients.insert(record))) return yield* new ClientExists({ clientId });
          return fromRecord(record);
        },
      );

      const revokeClient: DeviceAuthorizationShape["revokeClient"] = (clientId) =>
        Effect.flatMap(DateTime.now, (now) => clients.revoke(clientId, now));

      const listClients: DeviceAuthorizationShape["listClients"] = Effect.map(
        clients.list,
        (records) => [...settings.clients.map(fromConfig), ...records.map(fromRecord)],
      );

      // ---- requesting a code -------------------------------------------------------------------------

      const requestCode: DeviceAuthorizationShape["requestCode"] = Effect.fnUntraced(
        function* (input, context) {
          yield* spend(budgets.codeByIp, { ip: input.ip });
          const client = yield* liveClient(input.clientId);
          if (Option.isNone(client)) return yield* new DeviceAuthorizationApi.InvalidClient();
          if (input.scope.some((scope) => !client.value.scopes.includes(scope))) {
            return yield* new DeviceAuthorizationApi.InvalidScope();
          }
          // Only a registered client's id becomes a bucket key: an attacker cannot mint buckets by inventing ids.
          yield* spend(budgets.codeByClient, { clientId: client.value.clientId });
          const now = yield* DateTime.now;
          const grantId = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
          const interval = Math.max(1, Math.ceil(Duration.toSeconds(settings.interval)));
          // A user-code collision with a live row (20^8 possibilities) draws again; it is not an error.
          for (let attempt = 0; attempt < 5; attempt++) {
            const userCode = yield* UserCode.generate(crypto);
            const deviceCode = yield* UserCode.generateDeviceCode(crypto);
            const inserted = yield* grants.insert({
              id: grantId,
              deviceCodeHash: yield* UserCode.hashDeviceCode(crypto, deviceCode),
              userCodeHash: yield* UserCode.hash(crypto, userCode),
              clientId: client.value.clientId,
              scopes: input.scope,
              status: "pending",
              userId: Option.none(),
              amr: [],
              pollInterval: interval,
              createdAt: now,
              expiresAt: DateTime.addDuration(now, settings.expiresIn),
              lastPolledAt: Option.none(),
            });
            if (!inserted) continue;
            const shown = UserCode.format(userCode);
            const base = context.verificationBase;
            return {
              deviceCode: Redacted.make(deviceCode),
              userCode: shown,
              verificationUri: base,
              verificationUriComplete: `${base}${base.includes("?") ? "&" : "?"}user_code=${encodeURIComponent(shown)}`,
              expiresIn: Math.floor(Duration.toSeconds(settings.expiresIn)),
              interval,
            } satisfies CodeIssued;
          }
          return yield* Defects.invariantViolation(
            "UserCodeSpaceExhausted",
            "awthaq/device-authorization: could not draw an unused user code after 5 attempts",
          );
        },
      );

      // ---- the user-facing side --------------------------------------------------------------------

      const expired = (record: DeviceGrantRecords.DeviceGrantRecord, now: DateTime.Utc) =>
        DateTime.toEpochMillis(record.expiresAt) <= DateTime.toEpochMillis(now);

      /**
       * Finds a live grant by the code as typed. A malformed, unknown or expired code is one `InvalidUserCode`
       * and spends the failure budget (per source and, when there is one, per session); once the budget is spent
       * the lookup is refused before anything is evaluated. An expired row is *not* deleted here (design constraint 5).
       */
      const lookupUserCode = Effect.fnUntraced(function* (
        endpoint: "verify" | "approve" | "deny",
        userCode: string,
        who: Source & { readonly sessionId?: string | undefined },
      ) {
        const set = budgets[endpoint];
        yield* assertBudget(set.byIp, { ip: who.ip });
        if (who.sessionId !== undefined)
          yield* assertBudget(set.bySession, { sessionId: who.sessionId });
        const miss = Effect.gen(function* () {
          yield* charge(set.byIp, { ip: who.ip });
          if (who.sessionId !== undefined)
            yield* charge(set.bySession, { sessionId: who.sessionId });
          return yield* new DeviceAuthorizationApi.InvalidUserCode();
        });
        const normalized = UserCode.normalize(userCode);
        if (!UserCode.isWellFormed(normalized)) return yield* miss;
        const found = yield* grants.findByUserHash(yield* UserCode.hash(crypto, normalized));
        const now = yield* DateTime.now;
        if (Option.isNone(found) || expired(found.value, now)) return yield* miss;
        return found.value;
      });

      const viewOf = (
        record: DeviceGrantRecords.DeviceGrantRecord,
        userCode: string,
        client: Option.Option<DeviceClientView>,
        mine: boolean,
      ): VerificationView => ({
        userCode,
        status: record.status,
        context: mine
          ? Option.some({
              client: {
                clientId: record.clientId,
                name: Option.match(client, {
                  onNone: () => record.clientId,
                  onSome: (found) => found.name,
                }),
              },
              scopes: record.scopes,
              expiresAt: record.expiresAt,
            })
          : Option.none(),
      });

      const verify: DeviceAuthorizationShape["verify"] = Effect.fnUntraced(
        function* (input, caller) {
          const shown = UserCode.format(UserCode.normalize(input.userCode));
          const record = yield* lookupUserCode("verify", input.userCode, {
            ip: input.ip,
            sessionId: Option.getOrUndefined(Option.map(caller, (found) => found.sessionId)),
          });
          if (Option.isNone(caller)) return viewOf(record, shown, Option.none(), false);
          const userId = caller.value.userId;
          const claimedByCaller = Option.exists(record.userId, (owner) => owner === userId);
          if (!claimedByCaller && record.status === "pending" && Option.isNone(record.userId)) {
            // The claim: a compare-and-swap. Of two sessions opening the page together, one wins.
            yield* grants.claim(record.id, userId);
          }
          // Re-read: the row is what the claim (ours or a rival's) left, and only its claimer sees the context.
          const latest = yield* grants.findByUserHash(yield* UserCode.hash(crypto, input.userCode));
          if (Option.isNone(latest)) return yield* new DeviceAuthorizationApi.InvalidUserCode();
          const mine = Option.exists(latest.value.userId, (owner) => owner === userId);
          return viewOf(
            latest.value,
            shown,
            mine ? yield* liveClient(latest.value.clientId) : Option.none(),
            mine,
          );
        },
      );

      /**
       * The shared spine of a decision. `gate` runs after the ownership checks and before the swap (the approval's
       * assurance check and veto tap; nothing for a denial), so the two public methods differ in their error type by
       * exactly what they can refuse with.
       */
      const decide = Effect.fnUntraced(function* <E>(
        decision: "approve" | "deny",
        input: Source & { readonly userCode: string },
        caller: Caller,
        gate: (grant: DeviceGrantRecords.DeviceGrantRecord) => Effect.Effect<void, E>,
      ) {
        if (caller.impersonated) return yield* new DeviceAuthorizationApi.DeviceApprovalRefused();
        const shown = UserCode.format(UserCode.normalize(input.userCode));
        const record = yield* lookupUserCode(decision, input.userCode, {
          ip: input.ip,
          sessionId: caller.sessionId,
        });
        // No prior claim: refused. A code someone else claimed is indistinguishable from an unknown one.
        if (Option.isNone(record.userId)) {
          return yield* new DeviceAuthorizationApi.UserCodeNotClaimed();
        }
        if (record.userId.value !== caller.userId || record.status !== "pending") {
          return yield* new DeviceAuthorizationApi.InvalidUserCode();
        }
        yield* gate(record);
        const status = decision === "approve" ? "approved" : "denied";
        const decided = yield* grants.decide({
          id: record.id,
          userId: caller.userId,
          status,
          // The redeemed session inherits how the approving session authenticated (P15 `amr`).
          amr: decision === "approve" ? caller.amr : [],
          now: yield* DateTime.now,
        });
        // A racing decision (or the clock) won: the code is no longer pending.
        if (!decided) return yield* new DeviceAuthorizationApi.InvalidUserCode();
        yield* events.publish({
          _tag:
            decision === "approve"
              ? "auth.deviceAuthorization.approved"
              : "auth.deviceAuthorization.denied",
          userId: caller.userId,
          clientId: record.clientId,
        });
        return { view: viewOf({ ...record, status }, shown, Option.none(), false), record };
      });

      const approve: DeviceAuthorizationShape["approve"] = Effect.fnUntraced(
        function* (input, caller) {
          const { view, record } = yield* decide("approve", input, caller, (grant) =>
            Effect.gen(function* () {
              if (
                settings.requiredAssurance !== undefined &&
                !Assurance.satisfies(caller.amr, settings.requiredAssurance)
              ) {
                return yield* new DeviceAuthorizationApi.DeviceApprovalRefused();
              }
              yield* HookPoint.aborted(BeforeDeviceApproval)(
                beforeApproval.run({
                  userId: caller.userId,
                  clientId: grant.clientId,
                  scope: grant.scopes,
                }),
              );
            }),
          );
          yield* afterApproval.run({
            userId: caller.userId,
            clientId: record.clientId,
            scope: record.scopes,
          });
          return view;
        },
      );

      const deny: DeviceAuthorizationShape["deny"] = Effect.fnUntraced(function* (input, caller) {
        const { view } = yield* decide("deny", input, caller, () => Effect.void);
        return view;
      });

      // ---- polling -----------------------------------------------------------------------------------

      const poll: DeviceAuthorizationShape["poll"] = Effect.fnUntraced(function* (input, context) {
        yield* assertBudget(budgets.invalidGrantByIp, { ip: input.ip });
        const invalidGrant = Effect.gen(function* () {
          yield* charge(budgets.invalidGrantByIp, { ip: input.ip });
          return yield* new DeviceAuthorizationApi.InvalidGrant();
        });
        const found = yield* grants.findByDeviceHash(
          yield* UserCode.hashDeviceCode(crypto, Redacted.value(input.deviceCode)),
        );
        // Unknown, another client's, or already redeemed: one answer (RFC 8628 §3.5).
        if (Option.isNone(found) || found.value.clientId !== input.clientId)
          return yield* invalidGrant;
        const grant = found.value;
        const now = yield* DateTime.now;

        // Design constraint 4: the interval is enforced before anything else and `lastPolledAt` advances on every
        // poll that passes it — including one about to be rejected as pending, expired or denied — so a client
        // cannot dodge throttling by polling a dead code.
        const tooSoon = Option.exists(
          grant.lastPolledAt,
          (last) =>
            DateTime.toEpochMillis(now) - DateTime.toEpochMillis(last) < grant.pollInterval * 1000,
        );
        if (tooSoon) {
          yield* grants.raiseInterval(grant.id, SLOW_DOWN_STEP_SECONDS);
          return yield* new DeviceAuthorizationApi.SlowDown({
            interval: grant.pollInterval + SLOW_DOWN_STEP_SECONDS,
          });
        }
        yield* grants.touchPoll(grant.id, now);

        // Design constraint 5: garbage collection on discovery.
        if (expired(grant, now)) {
          yield* grants.remove(grant.id);
          return yield* new DeviceAuthorizationApi.ExpiredToken();
        }
        if (grant.status === "denied") {
          yield* grants.remove(grant.id);
          return yield* new DeviceAuthorizationApi.AccessDenied();
        }
        if (grant.status === "pending" || Option.isNone(grant.userId)) {
          return yield* new DeviceAuthorizationApi.AuthorizationPending();
        }

        // Approved. Design constraint 3: every fallible check first...
        const userId = grant.userId.value;
        const user = yield* users
          .findById(userId)
          .pipe(
            Effect.catchTag("UserNotFound", () =>
              grants
                .remove(grant.id)
                .pipe(Effect.andThen(Effect.fail(new DeviceAuthorizationApi.InvalidGrant()))),
            ),
          );
        yield* Users.assertCanSignIn(user);
        yield* HookPoint.aborted(Hooks.BeforeSignIn)(
          beforeSignIn.run({ userId, ...Users.emailField(user), strategy: STRATEGY }),
        );
        // A second factor or a policy tap applies as to any sign-in; a device cannot answer a challenge, so a
        // divert ends the grant (`access_denied`) rather than leaving it to be polled to expiry.
        const point = yield* beforeSessionIssue.run({ userId, strategy: STRATEGY, amr: grant.amr });
        if (point._tag === "Diverted") {
          yield* grants.remove(grant.id);
          return yield* new DeviceAuthorizationApi.AccessDenied();
        }
        // ...then the atomic claim; the session is minted strictly after it was won.
        const claimed = yield* grants.consume(grant.id, userId);
        if (Option.isNone(claimed)) return yield* invalidGrant;
        const issued = yield* sessions.issue({
          userId,
          request: {
            ...(input.ip === undefined ? {} : { ip: input.ip }),
            ...(context?.userAgent === undefined ? {} : { userAgent: context.userAgent }),
          },
          amr: claimed.value.amr,
        });
        yield* events.publish({ _tag: "auth.user.signedIn", userId, strategy: STRATEGY });
        yield* afterSignIn.run({ userId, strategy: STRATEGY });
        return { session: issued.session, token: issued.token, scope: claimed.value.scopes };
      });

      const purgeExpired: DeviceAuthorizationShape["purgeExpired"] = (before) =>
        (before === undefined ? DateTime.now : Effect.succeed(before)).pipe(
          Effect.flatMap((cutoff) => grants.purgeExpired(cutoff)),
        );

      return DeviceAuthorization.of({
        requestCode,
        poll,
        verify,
        approve,
        deny,
        registerClient,
        revokeClient,
        listClients,
        purgeExpired,
      });
    }),
  });
}
