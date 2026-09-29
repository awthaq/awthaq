// A real composition for the CLI suites: `Auth.make([...])` over shipped plugins, never a fake
// manifest, so `routes`, `migration` and `doctor` are exercised against what an application
// actually exports from `awthaq.config.ts`.
import { Auth } from "@awthaq/core";
import { Password } from "@awthaq/password";
import { Roles } from "@awthaq/roles";
import type * as CliConfigModule from "../../src/Config.ts";

/** Password + Roles: HTTP groups (`password`, `password.account`) and the roles table. */
export const passwordAndRoles = Auth.make([Password.Password, Roles.Roles]);

export const configOf = (
  auth: CliConfigModule.LoadedAuth,
  extra?: Partial<Omit<CliConfigModule.CliConfig, "auth">>,
): CliConfigModule.CliConfig => ({
  auth,
  config: undefined,
  sql: undefined,
  app: undefined,
  production: undefined,
  ...extra,
});
