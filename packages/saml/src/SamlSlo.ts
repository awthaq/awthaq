// @awthaq/saml — SamlSlo
//
// BEH-EA-315: SAML Single Logout, both directions, over the HTTP-Redirect and HTTP-POST bindings.
//
//   - SP-initiated (`logout`): the signed-in user's session is ended locally at once (a lost or refused answer from the IdP can
//     never leave the session alive), then the browser is sent to the IdP with a `LogoutRequest` naming the NameID and
//     SessionIndex the sign-in recorded. The request id is reserved in `Verification` and bound to the browser by the
//     `__Host-saml-logout` cookie; the IdP's `LogoutResponse` comes back to `/auth/saml/slo/:connection` and must answer THAT id.
//   - IdP-initiated (`slo`, a `LogoutRequest`): the IdP tells this SP to end a user's sessions. The message is verified like an
//     assertion is (the pinned trust set of the connection named by the URL, never one chosen by the document), judged (issuer,
//     Destination, freshness), accepted once (its id is reserved: a replayed capture cannot log the user out again), and then
//     every local session the connection created for that NameID (and SessionIndex, when named) is revoked with reason
//     `federatedLogout`, as the connection's tenant. The answer is a `LogoutResponse` over the IdP's binding.
//
// The two signature forms are the ones the bindings prescribe. Redirect: a query-string signature over the raw encoded
// parameters (`SamlKeys.verifyRedirect`, the octets rebuilt from the request's own raw query, never re-encoded from decoded
// values). POST: an enveloped XML signature, verified by the SAME `XmlSignature` port as an assertion, and read only from the
// bytes it returns. An unsigned message is refused (a logout endpoint that accepted unsigned requests would let anyone end
// anyone's sessions). Every refusal is ONE uniform `SamlLogoutRejected`; the reason is logged and audited, never returned.
//
// Outbound messages (our request, our response) are signed with the connection's SP key whenever it has one.

import { Api } from "@awthaq/api";
import { AuthEvents, RateLimits, Sessions, Tenant, Verification } from "@awthaq/core";
import { RateLimiter, XmlSignature } from "@awthaq/ports";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { inflateRawSync } from "node:zlib";
import * as SamlApi from "./SamlApi.ts";
import * as SamlConfig from "./SamlConfig.ts";
import { trustSetOf } from "./SamlConnections.ts";
import * as SamlKeys from "./SamlKeys.ts";
import * as SamlLogout from "./SamlLogout.ts";
import { logoutRequestXml, logoutResponseXml, postFormHtml, redirectUrl } from "./SamlProtocol.ts";
import type * as SamlRecords from "./SamlRecords.ts";
import * as SamlSpKeys from "./SamlSpKeys.ts";

export const LOGOUT_COOKIE = "__Host-saml-logout";
const LOGOUT_PREFIX = "saml-logout:";
const MESSAGE_PREFIX = "saml-logout-message:";

const LogoutState = Schema.Struct({
  connectionId: Schema.String,
  requestId: Schema.String,
  callbackURL: Schema.String,
});
const decodeLogoutState = Schema.decodeUnknownOption(LogoutState);

/** What an inbound message needs, gathered by the handler: the raw parts of whichever binding it arrived by. */
export interface SloInput {
  readonly connectionId: string;
  readonly binding: "redirect" | "post";
  /** Redirect only: the request URL's raw query string (without the `?`), the octets the signature covers are rebuilt from it. */
  readonly rawQuery: string | undefined;
  readonly samlRequest: string | undefined;
  readonly samlResponse: string | undefined;
  readonly relayState: string | undefined;
  /** The `__Host-saml-logout` cookie, if the browser sent one (a LogoutResponse must carry it). */
  readonly cookieState: string | undefined;
  readonly ip: string | undefined;
}

/** What the handler does with the browser next. */
export type SloOutcome =
  | { readonly _tag: "redirect"; readonly location: string }
  | { readonly _tag: "postForm"; readonly html: string }
  /** Our own logout finished at the IdP: back to the application. */
  | { readonly _tag: "done"; readonly callbackURL: string };

