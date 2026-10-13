// The shared plugin-contract harness (docs/plugin-authoring.md checklist item 6, `pnpm check:contract-tests`): manifest legality, group ids, table prefixes, migration determinism, the records bundle's parity, and the plugin's own hook taps
// for `Saml` and `Sso`. Both need an XML-signature adapter, a metadata fetcher and `SamlConfig` (the suites' fakes), so their composition-builds check stays opt-out.
import { TestAuth } from "@awthaq/test";
import { describe, it } from "@effect/vitest";
import * as Saml from "../src/Saml.ts";
import * as Sso from "../src/Sso.ts";

const framework = TestAuth.throwingFramework(describe, it);

TestAuth.runPluginContractTests(framework, () => Saml.Saml, { options: [{}] });
TestAuth.runPluginContractTests(framework, () => Sso.Sso, { options: [{}] });
