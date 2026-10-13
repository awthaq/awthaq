// @awthaq/organization — who an invitation is addressed to (package-private)

import { Users } from "@awthaq/core";
import * as Option from "effect/Option";

/** FAMS-002: an invitation names an email address; only an Email-identity user can own one (`emailOf` is already lower-cased, as invitation emails are stored). */
export const ownsEmail = (user: Users.UserRecord, email: string): boolean =>
  Option.exists(Users.emailOf(user), (own) => own === email);
