// GC-007/ESA-005: the event union's id fields are branded, and the invitation
// event carries no contact detail. Nothing here executes — the assertions are the
// `@ts-expect-error` directives, checked by `tsc -p tsconfig.test.json`.
import { describe, it } from "@effect/vitest";
import type * as AuthEvents from "../src/AuthEvents.ts";
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
});
