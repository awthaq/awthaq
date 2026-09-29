// ELC-004: `OrganizationMemory.layer` is every record store the Organization plugin reads, over
// memory, as one layer that asks only for `Crypto` once (instead of six `layerMemory` layers each
// repeating `Layer.provide(NodeCrypto.layer)`).
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ActiveContextRecords from "../src/ActiveContextRecords.ts";
import * as InvitationRecords from "../src/InvitationRecords.ts";
import * as MembershipRecords from "../src/MembershipRecords.ts";
import * as OrganizationMemory from "../src/OrganizationMemory.ts";
import * as OrganizationRecords from "../src/OrganizationRecords.ts";
import * as OrgRoleRecords from "../src/OrgRoleRecords.ts";
import * as TeamRecords from "../src/TeamRecords.ts";

describe("OrganizationMemory.layer (ELC-004)", () => {
  it.effect("provides all six record stores, given only Crypto", () =>
    Effect.gen(function* () {
      const services = [
        yield* OrganizationRecords.OrganizationRecords,
        yield* MembershipRecords.MembershipRecords,
        yield* ActiveContextRecords.ActiveContextRecords,
        yield* InvitationRecords.InvitationRecords,
        yield* OrgRoleRecords.OrgRoleRecords,
        yield* TeamRecords.TeamRecords,
      ];
      assert.strictEqual(services.length, 6);
    }).pipe(Effect.provide(OrganizationMemory.layer.pipe(Layer.provide(NodeCrypto.layer)))),
  );
});
