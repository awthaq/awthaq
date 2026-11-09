// ESA-005 (ADR-EA-029): the organization plugin's invitation event carries no contact detail. Moved from
// core's `AuthEvents.types.test.ts` with the event (ADR-EA-049). Nothing here executes: the assertion is the
// `@ts-expect-error` directive, checked by `tsc -p tsconfig.test.json`.
import { describe, it } from "@effect/vitest";
import type * as OrganizationEvents from "../src/OrganizationEvents.ts";

describe("OrganizationEvents types", () => {
  it("the invitation-created event carries no email (ESA-005)", () => {
    const event: OrganizationEvents.OrganizationInvitationCreatedEvent = {
      _tag: "auth.organization.invitationCreated",
      invitationId: "i-1",
      organizationId: "o-1",
      // @ts-expect-error identifiers only: the invitee's email is not on the bus
      email: "invitee@example.com",
    };
    void event;
  });
});
