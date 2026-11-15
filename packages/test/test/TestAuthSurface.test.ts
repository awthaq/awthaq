// TEST-01, architecture deepening batch 3 phase 2: pins the TestAuth facade's value names at runtime and its type names at compile time, green before and after the split into internal/.
import { assert, it } from "@effect/vitest";
import * as TestAuth from "../src/TestAuth.ts";

export type {
  AgentOptions,
  App,
  AppNeeds,
  CommonOptions,
  ContractTestOptions,
  FoundationServices,
  KeyedProbe,
  LazyApp,
  ListeningApp,
  MemoryMode,
  MethodClass,
  Probe,
  RecordsOption,
  RequestInit,
  RetentionRegistryService,
  SealedColumnConfig,
  ServeOptions,
  SignInOptions,
  SignedInAgent,
  SignedInSession,
  SqlMode,
  TableCase,
  TenantIsolationConfig,
  TestFramework,
} from "../src/TestAuth.ts";

it("the TestAuth value surface is exactly these 23 names", () => {
  assert.deepStrictEqual(Object.keys(TestAuth).sort(), [
    "TestCsrfConfig",
    "buildContext",
    "csrfSetCookie",
    "csrfToken",
    "encryption",
    "httpClient",
    "layer",
    "lazyApp",
    "listen",
    "memoryFoundation",
    "migratedSchema",
    "openApps",
    "recordModes",
    "runPluginContractTests",
    "runSealedColumnTests",
    "runTenantIsolationTests",
    "serve",
    "sessionSetCookie",
    "signInAs",
    "throwingFramework",
    "withApp",
    "withRequest",
    "withoutRequest",
  ]);
});
