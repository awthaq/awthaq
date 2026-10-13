// ADR-EA-040: `Saml` composes only beside `Organization`. It requires the system modules `Organization.layer`
// exposes, so the plugin tuple must list the organization plugin first, and `dependsOn` is what puts it there.
import { Auth } from "@awthaq/core";
import { Organization } from "@awthaq/organization";
import { assert, describe, it } from "@effect/vitest";
import * as Saml from "../src/Saml.ts";

describe("Auth.make([Organization, Saml])", () => {
  it("composes: Saml depends on Organization, and Organization's exposed modules are in the manifest", () => {
    const auth = Auth.make([Organization.Organization, Saml.Saml]);
    const plugin = auth.manifest.plugins.find((entry) => entry.id === "saml");
    assert.deepStrictEqual(plugin?.dependsOn, ["organization"]);
    assert.isTrue(
      auth.manifest.exposes.some(
        (exposed) => exposed.key === "awthaq/plugin/organization/Directory",
      ),
    );
  });

  it("refuses Saml without its organization plugin (a compile-time rule)", () => {
    // @ts-expect-error plugin "saml" depends on plugin "organization", which is not in the list
    Auth.make([Saml.Saml]);
    assert.strictEqual(Saml.Saml.dependsOn.length, 1);
  });
});