export type LogoutStart =
  | { readonly _tag: "local"; readonly callbackURL: string }
  | (SloOutcome & { readonly _tag: "redirect" | "postForm" } & {
      readonly state: Redacted.Redacted<string>;
    });

const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** The raw (still URL-encoded) value of a query parameter, first occurrence. */
const rawParam = (rawQuery: string, name: string): string | undefined => {
  for (const pair of rawQuery.split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (pair.slice(0, eq) === name) return pair.slice(eq + 1);
  }
  return undefined;
};

/** Everything `makeSlo` builds on, injected by `Saml.make` (which owns the services and the connection lookup). */
export interface SloDeps {
  readonly settings: SamlConfig.SamlConfigShape;
  readonly usableConnection: (
    connectionId: string,
  ) => Effect.Effect<Option.Option<SamlRecords.ConnectionRecord>>;
  readonly records: SamlRecords.SamlRecordsShape;
  readonly sessions: Sessions.SessionsShape;
  readonly verification: Verification.VerificationShape;
  readonly events: AuthEvents.AuthEventsShape;
  readonly xmlSignature: XmlSignature.XmlSignatureShape;
  readonly spKeys: SamlSpKeys.SamlSpKeysShape;
  readonly crypto: Crypto.Crypto;
  readonly limiter: RateLimiter.RateLimiterShape;
  readonly resolveCallbackURL: (raw: string | undefined) => string;
}

