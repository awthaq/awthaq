// The smallest configuration module: the bare composition as the default export.
import { Auth } from "@awthaq/core";
import { Password } from "@awthaq/password";

export default Auth.make([Password.Password]);
