// @awthaq/cli — the awthaq command line
//
// doctor, config list, plugin list --graph, routes, migration status|apply, openapi,
// seed admin, import, login|logout|whoami — reads the plugin manifest, never serves the
// application (spec/behaviors/26-cli.md, BEH-EA-201–208 and 225–229; ADR-EA-027).
// See spec/overview.md for the full package map.

export * as Browser from "./Browser.ts";
export * as Cli from "./Cli.ts";
export * as CliErrors from "./CliErrors.ts";
export * as Config from "./Config.ts";
export * as ConfigList from "./ConfigList.ts";
// P20a: the credential service every session command needs, so an embedder (the BDD suite) can supply its own store.
export * as CredentialStore from "./CredentialStore.ts";
export * as Database from "./Database.ts";
export * as DeviceLogin from "./DeviceLogin.ts";
export * as Doctor from "./Doctor.ts";
export * as Migration from "./Migration.ts";
export * as Openapi from "./Openapi.ts";
export * as Output from "./Output.ts";
export * as Plugin from "./Plugin.ts";
export * as Routes from "./Routes.ts";
export * as Seed from "./Seed.ts";
