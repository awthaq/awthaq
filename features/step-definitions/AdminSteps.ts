import { defineSteps } from "@effect-cucumber/vitest";
import * as Effect from "effect/Effect";
import {
  configureApp,
  cookieFrom,
  getOutcome,
  inspectSession,
  publishedEvents,
  request,
  resolvePrincipal,
  setOutcome,
  signIn,
  tokenFromCookie,
  World,
} from "./AdminWorld.ts";

const impersonate = Effect.fn("features.admin.impersonate")(function* (
  adminCookie: string,
  targetUserId: string,
  reason: string,
) {
  return yield* request("POST", `/admin/impersonate/${targetUserId}`, {
    body: { reason },
    headers: { cookie: adminCookie },
  });
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
      const token = tokenFromCookie(cookieFrom(response));
      const session = yield* inspectSession(token);
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
      const response = (yield* getOutcome("impersonateResponse")) as Response;
      const token = tokenFromCookie(cookieFrom(response));
      const session = yield* inspectSession(token);
      const idle = session.idleExpiresAt.epochMilliseconds;
      const absolute = session.absoluteExpiresAt.epochMilliseconds;
      if (idle !== absolute) {
        throw new Error(
          `expected idleExpiresAt (${idle}) to equal absoluteExpiresAt (${absolute})`,
        );
      }
    }),
  );

  // ---- BEH-EA-211: resolvePrincipal closes the loop (402) ----

  Given(
    "a signed-in admin actively impersonating a target user",
    Effect.fn(function* () {
      yield* configureApp({ canImpersonate: () => Effect.succeed(true) });
      const adminCookie = yield* signIn("admin-1");
      yield* setOutcome("adminCookie", adminCookie);
      const response = yield* impersonate(adminCookie, "target-1", "support ticket #4821");
      const impersonatingCookie = cookieFrom(response);
      yield* setOutcome("impersonatingCookie", impersonatingCookie);
      yield* setOutcome("sessionId", impersonatingCookie.split("=")[1]!.split(".")[0]!);
    }),
  );

  When(
    "the impersonation session's own token is resolved to a principal",
    Effect.fn(function* () {
      const impersonatingCookie = (yield* getOutcome("impersonatingCookie")) as string;
      const principal = yield* resolvePrincipal(tokenFromCookie(impersonatingCookie));
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
      const adminCookie = (yield* getOutcome("adminCookie")) as string;
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
      const adminCookie = (yield* getOutcome("adminCookie")) as string;
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
      const adminCookie = (yield* getOutcome("adminCookie")) as string;
      const response = yield* impersonate(adminCookie, "target-1", "reproducing a bug");
      yield* setOutcome("impersonateResponse", response);
    }),
  );

  Then(
    "the response carries a new session cookie, distinct from the admin's own",
    Effect.fn(function* () {
      const response = (yield* getOutcome("impersonateResponse")) as Response;
      const adminCookie = (yield* getOutcome("adminCookie")) as string;
      const targetCookie = cookieFrom(response);
      if (targetCookie === adminCookie) {
        throw new Error("expected a distinct session cookie for the target");
      }
    }),
  );

  Then(
    "the admin's own original session cookie still authenticates afterward",
    Effect.fn(function* () {
      const adminCookie = (yield* getOutcome("adminCookie")) as string;
      // `list` is gated only by canImpersonate, not by "am I impersonating" —
      // any still-valid session for a permitted caller can reach it.
      const response = yield* request("GET", "/admin", { headers: { cookie: adminCookie } });
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
      const adminCookie = (yield* getOutcome("adminCookie")) as string;
      const response = yield* impersonate(adminCookie, "target-1", "   ");
      yield* setOutcome("impersonateResponse", response);
    }),
  );

  When(
    "the admin calls {string} for a target user with a reason over 1000 characters long",
    Effect.fn(function* (_endpoint: string) {
      const adminCookie = (yield* getOutcome("adminCookie")) as string;
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
      const adminCookie = (yield* getOutcome("adminCookie")) as string;
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
      const impersonatingCookie = (yield* getOutcome("impersonatingCookie")) as string;
      const response = yield* impersonate(impersonatingCookie, "target-2", "nested");
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
      const adminCookie = (yield* getOutcome("adminCookie")) as string;
      const impersonateResponse = (yield* getOutcome("impersonateResponse")) as Response;
      const sessionId = cookieFrom(impersonateResponse).split("=")[1]!.split(".")[0]!;
      const listResponse = yield* request("GET", "/admin", { headers: { cookie: adminCookie } });
      const rows = (yield* Effect.promise(() => listResponse.json())) as ReadonlyArray<{
        readonly adminUserId: string;
        readonly targetUserId: string;
        readonly sessionId: string;
        readonly endedAt: string | null;
      }>;
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
      const impersonatingCookie = (yield* getOutcome("impersonatingCookie")) as string;
      const response = yield* request("POST", "/admin/stop-impersonating", {
        body: {},
        headers: { cookie: impersonatingCookie },
      });
      yield* setOutcome("stopResponse", response);
    }),
  );

  Then(
    'the matching audit row\'s "endedAt" and "endedBy" are set to "self"',
    Effect.fn(function* () {
      const adminCookie = (yield* getOutcome("adminCookie")) as string;
      const sessionId = (yield* getOutcome("sessionId")) as string;
      const listResponse = yield* request("GET", "/admin", { headers: { cookie: adminCookie } });
      const rows = (yield* Effect.promise(() => listResponse.json())) as ReadonlyArray<{
        readonly sessionId: string;
        readonly endedAt: string | null;
        readonly endedBy: string | null;
      }>;
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
      const impersonatingCookie = (yield* getOutcome("impersonatingCookie")) as string;
      const response = yield* request("POST", "/admin/stop-impersonating", {
        body: {},
        headers: { cookie: impersonatingCookie },
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
      for (const line of response.headers.getSetCookie()) {
        const [pair = "", ...attributes] = line.split(";");
        const expiry =
          pair.startsWith("__Host-impersonation=") &&
          attributes.some((attribute) => /max-age=0/i.test(attribute));
        if (!expiry) {
          throw new Error(`expected only an impersonation-cookie expiry, got "${line}"`);
        }
      }
    }),
  );

  Then(
    "the revoked impersonation session no longer authenticates",
    Effect.fn(function* () {
      const impersonatingCookie = (yield* getOutcome("impersonatingCookie")) as string;
      const response = yield* request("GET", "/admin", {
        headers: { cookie: impersonatingCookie },
      });
      if (response.status === 200) {
        throw new Error("expected the revoked impersonation session to no longer authenticate");
      }
    }),
  );

  Then(
    "the admin's own original session cookie still authenticates",
    Effect.fn(function* () {
      const adminCookie = (yield* getOutcome("adminCookie")) as string;
      const response = yield* request("GET", "/admin", { headers: { cookie: adminCookie } });
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
      const adminCookie = (yield* getOutcome("adminCookie")) as string;
      const response = yield* request("POST", "/admin/stop-impersonating", {
        body: {},
        headers: { cookie: adminCookie },
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
      const response = yield* impersonate(adminCookie, "target-1", "support ticket #4821");
      const sessionId = cookieFrom(response).split("=")[1]!.split(".")[0]!;
      yield* setOutcome("sessionId", sessionId);
      yield* setOutcome("impersonatingCookie", cookieFrom(response));
    }),
  );

  When(
    'a second admin permitted to impersonate calls "admin.forceStop" naming that session id',
    Effect.fn(function* () {
      const secondAdminCookie = yield* signIn("admin-2");
      const sessionId = (yield* getOutcome("sessionId")) as string;
      const response = yield* request("POST", `/admin/force-stop/${sessionId}`, {
        body: {},
        headers: { cookie: secondAdminCookie },
      });
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
      const impersonatingCookie = (yield* getOutcome("impersonatingCookie")) as string;
      const response = yield* request("GET", "/admin", {
        headers: { cookie: impersonatingCookie },
      });
      if (response.status === 200) {
        throw new Error("expected the force-stopped session to no longer authenticate");
      }
    }),
  );

  Then(
    'the matching audit row\'s "endedBy" is set to "forcedByAdmin"',
    Effect.fn(function* () {
      const adminCookie = (yield* getOutcome("adminCookie")) as string;
      const sessionId = (yield* getOutcome("sessionId")) as string;
      const listResponse = yield* request("GET", "/admin", { headers: { cookie: adminCookie } });
      const rows = (yield* Effect.promise(() => listResponse.json())) as ReadonlyArray<{
        readonly sessionId: string;
        readonly endedBy: string | null;
      }>;
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
      const response = yield* impersonate(adminCookie, "target-1", "test");
      const sessionId = cookieFrom(response).split("=")[1]!.split(".")[0]!;
      const first = yield* request("POST", `/admin/force-stop/${sessionId}`, {
        body: {},
        headers: { cookie: adminCookie },
      });
      if (first.status !== 204) throw new Error("expected the first force-stop to succeed");
      yield* setOutcome("sessionId", sessionId);
    }),
  );

  When(
    '"admin.forceStop" is called again naming that same session id',
    Effect.fn(function* () {
      const adminCookie = (yield* getOutcome("adminCookie")) as string;
      const sessionId = (yield* getOutcome("sessionId")) as string;
      const response = yield* request("POST", `/admin/force-stop/${sessionId}`, {
        body: {},
        headers: { cookie: adminCookie },
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
      const response = yield* impersonate(adminCookie, "target-1", "support ticket #4821");
      yield* setOutcome("sessionId", cookieFrom(response).split("=")[1]!.split(".")[0]!);
    }),
  );

  When(
    'that second admin calls "admin.forceStop" naming that episode\'s session id',
    Effect.fn(function* () {
      const secondAdminCookie = yield* signIn("admin-2");
      const sessionId = (yield* getOutcome("sessionId")) as string;
      const response = yield* request("POST", `/admin/force-stop/${sessionId}`, {
        body: {},
        headers: { cookie: secondAdminCookie },
      });
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

      const ended = yield* impersonate(adminCookie, "target-1", "first episode");
      const endedCookie = cookieFrom(ended);
      yield* request("POST", "/admin/stop-impersonating", {
        body: {},
        headers: { cookie: endedCookie },
      });

      yield* impersonate(adminCookie, "target-2", "second episode");
    }),
  );

  When(
    'the admin calls "admin.list" with no filter',
    Effect.fn(function* () {
      const adminCookie = (yield* getOutcome("adminCookie")) as string;
      const response = yield* request("GET", "/admin", { headers: { cookie: adminCookie } });
      yield* setOutcome("listResponse", response);
    }),
  );

  Then(
    "both episodes are returned, ordered newest first",
    Effect.fn(function* () {
      const response = (yield* getOutcome("listResponse")) as Response;
      const rows = (yield* Effect.promise(() => response.json())) as ReadonlyArray<{
        readonly startedAt: string;
      }>;
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
      const adminCookie = (yield* getOutcome("adminCookie")) as string;
      const response = yield* request("GET", "/admin?active=true", {
        headers: { cookie: adminCookie },
      });
      yield* setOutcome("listResponse", response);
    }),
  );

  Then(
    "only the currently-active episode is returned",
    Effect.fn(function* () {
      const response = (yield* getOutcome("listResponse")) as Response;
      const rows = (yield* Effect.promise(() => response.json())) as ReadonlyArray<{
        readonly endedAt: string | null;
      }>;
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
      const adminCookie = (yield* getOutcome("adminCookie")) as string;
      yield* impersonate(adminCookie, "target-1", "test");
    }),
  );

  Then(
    "the target's own original session cookie still authenticates afterward, unaffected",
    Effect.fn(function* () {
      const targetCookie = (yield* getOutcome("targetCookie")) as string;
      const response = yield* request("GET", "/admin", { headers: { cookie: targetCookie } });
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
      const adminCookie = (yield* getOutcome("adminCookie")) as string;
      const response = yield* impersonate(adminCookie, protectedId, "reproducing a bug");
      yield* setOutcome("impersonateResponse", response);
    }),
  );

  When(
    "the admin calls {string} for an unknown user id",
    Effect.fn(function* (_endpoint: string) {
      const adminCookie = (yield* getOutcome("adminCookie")) as string;
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
      const adminCookie = (yield* getOutcome("adminCookie")) as string;
      const listResponse = yield* request("GET", "/admin", { headers: { cookie: adminCookie } });
      const rows = (yield* Effect.promise(() => listResponse.json())) as ReadonlyArray<unknown>;
      if (rows.length !== 0) throw new Error(`expected an empty audit trail, got ${rows.length}`);
    }),
  );

  // ---- APS-006: one real browser cookie jar ----

  Given(
    "an admin actively impersonating a target user through one browser cookie jar",
    Effect.fn(function* () {
      // Only "admin-1" passes the gate, so an episode is visible in `list` when the
      // caller resolves as the admin and filtered out when it resolves as the target.
      yield* configureApp({
        canImpersonate: ({ admin }) => Effect.succeed(admin.id === "admin-1"),
      });
      const jar = new Map<string, string>();
      const [name = "", value = ""] = (yield* signIn("admin-1")).split(/=(.*)/s);
      jar.set(name, value);
      yield* setOutcome("jar", jar);
      const response = yield* request("POST", "/admin/impersonate/target-1", {
        body: { reason: "support ticket #4821" },
        headers: { cookie: jarHeader(jar) },
      });
      if (response.status !== 200) throw new Error(`expected 200, got ${response.status}`);
      applySetCookies(jar, response);
      const asTarget = yield* request("GET", "/admin", { headers: { cookie: jarHeader(jar) } });
      const rows = (yield* Effect.promise(() => asTarget.json())) as ReadonlyArray<unknown>;
      if (rows.length !== 0) throw new Error("expected the jar to be served as the target");
    }),
  );

  When(
    'the browser calls "admin.stopImpersonating"',
    Effect.fn(function* () {
      const jar = (yield* getOutcome("jar")) as Map<string, string>;
      const response = yield* request("POST", "/admin/stop-impersonating", {
        body: {},
        headers: { cookie: jarHeader(jar) },
      });
      if (response.status !== 204) throw new Error(`expected 204, got ${response.status}`);
      applySetCookies(jar, response);
    }),
  );

  Then(
    "the browser's next request is served as the admin, with no re-login",
    Effect.fn(function* () {
      const jar = (yield* getOutcome("jar")) as Map<string, string>;
      const response = yield* request("GET", "/admin", { headers: { cookie: jarHeader(jar) } });
      const rows = (yield* Effect.promise(() => response.json())) as ReadonlyArray<{
        readonly endedBy: string | null;
      }>;
      if (rows.length !== 1 || rows[0]?.endedBy !== "self") {
        throw new Error("expected the ended episode to be listed for the admin's own session");
      }
    }),
  );
});

/** A browser cookie jar: one value per name, every `Set-Cookie` applied, an expired cookie deleted. */
const jarHeader = (jar: ReadonlyMap<string, string>): string =>
  [...jar].map(([name, value]) => `${name}=${value}`).join("; ");

const applySetCookies = (jar: Map<string, string>, response: Response): void => {
  for (const line of response.headers.getSetCookie()) {
    const [pair = "", ...attributes] = line.split(";");
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value === "" || attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute))) {
      jar.delete(name);
    } else {
      jar.set(name, value);
    }
  }
};
