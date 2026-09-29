// MA-008/ESS-011: identity brands are declared once, in `@awthaq/sql`; core
// re-exports the type and keeps only a nominal constructor over it. If either
// side renamed a brand key, these assertions (and `pnpm run typecheck`) fail.
import { Models as SqlModels } from "@awthaq/sql";
import { describe, expectTypeOf, it } from "vitest";
import * as Accounts from "../src/Accounts.ts";
import * as Sessions from "../src/Sessions.ts";
import * as Users from "../src/Users.ts";
import * as Verification from "../src/Verification.ts";

describe("identity brands (MA-008)", () => {
  it("core ids are the same types as @awthaq/sql's branded schemas", () => {
    expectTypeOf<Users.UserId>().toEqualTypeOf<SqlModels.UserId>();
    expectTypeOf<Accounts.AccountId>().toEqualTypeOf<SqlModels.AccountId>();
    expectTypeOf<Sessions.SessionId>().toEqualTypeOf<SqlModels.SessionId>();
    expectTypeOf<Verification.VerificationTokenId>().toEqualTypeOf<SqlModels.VerificationTokenId>();
  });

  it("core keeps a nominal constructor over each sql-owned id", () => {
    expectTypeOf(Users.UserId("u")).toEqualTypeOf<SqlModels.UserId>();
    expectTypeOf(Accounts.AccountId("a")).toEqualTypeOf<SqlModels.AccountId>();
    expectTypeOf(Sessions.SessionId("s")).toEqualTypeOf<SqlModels.SessionId>();
    expectTypeOf(
      Verification.VerificationTokenId("v"),
    ).toEqualTypeOf<SqlModels.VerificationTokenId>();
  });
});