export const makeSlo = (deps: SloDeps) => {
  const { settings, records, sessions, verification, events, xmlSignature, spKeys, crypto } = deps;

  const rateLimit = (ip: string | undefined) =>
    RateLimits.enforce({
      key: `saml:slo:${ip ?? "unknown"}`,
      limit: settings.rateLimits.slo.limit,
      window: settings.rateLimits.slo.window,
      meta: { group: "saml", endpoint: "slo", rule: "slo", dimension: "ip" },
    }).pipe(
      Effect.provideService(RateLimiter.RateLimiter, deps.limiter),
      Effect.provideService(AuthEvents.AuthEvents, events),
      Effect.catchTag(
        "RateLimitExceeded",
        (error) => new Api.RateLimited({ retryAfterMillis: error.retryAfterMillis }),
      ),
    );

  /** Signs and encodes one outbound message for the IdP's binding, with the SP key when the connection has one. */
  const outbound = Effect.fnUntraced(function* (input: {
    readonly connection: SamlRecords.ConnectionRecord;
    readonly kind: "SAMLRequest" | "SAMLResponse";
    readonly xml: string;
    readonly referenceId: string;
    readonly relayState: string | undefined;
  }) {
    const destination = Option.getOrThrow(input.connection.sloUrl);
    const key = yield* spKeys.signingKey(input.connection.id);
    if (input.connection.sloBinding === "post") {
      const signed = Option.isSome(key)
        ? SamlKeys.signXml({
            xml: input.xml,
            referenceId: input.referenceId,
            privateKeyPem: Redacted.value(key.value.privateKeyPem),
          })
        : input.xml;
      return {
        _tag: "postForm" as const,
        html: postFormHtml({
          destination,
          kind: input.kind,
          xml: signed,
          relayState: input.relayState,
        }),
      };
    }
    return {
      _tag: "redirect" as const,
      location: redirectUrl({
        endpoint: destination,
        kind: input.kind,
        xml: input.xml,
        relayState: input.relayState,
        signWith: Option.isSome(key) ? Redacted.value(key.value.privateKeyPem) : undefined,
      }),
    };
  });

  // ---- SP-initiated -----------------------------------------------------------------------------

  const logout = Effect.fnUntraced(function* (
    caller: Api.UserPrincipal,
    input: { readonly callbackURL?: string | undefined; readonly ip?: string | undefined },
  ) {
    const callbackURL = deps.resolveCallbackURL(input.callbackURL);
    const sessionId = Sessions.SessionId(caller.sessionId);
    const row = yield* records.findSession(sessionId);
    const owner = Option.isNone(row)
      ? Option.none()
      : yield* records.findById(row.value.connectionId);
    // The local session ends first, whatever the IdP does or says next, and as the connection's tenant (like the IdP's own request).
    const revoke = sessions
      .revoke(sessionId, "signOut")
      .pipe(Effect.catchTag("Sessions/NotFound", () => Effect.void));
    yield* Option.isSome(owner) && settings.tenantScoped
      ? revoke.pipe(Tenant.withTenant(owner.value.organizationId))
      : revoke;
    if (Option.isNone(row)) return { _tag: "local", callbackURL } as const;
    yield* records.removeSession(sessionId);
    const connection = yield* deps.usableConnection(row.value.connectionId);
    if (Option.isNone(connection) || Option.isNone(connection.value.sloUrl)) {
      return { _tag: "local", callbackURL } as const;
    }
    const uuid = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
    const requestId = `_${uuid}`;
    const identifier = `${LOGOUT_PREFIX}${uuid}`;
    const { value } = yield* verification.issue({
      identifier,
      ttl: settings.requestTtl,
      payload: { connectionId: connection.value.id, requestId, callbackURL },
    });
    const now = yield* DateTime.now;
    const xml = logoutRequestXml({
      id: requestId,
      issueInstant: now,
      destination: connection.value.sloUrl.value,
      issuer: settings.spEntityId(connection.value.id),
      nameId: { value: row.value.nameId, format: Option.getOrUndefined(row.value.nameIdFormat) },
      sessionIndex: Option.getOrUndefined(row.value.sessionIndex),
    });
    const sent = yield* outbound({
      connection: connection.value,
      kind: "SAMLRequest",
      xml,
      referenceId: requestId,
      relayState: undefined,
    });
    return { ...sent, state: Redacted.make(`${identifier}.${Redacted.value(value)}`) } as const;
  });

  // ---- inbound ----------------------------------------------------------------------------------

  /** Refuses an over-long base64 before decoding it and an inflation past the cap (the decompression-bomb guard). */
  const decodeMessage = Effect.fnUntraced(function* (encoded: string, deflated: boolean) {
    const compact = encoded.replace(/\s+/g, "");
    if (compact.length > Math.ceil((settings.maxResponseBytes * 4) / 3) + 4) {
      return yield* Effect.fail(new SamlLogout.LogoutInvalid({ reason: "tooLarge" }));
    }
    const bytes = Buffer.from(compact, "base64");
    if (bytes.length === 0)
      return yield* Effect.fail(new SamlLogout.LogoutInvalid({ reason: "notBase64" }));
    return yield* Effect.try({
      try: () =>
        new TextDecoder("utf-8", { fatal: true }).decode(
          deflated ? inflateRawSync(bytes, { maxOutputLength: settings.maxResponseBytes }) : bytes,
        ),
      catch: () => new SamlLogout.LogoutInvalid({ reason: deflated ? "inflateFailed" : "notUtf8" }),
    });
  });

  /**
   * Verifies the message by its binding and returns the XML to read: the port's signed bytes for POST, the inflated XML of a
   * query whose signature verified for Redirect.
   */
  const verified = Effect.fnUntraced(function* (
    input: SloInput,
    connection: SamlRecords.ConnectionRecord,
    kind: "SAMLRequest" | "SAMLResponse",
    root: XmlSignature.ElementName,
  ) {
    const encoded = kind === "SAMLRequest" ? input.samlRequest : input.samlResponse;
    if (encoded === undefined)
      return yield* Effect.fail(new SamlLogout.LogoutInvalid({ reason: "noMessage" }));
    if (input.binding === "post") {
      const xml = yield* decodeMessage(encoded, false);
      const result = yield* xmlSignature
        .verify({
          xml,
          trust: trustSetOf(connection),
          policy: {
            maxBytes: settings.maxResponseBytes,
            signedElements: [root],
            exactlyOne: [root],
          },
        })
        .pipe(
          Effect.mapError(
            (error) => new SamlLogout.LogoutInvalid({ reason: `signature:${error.reason}` }),
          ),
        );
      return result.signedXml;
    }
    // Redirect: the signature is over the raw parameters the sender encoded.
    const raw = input.rawQuery ?? "";
    const rawMessage = rawParam(raw, kind);
    const rawSigAlg = rawParam(raw, "SigAlg");
    const rawSignature = rawParam(raw, "Signature");
    if (rawMessage === undefined || rawSigAlg === undefined || rawSignature === undefined) {
      // An unsigned message: a logout endpoint that accepted these would let anyone end anyone's sessions.
      return yield* Effect.fail(new SamlLogout.LogoutInvalid({ reason: "unsigned" }));
    }
    const rawRelay = rawParam(raw, "RelayState");
    const octets = SamlKeys.redirectSignedOctets({
      kind,
      message: rawMessage,
      relayState: rawRelay,
      sigAlg: rawSigAlg,
    });
    const now = yield* DateTime.now;
    const decoded = (value: string) => {
      try {
        return decodeURIComponent(value);
      } catch {
        return "";
      }
    };
    const ok = SamlKeys.verifyRedirect({
      octets,
      signature: decoded(rawSignature),
      sigAlg: decoded(rawSigAlg),
      trust: trustSetOf(connection),
      now,
    });
    if (!ok)
      return yield* Effect.fail(
        new SamlLogout.LogoutInvalid({ reason: "signature:invalidSignature" }),
      );
    // The signature covers exactly these octets; the message is the same string, URL-decoded.
    return yield* decodeMessage(decoded(rawMessage), true);
  });

  const expectations = Effect.fnUntraced(function* (connection: SamlRecords.ConnectionRecord) {
    return {
      idpEntityId: connection.idpEntityId,
      sloUrl: SamlConfig.sloUrl(settings, connection.id),
      now: yield* DateTime.now,
      skewMillis: Duration.toMillis(settings.clockSkew),
      freshnessMillis:
        Duration.toMillis(settings.logoutFreshness) + Duration.toMillis(settings.clockSkew),
    };
  });

  /** One-time message id: a replayed capture of a valid LogoutRequest cannot end the user's sessions again. */
  const acceptOnce = Effect.fnUntraced(function* (
    connection: SamlRecords.ConnectionRecord,
    id: string,
  ) {
    const digest = hexOf(
      yield* crypto
        .digest("SHA-256", new TextEncoder().encode(`${connection.idpEntityId}|${id}`))
        .pipe(Effect.orDie),
    );
    const fresh = yield* verification.reserve({
      identifier: `${MESSAGE_PREFIX}${digest}`,
      ttl: Duration.millis(
        2 * Duration.toMillis(settings.logoutFreshness) + 2 * Duration.toMillis(settings.clockSkew),
      ),
    });
    if (!fresh) return yield* Effect.fail(new SamlLogout.LogoutInvalid({ reason: "replayed" }));
  });

  const revokeFor = Effect.fnUntraced(function* (
    connection: SamlRecords.ConnectionRecord,
    request: SamlLogout.LogoutRequestData,
  ) {
    const indexes = request.sessionIndexes;
    const found =
      indexes.length === 0
        ? yield* records.findSessions({ connectionId: connection.id, nameId: request.nameId.value })
        : (yield* Effect.forEach(indexes, (sessionIndex) =>
            records.findSessions({
              connectionId: connection.id,
              nameId: request.nameId.value,
              sessionIndex,
            }),
          )).flat();
    const revoke = Effect.forEach(
      found,
      (row) =>
        sessions.revoke(Sessions.SessionId(row.sessionId), "federatedLogout").pipe(
          Effect.catchTag("Sessions/NotFound", () => Effect.void),
          Effect.andThen(records.removeSession(row.sessionId)),
        ),
      { discard: true },
    );
    yield* settings.tenantScoped
      ? revoke.pipe(Tenant.withTenant(connection.organizationId))
      : revoke;
    return found.length;
  });

  const slo = Effect.fnUntraced(function* (input: SloInput) {
    yield* rateLimit(input.ip);
    let strategy = "saml";
    const reject = (reason: string) =>
      Effect.all(
        [
          Effect.logWarning("awthaq/saml: logout message rejected", { reason }),
          events.publish({ _tag: "auth.saml.logoutRejected", strategy }),
        ],
        { discard: true },
      ).pipe(Effect.andThen(Effect.fail(new SamlApi.SamlLogoutRejected())));

    const chain = Effect.gen(function* () {
      const found = yield* deps.usableConnection(input.connectionId);
      if (Option.isNone(found))
        return yield* Effect.fail(
          new SamlLogout.LogoutInvalid({ reason: "connectionUnavailable" }),
        );
      const connection = found.value;
      strategy = `saml:${connection.organizationId}:${connection.id}`;
      // Exactly one of the two messages, and only where the connection has a logout endpoint to answer (or return from).
      if ((input.samlRequest === undefined) === (input.samlResponse === undefined)) {
        return yield* Effect.fail(new SamlLogout.LogoutInvalid({ reason: "notExactlyOneMessage" }));
      }
      if (Option.isNone(connection.sloUrl)) {
        return yield* Effect.fail(new SamlLogout.LogoutInvalid({ reason: "noLogoutEndpoint" }));
      }
      const expected = yield* expectations(connection);

      if (input.samlRequest !== undefined) {
        // The IdP asks this SP to end a user's sessions.
        const xml = yield* verified(input, connection, "SAMLRequest", SamlLogout.LOGOUT_REQUEST);
        const request = yield* SamlLogout.readLogoutRequest(xml).pipe(
          Effect.flatMap((data) => SamlLogout.validateLogoutRequest(data, expected)),
        );
        yield* acceptOnce(connection, request.id);
        const ended = yield* revokeFor(connection, request);
        yield* Effect.logInfo("awthaq/saml: single logout by the IdP", {
          connectionId: connection.id,
          sessionsEnded: ended,
        });
        const uuid = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
        const now = yield* DateTime.now;
        const responseId = `_${uuid}`;
        const response = logoutResponseXml({
          id: responseId,
          issueInstant: now,
          destination: connection.sloUrl.value,
          issuer: settings.spEntityId(connection.id),
          inResponseTo: request.id,
          success: true,
        });
        return yield* outbound({
          connection,
          kind: "SAMLResponse",
          xml: response,
          referenceId: responseId,
          relayState: input.relayState,
        });
      }

      // The IdP answers a logout this SP started: the state cookie names it, single-use, and the response must answer it.
      const cookie = input.cookieState;
      if (cookie === undefined)
        return yield* Effect.fail(new SamlLogout.LogoutInvalid({ reason: "noLogoutState" }));
      const dot = cookie.indexOf(".");
      const identifier = dot < 0 ? "" : cookie.slice(0, dot);
      const secret = dot < 0 ? "" : cookie.slice(dot + 1);
      if (!identifier.startsWith(LOGOUT_PREFIX) || secret === "") {
        return yield* Effect.fail(new SamlLogout.LogoutInvalid({ reason: "logoutStateMalformed" }));
      }
      const consumed = yield* verification
        .consume(identifier, Redacted.make(secret))
        .pipe(
          Effect.catchTag("Verification/TokenConsumed", () =>
            Effect.fail(new SamlLogout.LogoutInvalid({ reason: "logoutStateUnknownOrConsumed" })),
          ),
        );
      const state = decodeLogoutState(consumed.payload);
      if (Option.isNone(state) || state.value.connectionId !== connection.id) {
        return yield* Effect.fail(new SamlLogout.LogoutInvalid({ reason: "logoutStateMismatch" }));
      }
      const xml = yield* verified(input, connection, "SAMLResponse", SamlLogout.LOGOUT_RESPONSE);
      const response = yield* SamlLogout.readLogoutResponse(xml).pipe(
        Effect.flatMap((data) =>
          SamlLogout.validateLogoutResponse(data, {
            ...expected,
            inResponseTo: state.value.requestId,
          }),
        ),
      );
      if (!response.succeeded) {
        yield* Effect.logWarning(
          "awthaq/saml: the IdP reported a failed logout; the local session was already ended",
          {
            connectionId: connection.id,
          },
        );
      }
      return { _tag: "done" as const, callbackURL: state.value.callbackURL };
    });

    return yield* chain.pipe(Effect.catchTag("LogoutInvalid", (invalid) => reject(invalid.reason)));
  });

  return { slo, logout, rateLimit };
};
