// A configuration module whose default export is an Effect producing the composition (an
// application that needs some setup first).
import { Auth } from "@awthaq/core";
import { Password } from "@awthaq/password";
import * as Effect from "effect/Effect";

export default Effect.sync(() => Auth.make([Password.Password]));
