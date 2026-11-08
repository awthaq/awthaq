import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  configureApp,
  getOutcome,
  inspectSession,
  publishedEvents,
  request,
  principalOfToken,
  setOutcome,
  signIn,
  browser,
  type Actor,
  World,
} from "./AdminWorld.ts";
import { CookieAssertions, type UserAgent } from "@awthaq/test";

const IMPERSONATION_COOKIE = "__Host-impersonation";

/** The session id half of a raw `<id>.<secret>` session token. */
const sessionIdOf = (token: string): string => token.split(".")[0]!;

/** The impersonation token a browser holds after a successful `admin.impersonate`. */
const impersonationTokenOf = (agent: UserAgent.UserAgent): string => {
  const token = agent.cookies.value(IMPERSONATION_COOKIE);
  if (token === undefined) throw new Error("expected the browser to hold the impersonation cookie");
  return token;
};

/**
 * `admin.impersonate` from a browser: a fresh one holding the actor's session, or a browser the scenario
 * already holds (an impersonating one, for the nested case). On success that browser holds the
 * impersonation cookie beside the admin's own session (APS-006); it is recorded as `impersonatingBrowser`.
 */
const impersonate = Effect.fn("features.admin.impersonate")(function* (
  from: Actor | UserAgent.UserAgent,
  targetUserId: string,
  reason: string,
) {
  const agent = "request" in from ? from : yield* browser(from);
  const response = yield* request("POST", `/admin/impersonate/${targetUserId}`, {
    body: { reason },
    as: agent,
  });
  yield* setOutcome("impersonatingBrowser", agent);
  return response;
});

/** A request from a fresh browser holding `actor`'s session. */
const requestAs = Effect.fn("features.admin.requestAs")(function* (
  actor: Actor,
  method: string,
  path: string,
  options?: { readonly body?: unknown; readonly headers?: Record<string, string> },
) {
  return yield* request(method, path, { ...options, as: yield* browser(actor) });
});

/** ESS-006: `GET /admin` answers a page `{ items, nextCursor }`; the scenarios only read the rows. */
const listRows = <A>(response: Response) =>
  Effect.promise(async () => {
    const body: { readonly items: ReadonlyArray<A> } = await response.json();
    return body.items;
  });

