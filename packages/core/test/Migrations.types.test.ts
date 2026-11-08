// BEH-EA-037 (plan 22): a ledger that omits a group's migration, names one no group declares, or is
// built over two groups sharing a name does not compile.
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Migrations from "../src/Migrations.ts";

const a = Migrations.group({ first: () => Effect.void, second: () => Effect.void });
const b = Migrations.group({ third: () => Effect.void });
const clash = Migrations.group({ second: () => Effect.void });

it("the ledger is checked at compile time", () => {
  Migrations.ledger([a, b], ["first", "second", "third"]);

  // @ts-expect-error - "third" is declared by a group and missing from the order
  Migrations.ledger([a, b], ["first", "second"]);

  // @ts-expect-error - "fourth" is declared by no group
  Migrations.ledger([a, b], ["first", "second", "third", "fourth"]);

  // @ts-expect-error - two groups declare "second"
  Migrations.ledger([a, clash], ["first", "second"]);
});
