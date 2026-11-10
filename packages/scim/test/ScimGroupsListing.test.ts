// BEH-EA-252 (spec/behaviors/30-scim.md), architecture plan 32 ticket 04: listing groups has no cap and no scan. A filter is a
// store lookup and an unfiltered listing pages in the store, so group 10,001 is as visible as group 1; a same-named team that
// this connection did not map never appears.
import { OrganizationActor, OrganizationTeams } from "@awthaq/organization";
import { TeamRecords } from "@awthaq/organization/records";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Scim from "../src/Scim.ts";
import * as ScimConnections from "../src/ScimConnections.ts";
import * as ScimRecords from "../src/ScimRecords.ts";
import { ScimLive, ScimLiveSql, seedConnection } from "./support.ts";

const seedGroup = (connectionId: string, organizationId: string, name: string) =>
  Effect.gen(function* () {
    const teamRecords = yield* TeamRecords.TeamRecords;
    const scimRecords = yield* ScimRecords.ScimRecords;
    const team = yield* teamRecords.createTeam({ organizationId, name });
    yield* scimRecords.link({
      connectionId,
      kind: "Group",
      resourceId: team.id,
      externalId: name.toLowerCase(),
    });
    return team.id;
  });

describe("listing groups past the old 10,000 cap (BEH-EA-252)", () => {
  it.effect(
    "a group provisioned after ten thousand others is found by both filters and by paging",
    () =>
      Effect.gen(function* () {
        const { connection, organizationId } = yield* seedConnection("big");
        const scim = yield* Scim.Scim;
        for (let n = 0; n < 10_000; n++)
          yield* seedGroup(connection.id, organizationId, `filler-${n}`);
        yield* TestClock.adjust("1 second");
        const needle = yield* seedGroup(connection.id, organizationId, "Needle");
        const byName = yield* scim.listGroups(connection, { filter: 'displayName eq "Needle"' });
        assert.strictEqual(byName.totalResults, 1);
        assert.strictEqual(byName.Resources[0]?.id, needle);
        const byExternal = yield* scim.listGroups(connection, { filter: 'externalId eq "needle"' });
        assert.strictEqual(byExternal.Resources[0]?.id, needle);
        const paged = yield* scim.listGroups(connection, { startIndex: 10_001, count: 1 });
        assert.strictEqual(paged.Resources[0]?.id, needle);
        assert.strictEqual(paged.totalResults, 10_001);
      }).pipe(Effect.provide(ScimLive())),
    120_000,
  );
});

for (const [label, layer] of [
  ["memory", () => ScimLive()],
  ["SQL", () => ScimLiveSql("scim_groups_listing")],
] as const) {
  describe(`a filter lists only the calling connection's groups (${label})`, () => {
    it.effect(
      "a same-named team of an administrator or of another connection is never listed",
      () =>
        Effect.gen(function* () {
          const { connection, organizationId } = yield* seedConnection("a");
          const scim = yield* Scim.Scim;
          const mine = yield* scim.createGroup(connection, { displayName: "Eng" });
          const teams = yield* OrganizationTeams.OrganizationTeams;
          yield* teams.create(OrganizationActor.application("test"), {
            organizationId,
            name: "Eng",
          });
          const store = yield* ScimConnections.ScimConnectionStore;
          const other = yield* store.create({ organizationId, name: "Other" });
          yield* scim.createGroup(
            { id: other.connection.id, organizationId, name: other.connection.name },
            { displayName: "Eng" },
          );
          const listed = yield* scim.listGroups(connection, { filter: 'displayName eq "Eng"' });
          assert.strictEqual(listed.totalResults, 1);
          assert.deepStrictEqual(
            listed.Resources.map((group) => group.id),
            [mine.id],
          );
        }).pipe(Effect.provide(layer())),
    );
  });
}
