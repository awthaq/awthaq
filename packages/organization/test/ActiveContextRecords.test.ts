// MTI-001: the active-context setters take a membership or team-membership record as their witness. The store's
// behaviour is its RecordsContract suite (`test/contract/ActiveContextRecords.ts`, run by `Contract.test.ts`).
import { Users } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as ActiveContextRecords from "../src/ActiveContextRecords.ts";

const alice = Users.UserId("alice");

describe("ActiveContextRecords witnesses (type level)", () => {
  it("rejects a hand-built membership witness", () => {
    const handBuilt = {
      id: "m-1",
      userId: alice,
      organizationId: "org-1",
      role: ["owner"],
      createdAt: DateTime.nowUnsafe(),
    };
    const neverRun = (records: ActiveContextRecords.ActiveContextRecordsShape) =>
      // @ts-expect-error a plain object is not a MembershipRecord
      records.setOrganization("session-1", handBuilt);
    assert.isFunction(neverRun);
  });
});