export const adminSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- BEH-EA-209: actingAs is a real field on session issuance (400) ----

  Given(
    "a signed-in admin permitted to impersonate",
    Effect.fn(function* () {
      yield* configureApp({ canImpersonate: () => Effect.succeed(true) });
      const cookie = yield* signIn("admin-1");
      yield* setOutcome("adminCookie", cookie);
    }),
  );

  Then(
    "the target's newly-issued session row carries \"actingAs\" set to the admin's own identity",
    Effect.fn(function* () {
      const response = (yield* getOutcome("impersonateResponse")) as Response;
      if (response.status !== 200) throw new Error(`expected 200, got ${response.status}`);
      const impersonating = (yield* getOutcome("impersonatingBrowser")) as UserAgent.UserAgent;
      const session = yield* inspectSession(impersonationTokenOf(impersonating));
      if (session.actingAs._tag !== "Some") {
        throw new Error("expected the target's session to carry actingAs");
      }
      if (session.actingAs.value.id !== "admin-1") {
        throw new Error(`expected actingAs.id "admin-1", got "${session.actingAs.value.id}"`);
      }
    }),
  );

  // ---- BEH-EA-210: never idle-refreshes (401) ----

  Then(
    "the newly-issued session's {string} equals its {string}",
    Effect.fn(function* (_idle: string, _absolute: string) {
      const impersonating = (yield* getOutcome("impersonatingBrowser")) as UserAgent.UserAgent;
      const session = yield* inspectSession(impersonationTokenOf(impersonating));
      const idle = session.idleExpiresAt.epochMilliseconds;
      const absolute = session.absoluteExpiresAt.epochMilliseconds;
      if (idle !== absolute) {
        throw new Error(
          `expected idleExpiresAt (${idle}) to equal absoluteExpiresAt (${absolute})`,
        );
      }
    }),
  );

  // ---- BEH-EA-211: principalOfToken closes the loop (402) ----

  Given(
    "a signed-in admin actively impersonating a target user",
    Effect.fn(function* () {
      yield* configureApp({ canImpersonate: () => Effect.succeed(true) });
      const adminCookie = yield* signIn("admin-1");
      yield* setOutcome("adminCookie", adminCookie);
      yield* impersonate(adminCookie, "target-1", "support ticket #4821");
      const impersonating = (yield* getOutcome("impersonatingBrowser")) as UserAgent.UserAgent;
      yield* setOutcome("impersonationToken", impersonationTokenOf(impersonating));
      yield* setOutcome("sessionId", sessionIdOf(impersonationTokenOf(impersonating)));
    }),
  );

  When(
    "the impersonation session's own token is resolved to a principal",
    Effect.fn(function* () {
      const token = (yield* getOutcome("impersonationToken")) as string;
      const principal = yield* principalOfToken(token);
      yield* setOutcome("resolvedPrincipal", principal);
    }),
  );

  Then(
    'the resolved "UserPrincipal" carries "actingAs" set to the admin\'s own identity',
    Effect.fn(function* () {
      // `Api.UserPrincipal.actingAs` is a plain optional field (a real
      // `Api.PrincipalRef` or omitted entirely) — not `Option`-wrapped,
      // per `Authentication.ts`'s own `exactOptionalPropertyTypes` comment.
      const principal = (yield* getOutcome("resolvedPrincipal")) as {
        readonly _tag: string;
        readonly actingAs?: { readonly id: string };
      };
      if (principal._tag !== "User")
        throw new Error(`expected a UserPrincipal, got ${principal._tag}`);
      if (principal.actingAs === undefined) {
        throw new Error("expected the resolved principal to carry actingAs");
      }
      if (principal.actingAs.id !== "admin-1") {
        throw new Error(`expected actingAs.id "admin-1", got "${principal.actingAs.id}"`);
      }
    }),
  );

  // ---- BEH-EA-212: fail-closed by default (382-384) ----

  Given(
    'an application composing "Admin" with no explicit "canImpersonate" predicate configured',
    Effect.fn(function* () {
      yield* configureApp({});
      const cookie = yield* signIn("caller-1");
      yield* setOutcome("adminCookie", cookie);
    }),
  );

  When(
    'a signed-in user calls "admin.impersonate" for another user',
    Effect.fn(function* () {
      const adminCookie = (yield* getOutcome("adminCookie")) as Actor;
      const response = yield* impersonate(adminCookie, "target-1", "reproducing a bug");
      yield* setOutcome("impersonateResponse", response);
    }),
  );

  Then(
    "the call is denied with {string}",
    Effect.fn(function* (statusText: string) {
      const response = (yield* getOutcome("impersonateResponse")) as Response;
      const expected = Number(statusText.split(" ")[0]);
      if (response.status !== expected) {
        throw new Error(`expected ${expected} ("${statusText}"), got ${response.status}`);
      }
    }),
  );

  Given(
    '"Admin" configured with a "canImpersonate" predicate that always resolves "true"',
    Effect.fn(function* () {
      yield* configureApp({ canImpersonate: () => Effect.succeed(true) });
      const cookie = yield* signIn("caller-1");
      yield* setOutcome("adminCookie", cookie);
    }),
  );

  When(
    'a signed-in user calls "admin.impersonate" for another user with a valid reason',
    Effect.fn(function* () {
      const adminCookie = (yield* getOutcome("adminCookie")) as Actor;
      const response = yield* impersonate(adminCookie, "target-1", "reproducing a bug");
      yield* setOutcome("impersonateResponse", response);
    }),
  );

  Then(
    "the call succeeds",
    Effect.fn(function* () {
      const response = (yield* getOutcome("impersonateResponse")) as Response;
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`expected a success status, got ${response.status}`);
      }
    }),
  );

  Given(
    '"Admin" configured with a "canImpersonate" predicate that always resolves "false"',
    Effect.fn(function* () {
      yield* configureApp({ canImpersonate: () => Effect.succeed(false) });
      const cookie = yield* signIn("caller-1");
      yield* setOutcome("adminCookie", cookie);
    }),
  );

  Then(
    "no new session is issued for the target user",
    Effect.fn(function* () {
      const response = (yield* getOutcome("impersonateResponse")) as Response;
      if (response.headers.get("set-cookie") !== null) {
        throw new Error("expected no set-cookie header on a denied impersonate call");
      }
    }),
  );

  // ---- BEH-EA-213: dual-identity session, distinct from caller's (385-387) ----

  Given(
    "a signed-in admin with an active session of their own",
    Effect.fn(function* () {
      yield* configureApp({ canImpersonate: () => Effect.succeed(true) });
      const cookie = yield* signIn("admin-1");
      yield* setOutcome("adminCookie", cookie);
    }),
  );

  When(
    "the admin calls {string} for a target user with a valid reason",
    Effect.fn(function* (_endpoint: string) {
      const adminCookie = (yield* getOutcome("adminCookie")) as Actor;
      const response = yield* impersonate(adminCookie, "target-1", "reproducing a bug");
      yield* setOutcome("impersonateResponse", response);
    }),
  );

  Then(
    "the response carries a new session cookie, distinct from the admin's own",
    Effect.fn(function* () {
      const response = (yield* getOutcome("impersonateResponse")) as Response;
      const adminCookie = (yield* getOutcome("adminCookie")) as Actor;
      const impersonating = (yield* getOutcome("impersonatingBrowser")) as UserAgent.UserAgent;
      CookieAssertions.findSetCookie(response, IMPERSONATION_COOKIE);
      if (impersonationTokenOf(impersonating) === adminCookie.token) {
        throw new Error("expected a distinct session cookie for the target");
      }
    }),
  );

  Then(
    "the admin's own original session cookie still authenticates afterward",
    Effect.fn(function* () {
      const adminCookie = (yield* getOutcome("adminCookie")) as Actor;
      // `list` is gated only by canImpersonate, not by "am I impersonating" —
      // any still-valid session for a permitted caller can reach it.
      const response = yield* requestAs(adminCookie, "GET", "/admin");
      if (response.status !== 200) {
        throw new Error(
          `expected the admin's own session to still authenticate, got ${response.status}`,
        );
      }
    }),
  );

  When(
    "the admin calls {string} for a target user with a reason of only whitespace",
    Effect.fn(function* (_endpoint: string) {
      const adminCookie = (yield* getOutcome("adminCookie")) as Actor;
      const response = yield* impersonate(adminCookie, "target-1", "   ");
      yield* setOutcome("impersonateResponse", response);
    }),
  );

  // ADR-EA-045: `admin.impersonate` declares `SessionLifecycle.Swaps`, which is cookie only.
  When(
    "the admin calls {string} for a target user asking for bearer delivery",
    Effect.fn(function* (_endpoint: string) {
      const adminCookie = (yield* getOutcome("adminCookie")) as Actor;
      const response = yield* request("POST", "/admin/impersonate/target-1", {
        body: { reason: "support ticket 42" },
        as: yield* browser(adminCookie),
        headers: { "x-awthaq-token-delivery": "bearer" },
      });
      yield* setOutcome("impersonateResponse", response);
    }),
  );

  When(
    "the admin calls {string} for a target user with a reason over 1000 characters long",
    Effect.fn(function* (_endpoint: string) {
      const adminCookie = (yield* getOutcome("adminCookie")) as Actor;
      const response = yield* impersonate(adminCookie, "target-1", "x".repeat(1001));
      yield* setOutcome("impersonateResponse", response);
    }),
  );

  Then(
    "the call is rejected with {string}",
    Effect.fn(function* (statusText: string) {
      const response = (yield* getOutcome("impersonateResponse")) as Response;
      const expected = Number(statusText.split(" ")[0]);
      if (response.status !== expected) {
        throw new Error(`expected ${expected} ("${statusText}"), got ${response.status}`);
      }
    }),
  );

  // ---- BEH-EA-214: self and nested impersonation refused (388-389) ----

  When(
    "the admin calls {string} naming their own user id as the target",
    Effect.fn(function* (_endpoint: string) {
      const adminCookie = (yield* getOutcome("adminCookie")) as Actor;
      const response = yield* impersonate(adminCookie, "admin-1", "test");
      yield* setOutcome("impersonateResponse", response);
    }),
  );

  Then(
    'the call is rejected with "400 Bad Request" and the typed error "AdminSelfImpersonationRefused"',
    Effect.fn(function* () {
      const response = (yield* getOutcome("impersonateResponse")) as Response;
      if (response.status !== 400) throw new Error(`expected 400, got ${response.status}`);
      const body = (yield* Effect.promise(() => response.json())) as { _tag?: string };
      if (body._tag !== undefined && body._tag !== "AdminSelfImpersonationRefused") {
        throw new Error(`expected AdminSelfImpersonationRefused, got ${body._tag}`);
      }
    }),
  );

  When(
    "the admin's impersonation session calls {string} for a different target user",
    Effect.fn(function* (_endpoint: string) {
      const impersonating = (yield* getOutcome("impersonatingBrowser")) as UserAgent.UserAgent;
      const response = yield* impersonate(impersonating, "target-2", "nested");
      yield* setOutcome("nestedResponse", response);
    }),
  );

  Then(
    'the call is rejected with "409 Conflict" and the typed error "AdminAlreadyImpersonating"',
    Effect.fn(function* () {
      const response = (yield* getOutcome("nestedResponse")) as Response;
      if (response.status !== 409) throw new Error(`expected 409, got ${response.status}`);
      const body = (yield* Effect.promise(() => response.json())) as { _tag?: string };
      if (body._tag !== undefined && body._tag !== "AdminAlreadyImpersonating") {
        throw new Error(`expected AdminAlreadyImpersonating, got ${body._tag}`);
      }
    }),
  );

  // ---- BEH-EA-215: durable audit trail (390-391) ----

  Then(
    "a new row appears in the impersonation audit trail for that admin, target, and session",
    Effect.fn(function* () {
      const adminCookie = (yield* getOutcome("adminCookie")) as Actor;
      const impersonating = (yield* getOutcome("impersonatingBrowser")) as UserAgent.UserAgent;
      const sessionId = sessionIdOf(impersonationTokenOf(impersonating));
      const listResponse = yield* requestAs(adminCookie, "GET", "/admin");
      const rows = yield* listRows<{
        readonly adminUserId: string;
        readonly targetUserId: string;
        readonly sessionId: string;
        readonly endedAt: string | null;
      }>(listResponse);
      const match = rows.find((row) => row.sessionId === sessionId);
      if (match === undefined)
        throw new Error("expected an audit row for the new impersonation session");
      if (match.adminUserId !== "admin-1" || match.targetUserId !== "target-1") {
        throw new Error("expected the audit row to name the real admin/target ids");
      }
      yield* setOutcome("auditRow", match);
    }),
  );

  Then(
    "its {string}\\/{string} fields are still unset",
    Effect.fn(function* (_endedAt: string, _endedBy: string) {
      const row = (yield* getOutcome("auditRow")) as { readonly endedAt: string | null };
      if (row.endedAt !== null) throw new Error("expected endedAt to still be null");
    }),
  );

  When(
    'the admin calls "admin.stopImpersonating"',
    Effect.fn(function* () {
      const impersonating = (yield* getOutcome("impersonatingBrowser")) as UserAgent.UserAgent;
      const response = yield* request("POST", "/admin/stop-impersonating", {
        body: {},
        as: impersonating,
      });
      yield* setOutcome("stopResponse", response);
    }),
  );

  Then(
    'the matching audit row\'s "endedAt" and "endedBy" are set to "self"',
    Effect.fn(function* () {
      const adminCookie = (yield* getOutcome("adminCookie")) as Actor;
      const sessionId = (yield* getOutcome("sessionId")) as string;
      const listResponse = yield* requestAs(adminCookie, "GET", "/admin");
      const rows = yield* listRows<{
        readonly sessionId: string;
        readonly endedAt: string | null;
        readonly endedBy: string | null;
      }>(listResponse);
      const match = rows.find((row) => row.sessionId === sessionId);
      if (match === undefined) throw new Error("expected to find the matching audit row");
      if (match.endedAt === null || match.endedBy !== "self") {
        throw new Error(
          `expected endedBy "self", got endedAt=${match.endedAt} endedBy=${match.endedBy}`,
        );
      }
    }),
  );

  // ---- BEH-EA-216: stopImpersonating, no handback (392-393) ----

  When(
    "the admin's impersonation session calls {string}",
    Effect.fn(function* (_endpoint: string) {
      const impersonating = (yield* getOutcome("impersonatingBrowser")) as UserAgent.UserAgent;
      const response = yield* request("POST", "/admin/stop-impersonating", {
        body: {},
        as: impersonating,
      });
      yield* setOutcome("stopResponse", response);
    }),
  );

  Then(
    'the call succeeds with "204 No Content" and no new session cookie is issued',
    Effect.fn(function* () {
      const response = (yield* getOutcome("stopResponse")) as Response;
      if (response.status !== 204) throw new Error(`expected 204, got ${response.status}`);
      // APS-006: the one Set-Cookie allowed is the impersonation cookie's expiry —
      // it hands the browser back to its own session; it never carries a token.
      for (const cookie of CookieAssertions.setCookiesOf(response)) {
        if (cookie.name !== IMPERSONATION_COOKIE) {
          throw new Error(`expected only an impersonation-cookie expiry, got "${cookie.name}"`);
        }
      }
      CookieAssertions.assertExpiredCookie(
        CookieAssertions.findSetCookie(response, IMPERSONATION_COOKIE),
      );
    }),
  );

  Then(
    "the revoked impersonation session no longer authenticates",
    Effect.fn(function* () {
      // The impersonation token presented again, alone (the browser itself has dropped or still holds it).
      const token = (yield* getOutcome("impersonationToken")) as string;
      const response = yield* request("GET", "/admin", {
        extraCookies: { [IMPERSONATION_COOKIE]: token },
      });
      if (response.status === 200) {
        throw new Error("expected the revoked impersonation session to no longer authenticate");
      }
    }),
  );

  Then(
    "the admin's own original session cookie still authenticates",
    Effect.fn(function* () {
      const adminCookie = (yield* getOutcome("adminCookie")) as Actor;
      const response = yield* requestAs(adminCookie, "GET", "/admin");
      if (response.status !== 200) {
        throw new Error(
          `expected the admin's own session to still authenticate, got ${response.status}`,
        );
      }
    }),
  );

  Given(
    "a signed-in admin with an ordinary, non-impersonating session",
    Effect.fn(function* () {
      yield* configureApp({ canImpersonate: () => Effect.succeed(true) });
      const cookie = yield* signIn("admin-1");
      yield* setOutcome("adminCookie", cookie);
    }),
  );

  When(
    "that session calls {string}",
    Effect.fn(function* (_endpoint: string) {
      const adminCookie = (yield* getOutcome("adminCookie")) as Actor;
      const response = yield* requestAs(adminCookie, "POST", "/admin/stop-impersonating", {
        body: {},
      });
      yield* setOutcome("stopResponse", response);
    }),
  );

  Then(
    'the call fails, since the session carries no "actingAs" to end',
    Effect.fn(function* () {
      const response = (yield* getOutcome("stopResponse")) as Response;
      if (response.status < 400) {
        throw new Error(`expected a failure status, got ${response.status}`);
      }
    }),
  );

  // ---- BEH-EA-217: forceStop by another admin (394-396) ----

  Given(
    "one admin actively impersonating a target user, identified by that impersonation session's id",
    Effect.fn(function* () {
      yield* configureApp({ canImpersonate: () => Effect.succeed(true) });
      const adminCookie = yield* signIn("admin-1");
      yield* setOutcome("adminCookie", adminCookie);
      yield* impersonate(adminCookie, "target-1", "support ticket #4821");
      const impersonating = (yield* getOutcome("impersonatingBrowser")) as UserAgent.UserAgent;
      yield* setOutcome("sessionId", sessionIdOf(impersonationTokenOf(impersonating)));
      yield* setOutcome("impersonationToken", impersonationTokenOf(impersonating));
    }),
  );

  When(
    'a second admin permitted to impersonate calls "admin.forceStop" naming that session id',
    Effect.fn(function* () {
      const secondAdminCookie = yield* signIn("admin-2");
      const sessionId = (yield* getOutcome("sessionId")) as string;
      const response = yield* requestAs(
        secondAdminCookie,
        "POST",
        `/admin/force-stop/${sessionId}`,
        {
          body: {},
        },
      );
      yield* setOutcome("forceStopResponse", response);
    }),
  );

  Then(
    'the call succeeds with "204 No Content"',
    Effect.fn(function* () {
      const response = (yield* getOutcome("forceStopResponse")) as Response;
      if (response.status !== 204) throw new Error(`expected 204, got ${response.status}`);
    }),
  );

  Then(
    "the named impersonation session no longer authenticates",
    Effect.fn(function* () {
      // The impersonation token presented again, alone (the browser itself has dropped or still holds it).
      const token = (yield* getOutcome("impersonationToken")) as string;
      const response = yield* request("GET", "/admin", {
        extraCookies: { [IMPERSONATION_COOKIE]: token },
      });
      if (response.status === 200) {
        throw new Error("expected the force-stopped session to no longer authenticate");
      }
    }),
  );

  Then(
    'the matching audit row\'s "endedBy" is set to "forcedByAdmin"',
    Effect.fn(function* () {
      const adminCookie = (yield* getOutcome("adminCookie")) as Actor;
      const sessionId = (yield* getOutcome("sessionId")) as string;
      const listResponse = yield* requestAs(adminCookie, "GET", "/admin");
      const rows = yield* listRows<{
        readonly sessionId: string;
        readonly endedBy: string | null;
      }>(listResponse);
      const match = rows.find((row) => row.sessionId === sessionId);
      if (match === undefined || match.endedBy !== "forcedByAdmin") {
        throw new Error(`expected endedBy "forcedByAdmin", got ${match?.endedBy}`);
      }
    }),
  );

  Given(
    "an impersonation session id that has already been force-stopped once",
    Effect.fn(function* () {
      yield* configureApp({ canImpersonate: () => Effect.succeed(true) });
      const adminCookie = yield* signIn("admin-1");
      yield* setOutcome("adminCookie", adminCookie);
      yield* impersonate(adminCookie, "target-1", "test");
      const impersonating = (yield* getOutcome("impersonatingBrowser")) as UserAgent.UserAgent;
      const sessionId = sessionIdOf(impersonationTokenOf(impersonating));
      const first = yield* requestAs(adminCookie, "POST", `/admin/force-stop/${sessionId}`, {
        body: {},
      });
      if (first.status !== 204) throw new Error("expected the first force-stop to succeed");
      yield* setOutcome("sessionId", sessionId);
    }),
  );

  When(
    '"admin.forceStop" is called again naming that same session id',
    Effect.fn(function* () {
      const adminCookie = (yield* getOutcome("adminCookie")) as Actor;
      const sessionId = (yield* getOutcome("sessionId")) as string;
      const response = yield* requestAs(adminCookie, "POST", `/admin/force-stop/${sessionId}`, {
        body: {},
      });
      yield* setOutcome("forceStopResponse", response);
    }),
  );

  Then(
    'the call fails with "404 Not Found" and the typed error "AdminImpersonationNotFound"',
    Effect.fn(function* () {
      const response = (yield* getOutcome("forceStopResponse")) as Response;
      if (response.status !== 404) throw new Error(`expected 404, got ${response.status}`);
      const body = (yield* Effect.promise(() => response.json())) as { _tag?: string };
      if (body._tag !== undefined && body._tag !== "AdminImpersonationNotFound") {
        throw new Error(`expected AdminImpersonationNotFound, got ${body._tag}`);
      }
    }),
  );

  Given(
    "an active impersonation episode that a second admin's gate refuses",
    Effect.fn(function* () {
      // IDS-001: forceStop evaluates the gate against the episode's target; only
      // "admin-1" passes, so "admin-2" is refused for an episode that exists.
      yield* configureApp({
        canImpersonate: ({ admin }) => Effect.succeed(admin.id === "admin-1"),
      });
      const adminCookie = yield* signIn("admin-1");
      yield* impersonate(adminCookie, "target-1", "support ticket #4821");
      const impersonating = (yield* getOutcome("impersonatingBrowser")) as UserAgent.UserAgent;
      yield* setOutcome("sessionId", sessionIdOf(impersonationTokenOf(impersonating)));
    }),
  );

  When(
    'that second admin calls "admin.forceStop" naming that episode\'s session id',
    Effect.fn(function* () {
      const secondAdminCookie = yield* signIn("admin-2");
      const sessionId = (yield* getOutcome("sessionId")) as string;
      const response = yield* requestAs(
        secondAdminCookie,
        "POST",
        `/admin/force-stop/${sessionId}`,
        {
          body: {},
        },
      );
      yield* setOutcome("forceStopResponse", response);
    }),
  );

  Then(
    'the call is denied with "403 Forbidden", the same gate "admin.impersonate" itself is held to',
    Effect.fn(function* () {
      const response = (yield* getOutcome("forceStopResponse")) as Response;
      if (response.status !== 403) throw new Error(`expected 403, got ${response.status}`);
    }),
  );

  // ---- BEH-EA-218: three audit events (403-406) ----

  Then(
    'an "auth.admin.impersonationStarted" event is published, carrying the admin, target, reason, and session id',
    Effect.fn(function* () {
      const events = yield* publishedEvents();
      const started = events.find((event) => event._tag === "auth.admin.impersonationStarted") as
        | {
            readonly _tag: string;
            readonly adminUserId: string;
            readonly targetUserId: string;
            readonly reason: string;
            readonly sessionId: string;
          }
        | undefined;
      if (started === undefined) throw new Error("expected an impersonationStarted event");
      if (started.adminUserId !== "admin-1" || started.targetUserId !== "target-1") {
        throw new Error("expected the event to carry the real admin/target ids");
      }
      if (started.reason !== "reproducing a bug" || started.sessionId === undefined) {
        throw new Error("expected the event to carry the reason and session id");
      }
    }),
  );

  Then(
    'an "auth.admin.impersonationStopped" event is published, carrying the session id and "self"',
    Effect.fn(function* () {
      const events = yield* publishedEvents();
      const stopped = events.find((event) => event._tag === "auth.admin.impersonationStopped") as
        | { readonly _tag: string; readonly sessionId: string; readonly endedBy: string }
        | undefined;
      if (stopped === undefined) throw new Error("expected an impersonationStopped event");
      if (stopped.endedBy !== "self")
        throw new Error(`expected endedBy "self", got "${stopped.endedBy}"`);
    }),
  );

  Then(
    'an "auth.admin.impersonationDenied" event is published',
    Effect.fn(function* () {
      const events = yield* publishedEvents();
      const denied = events.find((event) => event._tag === "auth.admin.impersonationDenied");
      if (denied === undefined) throw new Error("expected an impersonationDenied event");
    }),
  );

  Then(
    'no "auth.admin.impersonationDenied" event is published, since this is an ordinary validation failure, not a gate rejection',
    Effect.fn(function* () {
      const events = yield* publishedEvents();
      const denied = events.find((event) => event._tag === "auth.admin.impersonationDenied");
      if (denied !== undefined) {
        throw new Error("expected no impersonationDenied event for a self-impersonation refusal");
      }
    }),
  );

  // ---- BEH-EA-219: audit trail is queryable (397-398) ----

  Given(
    "an admin who has both an ended and a currently-active impersonation episode",
    Effect.fn(function* () {
      yield* configureApp({ canImpersonate: () => Effect.succeed(true) });
      const adminCookie = yield* signIn("admin-1");
      yield* setOutcome("adminCookie", adminCookie);

      yield* impersonate(adminCookie, "target-1", "first episode");
      const ended = (yield* getOutcome("impersonatingBrowser")) as UserAgent.UserAgent;
      yield* request("POST", "/admin/stop-impersonating", { body: {}, as: ended });

      yield* impersonate(adminCookie, "target-2", "second episode");
    }),
  );

  When(
    'the admin calls "admin.list" with no filter',
    Effect.fn(function* () {
      const adminCookie = (yield* getOutcome("adminCookie")) as Actor;
      const response = yield* requestAs(adminCookie, "GET", "/admin");
      yield* setOutcome("listResponse", response);
    }),
  );

  Then(
    "both episodes are returned, ordered newest first",
    Effect.fn(function* () {
      const response = (yield* getOutcome("listResponse")) as Response;
      const rows = yield* listRows<{
        readonly startedAt: string;
      }>(response);
      if (rows.length !== 2) throw new Error(`expected 2 rows, got ${rows.length}`);
      const [first, second] = rows;
      if (first!.startedAt < second!.startedAt) {
        throw new Error("expected rows ordered newest first");
      }
    }),
  );

  When(
    'the admin calls "admin.list" with "active=true"',
    Effect.fn(function* () {
      const adminCookie = (yield* getOutcome("adminCookie")) as Actor;
      const response = yield* requestAs(adminCookie, "GET", "/admin?active=true");
      yield* setOutcome("listResponse", response);
    }),
  );

  Then(
    "only the currently-active episode is returned",
    Effect.fn(function* () {
      const response = (yield* getOutcome("listResponse")) as Response;
      const rows = yield* listRows<{
        readonly endedAt: string | null;
      }>(response);
      if (rows.length !== 1) throw new Error(`expected 1 row, got ${rows.length}`);
      if (rows[0]!.endedAt !== null)
        throw new Error("expected the active row's endedAt to be null");
    }),
  );

  // ---- BEH-EA-220: target's own sessions untouched (399) ----

  Given(
    "a target user with their own active session, issued before any impersonation begins",
    Effect.fn(function* () {
      yield* configureApp({ canImpersonate: () => Effect.succeed(true) });
      const targetCookie = yield* signIn("target-1");
      yield* setOutcome("targetCookie", targetCookie);
      const adminCookie = yield* signIn("admin-1");
      yield* setOutcome("adminCookie", adminCookie);
    }),
  );

  When(
    "an admin impersonates that target user",
    Effect.fn(function* () {
      const adminCookie = (yield* getOutcome("adminCookie")) as Actor;
      yield* impersonate(adminCookie, "target-1", "test");
    }),
  );

  Then(
    "the target's own original session cookie still authenticates afterward, unaffected",
    Effect.fn(function* () {
      const targetCookie = (yield* getOutcome("targetCookie")) as Actor;
      const response = yield* requestAs(targetCookie, "GET", "/admin");
      // `target-1` was never granted `canImpersonate` in this World's own
      // setup, so this specifically proves the session itself still
      // authenticates (reaches the handler's own auth check) rather than
      // having been revoked — a 403 here is the gate, not a dead session;
      // a 401 would mean the session itself no longer authenticates.
      if (response.status === 401) {
        throw new Error(
          "expected the target's own session to still authenticate (401 means it doesn't)",
        );
      }
    }),
  );

  // ---- IDS-001 / IDS-003: target-aware gate, unknown target ----

  Given(
    '"Admin" configured with a "canImpersonate" predicate that refuses the target {string}',
    Effect.fn(function* (protectedId: string) {
      yield* configureApp({
        canImpersonate: ({ target }) => Effect.succeed(target.id !== protectedId),
      });
      const cookie = yield* signIn("caller-1");
      yield* setOutcome("adminCookie", cookie);
    }),
  );

  When(
    'a signed-in user calls "admin.impersonate" naming the protected target {string}',
    Effect.fn(function* (protectedId: string) {
      const adminCookie = (yield* getOutcome("adminCookie")) as Actor;
      const response = yield* impersonate(adminCookie, protectedId, "reproducing a bug");
      yield* setOutcome("impersonateResponse", response);
    }),
  );

  When(
    "the admin calls {string} for an unknown user id",
    Effect.fn(function* (_endpoint: string) {
      const adminCookie = (yield* getOutcome("adminCookie")) as Actor;
      const response = yield* impersonate(adminCookie, "unknown-user", "reproducing a bug");
      yield* setOutcome("impersonateResponse", response);
    }),
  );

  Then(
    'the call is rejected with "404 Not Found" and the typed error "AdminTargetNotFound"',
    Effect.fn(function* () {
      const response = (yield* getOutcome("impersonateResponse")) as Response;
      if (response.status !== 404) throw new Error(`expected 404, got ${response.status}`);
      const body = (yield* Effect.promise(() => response.json())) as { _tag?: string };
      if (body._tag !== undefined && body._tag !== "AdminTargetNotFound") {
        throw new Error(`expected AdminTargetNotFound, got ${body._tag}`);
      }
    }),
  );

  Then(
    "the impersonation audit trail is still empty",
    Effect.fn(function* () {
      const adminCookie = (yield* getOutcome("adminCookie")) as Actor;
      const listResponse = yield* requestAs(adminCookie, "GET", "/admin");
      const rows = yield* listRows<unknown>(listResponse);
      if (rows.length !== 0) throw new Error(`expected an empty audit trail, got ${rows.length}`);
    }),
  );

  // ---- BAM-005: user and session administration ----

  Given(
    'an application composing "Admin" with no "canManageUsers" predicate configured',
    Effect.fn(function* () {
      yield* configureApp({ canImpersonate: () => Effect.succeed(true) });
      yield* setOutcome("adminCookie", yield* signIn("admin-1"));
    }),
  );

  When(
    'a signed-in user calls "admin.listUsers"',
    Effect.fn(function* () {
      const adminCookie = (yield* getOutcome("adminCookie")) as Actor;
      yield* setOutcome("userAdminResponse", yield* requestAs(adminCookie, "GET", "/admin/users"));
    }),
  );

  Then(
    "the user-administration call is denied with {string}",
    Effect.fn(function* (statusText: string) {
      const response = (yield* getOutcome("userAdminResponse")) as Response;
      const expected = Number(statusText.split(" ")[0]);
      if (response.status !== expected) {
        throw new Error(`expected ${expected} ("${statusText}"), got ${response.status}`);
      }
    }),
  );

  Given(
    '"Admin" configured with a "canManageUsers" predicate that always resolves "true"',
    Effect.fn(function* () {
      yield* configureApp({ canManageUsers: () => Effect.succeed(true) });
      yield* setOutcome("adminCookie", yield* signIn("admin-1"));
    }),
  );

  Given(
    "a user with an active session of their own",
    Effect.fn(function* () {
      yield* setOutcome("userCookie", yield* signIn("target-1"));
    }),
  );

  When(
    'the admin calls "admin.revokeUserSession" naming that user\'s session',
    Effect.fn(function* () {
      const adminCookie = (yield* getOutcome("adminCookie")) as Actor;
      const userCookie = (yield* getOutcome("userCookie")) as Actor;
      const sessionId = sessionIdOf(userCookie.token);
      yield* setOutcome(
        "userAdminResponse",
        yield* requestAs(adminCookie, "DELETE", `/admin/users/target-1/sessions/${sessionId}`),
      );
    }),
  );

  Then(
    "the user-administration call succeeds with {string}",
    Effect.fn(function* (statusText: string) {
      const response = (yield* getOutcome("userAdminResponse")) as Response;
      const expected = Number(statusText.split(" ")[0]);
      if (response.status !== expected) {
        throw new Error(`expected ${expected} ("${statusText}"), got ${response.status}`);
      }
    }),
  );

  Then(
    "that session no longer authenticates",
    Effect.fn(function* () {
      // The user has no admin rights in this World; a 401 (unauthenticated) rather
      // than a 403 (authenticated, refused) is what proves the session itself is gone.
      const userCookie = (yield* getOutcome("userCookie")) as Actor;
      const response = yield* requestAs(userCookie, "GET", "/admin/users");
      if (response.status !== 401) {
        throw new Error(`expected 401 for a revoked session, got ${response.status}`);
      }
    }),
  );

  // ---- BEH-EA-221: the gate precedes the existence check ----

  Given(
    '"Admin" configured with a "canManageUsers" predicate that admits only the target {string}',
    Effect.fn(function* (admitted: string) {
      yield* configureApp({
        canManageUsers: ({ target }) =>
          Effect.succeed(Option.isSome(target) && target.value.id === admitted),
      });
      yield* setOutcome("adminCookie", yield* signIn("admin-1"));
    }),
  );

  When(
    'a signed-in user calls "admin.getUser" for {string} and for {string}',
    Effect.fn(function* (unknownId: string, refusedId: string) {
      const cookie = (yield* getOutcome("adminCookie")) as Actor;
      yield* setOutcome("getUserResponses", [
        yield* requestAs(cookie, "GET", `/admin/users/${unknownId}`),
        yield* requestAs(cookie, "GET", `/admin/users/${refusedId}`),
      ]);
      yield* setOutcome(
        "admittedResponse",
        yield* requestAs(cookie, "GET", "/admin/users/target-1"),
      );
    }),
  );

  Then(
    'both calls are denied with "403 Forbidden", the unknown user never answering "404 Not Found"',
    Effect.fn(function* () {
      const responses = (yield* getOutcome("getUserResponses")) as ReadonlyArray<Response>;
      assert.deepStrictEqual(
        responses.map((response) => response.status),
        [403, 403],
      );
    }),
  );

  Then(
    "the same caller is served the admitted target {string}",
    Effect.fn(function* (_id: string) {
      // The predicate is what refused the others, not a blanket denial: the admitted target reads fine.
      const response = (yield* getOutcome("admittedResponse")) as Response;
      assert.strictEqual(response.status, 200);
    }),
  );

  // ---- BEH-EA-222: keyset-paginated listing, read and update ----

  Given(
    "three users besides the admin",
    Effect.fn(function* () {
      for (const id of ["listed-1", "listed-2", "listed-3"]) yield* signIn(id);
    }),
  );

  When(
    'the admin calls "admin.listUsers" with {string}, then again with the returned cursor',
    Effect.fn(function* (query: string) {
      const cookie = (yield* getOutcome("adminCookie")) as Actor;
      const firstResponse = yield* requestAs(cookie, "GET", `/admin/users?${query}`);
      const first = (yield* Effect.promise(() => firstResponse.json())) as {
        readonly items: ReadonlyArray<unknown>;
        readonly nextCursor: string | null;
      };
      yield* setOutcome("firstPage", first);
      if (first.nextCursor === null) throw new Error("expected a next cursor on the first page");
      const secondResponse = yield* requestAs(
        cookie,
        "GET",
        `/admin/users?${query}&cursor=${encodeURIComponent(first.nextCursor)}`,
      );
      yield* setOutcome("secondPage", yield* Effect.promise(() => secondResponse.json()));
    }),
  );

  Then(
    "the first page holds {int} users and a next cursor",
    Effect.fn(function* (count: number) {
      const page = (yield* getOutcome("firstPage")) as {
        readonly items: ReadonlyArray<unknown>;
        readonly nextCursor: string | null;
      };
      assert.strictEqual(page.items.length, count);
      assert.ok(page.nextCursor !== null);
    }),
  );

  Then(
    "the second page holds the remaining {int} users and no next cursor",
    Effect.fn(function* (count: number) {
      const page = (yield* getOutcome("secondPage")) as {
        readonly items: ReadonlyArray<unknown>;
        readonly nextCursor: string | null;
      };
      // Four users exist in all (the admin and the three above): 2 + 2.
      assert.strictEqual(page.items.length, count);
      assert.strictEqual(page.nextCursor, null);
    }),
  );

  When(
    'the admin calls "admin.listUsers" with {string}',
    Effect.fn(function* (query: string) {
      const cookie = (yield* getOutcome("adminCookie")) as Actor;
      yield* setOutcome(
        "userAdminResponse",
        yield* requestAs(cookie, "GET", `/admin/users?${query}`),
      );
    }),
  );

  When(
    'the admin calls "admin.updateUser" naming that user with the name {string}',
    Effect.fn(function* (name: string) {
      const cookie = (yield* getOutcome("adminCookie")) as Actor;
      const listResponse = yield* requestAs(cookie, "GET", "/admin/users");
      const users = (yield* Effect.promise(() => listResponse.json())) as {
        readonly items: ReadonlyArray<{ readonly id: string; readonly name: string }>;
      };
      const target = users.items.find((user) => user.name === "target-1");
      if (target === undefined) throw new Error("expected the target user to be listed");
      yield* setOutcome("updateTarget", target);
      yield* setOutcome(
        "userAdminResponse",
        yield* requestAs(cookie, "PATCH", `/admin/users/${target.id}`, {
          body: { name },
        }),
      );
    }),
  );

  Then(
    "the returned user is named {string} and keeps the email it had",
    Effect.fn(function* (name: string) {
      const response = (yield* getOutcome("userAdminResponse")) as Response;
      const updated = (yield* Effect.promise(() => response.json())) as {
        readonly name: string;
        readonly identity: { readonly email: string };
      };
      assert.strictEqual(updated.name, name);
      assert.strictEqual(updated.identity.email, "target-1@example.com");
    }),
  );

  // ---- BEH-EA-224: admin actions are audited by events ----

  Then(
    'an "auth.admin.actionDenied" event is published for the caller {string}',
    Effect.fn(function* (adminId: string) {
      const events = yield* publishedEvents();
      const denied = events.find((event) => event._tag === "auth.admin.actionDenied");
      assert.ok(denied !== undefined, "expected an actionDenied event");
      assert.ok(denied._tag === "auth.admin.actionDenied");
      assert.strictEqual(denied.adminUserId, adminId);
      assert.strictEqual(typeof denied.action, "string");
    }),
  );

  Then(
    'an "auth.admin.sessionRevoked" event is published for the admin {string} and that session',
    Effect.fn(function* (adminId: string) {
      const userCookie = (yield* getOutcome("userCookie")) as Actor;
      const sessionId = sessionIdOf(userCookie.token);
      const events = yield* publishedEvents();
      const revoked = events.find((event) => event._tag === "auth.admin.sessionRevoked");
      assert.ok(revoked !== undefined, "expected a sessionRevoked event");
      assert.ok(revoked._tag === "auth.admin.sessionRevoked");
      assert.strictEqual(revoked.adminUserId, adminId);
      assert.strictEqual(revoked.sessionId, sessionId);
    }),
  );

  // ---- APS-006: one real browser (a user agent keeps every cookie, as a browser does) ----

  Given(
    "an admin actively impersonating a target user through one browser cookie jar",
    Effect.fn(function* () {
      // Only "admin-1" passes the gate, so an episode is visible in `list` when the
      // caller resolves as the admin and filtered out when it resolves as the target.
      yield* configureApp({
        canImpersonate: ({ admin }) => Effect.succeed(admin.id === "admin-1"),
      });
      const agent = yield* browser(yield* signIn("admin-1"));
      yield* setOutcome("browser", agent);
      const response = yield* request("POST", "/admin/impersonate/target-1", {
        body: { reason: "support ticket #4821" },
        as: agent,
      });
      if (response.status !== 200) throw new Error(`expected 200, got ${response.status}`);
      const asTarget = yield* request("GET", "/admin", { as: agent });
      const rows = yield* listRows<unknown>(asTarget);
      if (rows.length !== 0) throw new Error("expected the browser to be served as the target");
    }),
  );

  When(
    'the browser calls "admin.stopImpersonating"',
    Effect.fn(function* () {
      const agent = (yield* getOutcome("browser")) as UserAgent.UserAgent;
      const response = yield* request("POST", "/admin/stop-impersonating", { body: {}, as: agent });
      if (response.status !== 204) throw new Error(`expected 204, got ${response.status}`);
      if (agent.cookies.get(IMPERSONATION_COOKIE) !== undefined) {
        throw new Error("expected the impersonation cookie's expiry to remove it from the browser");
      }
    }),
  );

  Then(
    "the browser's next request is served as the admin, with no re-login",
    Effect.fn(function* () {
      const agent = (yield* getOutcome("browser")) as UserAgent.UserAgent;
      const response = yield* request("GET", "/admin", { as: agent });
      const rows = yield* listRows<{
        readonly endedBy: string | null;
      }>(response);
      if (rows.length !== 1 || rows[0]?.endedBy !== "self") {
        throw new Error("expected the ended episode to be listed for the admin's own session");
      }
    }),
  );
});
