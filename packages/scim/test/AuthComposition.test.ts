// ADR-EA-040: `Scim` composes only beside `Organization`. It requires the system modules `Organization.layer`
// exposes, so the plugin tuple must list the organization plugin first, and `dependsOn` is what puts it there.
import { Auth } from "@awthaq/core";
import { Organization } from "@awthaq/organization";
import { assert, describe, it } from "@effect/vitest";
import * as Scim from "../src/Scim.ts";

describe("Auth.make([Organization, Scim])", () => {
  it("composes: Scim depends on Organization, and Organization's exposed modules are in the manifest", () => {
    const auth = Auth.make([Organization.Organization, Scim.Scim]);
    const plugin = auth.manifest.plugins.find((entry) => entry.id === "scim");
    assert.deepStrictEqual(plugin?.dependsOn, ["organization"]);
    assert.isTrue(
      auth.manifest.exposes.some(
        (exposed) => exposed.key === "awthaq/plugin/organization/Directory",
      ),
    );
  });

  it("refuses Scim without its organization plugin (a compile-time rule)", () => {
    // @ts-expect-error plugin "scim" depends on plugin "organization", which is not in the list
    Auth.make([Scim.Scim]);
    assert.strictEqual(Scim.Scim.dependsOn.length, 1);
  });
});
