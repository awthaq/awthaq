// @awthaq/core — AuthRequestContext
//
// ALF-006 (.issues/medium): the request an event was raised under. A
// `Context.Reference` with an all-`None` default, so no caller's `RIn` changes
// and a non-HTTP caller (a CLI import, a background job) simply has none.
// `@awthaq/server` populates it once per request; `AuthEvents.publish` reads
// it to stamp `correlationId`, `ip` and `userAgent` on the event's envelope
// (and on the durable `AuditLog` row), so every event one request raised can
// be joined without a subscriber having to plumb anything.
//
// Fixed-shape, optional fields only: no header value, cookie or body ever
// belongs here, so what reaches the audit trail is exactly these three.

import * as Context from "effect/Context";
import * as Option from "effect/Option";

export interface AuthRequestContextShape {
  /** A caller-supplied `x-request-id`, the trace id of an incoming W3C `traceparent`, else a fresh id. */
  readonly correlationId: Option.Option<string>;
  /** The client address the `ClientAddress` port resolved for the request. */
  readonly ip: Option.Option<string>;
  readonly userAgent: Option.Option<string>;
}

export const none: AuthRequestContextShape = {
  correlationId: Option.none(),
  ip: Option.none(),
  userAgent: Option.none(),
};

export const AuthRequestContext = Context.Reference<AuthRequestContextShape>(
  "awthaq/core/AuthRequestContext",
  { defaultValue: () => none },
);
