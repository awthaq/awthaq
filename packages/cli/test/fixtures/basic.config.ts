// A configuration module as an application would write it: the composition, plus the optional
// Layers a database-backed command needs.
import { Auth } from "@awthaq/core";
import { Password } from "@awthaq/password";
import { Roles } from "@awthaq/roles";
import { defineConfig } from "../../src/Config.ts";

export default defineConfig({
  auth: Auth.make([Password.Password, Roles.Roles]),
  production: true,
});
