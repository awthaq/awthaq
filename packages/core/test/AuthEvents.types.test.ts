// GC-007/ESA-005: the event union's id fields are branded, and the invitation
// event carries no contact detail. Nothing here executes — the assertions are the
// `@ts-expect-error` directives, checked by `tsc -p tsconfig.test.json`.
import { describe, it } from "@effect/vitest";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as AuthEvents from "../src/AuthEvents.ts";
import * as EventDefinition from "../src/EventDefinition.ts";
import { SessionId } from "../src/Sessions.ts";
import { UserId } from "../src/Users.ts";

describe("AuthEvent types", () => {
  it("session ids in events are SessionId, not a bare string (GC-007)", () => {
    const userId = UserId("u-1");
    const branded: AuthEvents.AuthEvent = {
      _tag: "auth.session.issued",
      sessionId: SessionId("s-1"),
      userId,
      familyId: "s-1",
    };
    const raw: AuthEvents.AuthEvent = {
      _tag: "auth.session.issued",
      // @ts-expect-error a bare string is not a SessionId
      sessionId: "raw",
      userId,
      familyId: "s-1",
    };
    void branded;
    void raw;
  });

  it("the invitation-created event carries no email (ESA-005)", () => {
    const event: AuthEvents.AuthEvent = {
      _tag: "auth.organization.invitationCreated",
      invitationId: "i-1",
      organizationId: "o-1",
      // @ts-expect-error identifiers only: the invitee's email is not on the bus
      email: "invitee@example.com",
    };
    void event;
  });

  // ADR-EA-049 (plan 29 ticket 06): plugin events through definitions; the bus is open and narrowed by guards.
  const LocalDef = EventDefinition.define(
    "auth.local.happened",
    { userId: EventDefinition.UserId, note: Schema.String },
    { actor: EventDefinition.Actor.field("userId"), pii: [] },
  );

  it("Handled of a mixed selector is the core event or the definition's, each with its envelope", () => {
    const read = (event: AuthEvents.Handled<readonly ["auth.session.issued", typeof LocalDef]>) =>
      event._tag === "auth.local.happened" ? event.note : event.sessionId;
    const one = (event: AuthEvents.Handled<typeof LocalDef>) => [event.note, event.eventId];
    void read;
    void one;
  });

  it("publish takes core's events only; a plugin's goes through emit, whose input is typed", () => {
    const publishLocal = (events: AuthEvents.AuthEventsShape) =>
      // @ts-expect-error a plugin's tag is not one of core's events: emit it through its definition
      events.publish({ _tag: "auth.local.happened", userId: UserId("u-1"), note: "n" });
    const emitted = (events: AuthEvents.AuthEventsShape): Effect.Effect<void> =>
      events.emit(LocalDef, { userId: UserId("u-1"), note: "n" });
    const untyped = (events: AuthEvents.AuthEventsShape) =>
      // @ts-expect-error a bare string is not a UserId
      events.emit(LocalDef, { userId: "u-1", note: "n" });
    void publishLocal;
    void emitted;
    void untyped;
  });

  it("the raw stream is open: a field read needs a guard", () => {
    const unguarded = (events: AuthEvents.AuthEventsShape) =>
      events.stream.pipe(
        // @ts-expect-error `PublishedAny` carries no `sessionId` until a guard narrows it
        Stream.map((event) => event.sessionId),
      );
    const guarded = (events: AuthEvents.AuthEventsShape) =>
      events.stream.pipe(
        Stream.filter(AuthEvents.is("auth.session.issued")),
        Stream.map((event) => event.sessionId),
      );
    void unguarded;
    void guarded;
  });
});
