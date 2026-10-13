// Plan 04 (F7): deleting an organization removes its SAML connections with their domains, SP keys and
// Single Logout session rows, in the deletion's own transaction. Before, those rows outlived it.
import { OrganizationActor, OrganizationDirectory } from "@awthaq/organization";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { TenantScoped } from "@awthaq/sql";
import * as SamlRecords from "../src/SamlRecords.ts";
import { SamlLive, seedConnection } from "./support.ts";

const grant = TenantScoped.crossTenant("test: a cross-organization caller");

describe("SAML connections go with their organization (plan 04, F7)", () => {
  it.effect("deleting the organization removes its connections and frees their email domains", () =>
    Effect.gen(function* () {
      const records = yield* SamlRecords.SamlRecords;
      const directory = yield* OrganizationDirectory.OrganizationDirectory;
      const doomed = yield* seedConnection({ slug: "doomed", emailDomains: ["doomed.example"] });
      const kept = yield* seedConnection({ slug: "kept", emailDomains: ["kept.example"] });

      yield* directory.delete(OrganizationActor.application("test"), {
        organizationId: doomed.organizationId,
      });

      assert.deepStrictEqual(yield* records.listByOrganization(doomed.organizationId), []);
      assert.isTrue(Option.isNone(yield* records.findByDomain(grant, "doomed.example")));
      assert.isTrue(Option.isNone(yield* records.findById(grant, doomed.connection.id)));
      assert.isTrue(Option.isSome(yield* records.findByDomain(grant, "kept.example")));
      assert.strictEqual((yield* records.listByOrganization(kept.organizationId)).length, 1);
    }).pipe(Effect.provide(SamlLive())),
  );
});
