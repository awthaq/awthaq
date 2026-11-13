// @awthaq/test — helpers shared by more than one StoreContract port suite (plan 37)
import { Ids, Sealed } from "@awthaq/ports";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

/** A sealed optional cell opened to its plaintext (plan 17: the sealed columns cross the ports unopened). */
export const opened = (value: Option.Option<Sealed.Sealed<string>>) =>
  Effect.map(Sealed.openOption(value), Option.map(Redacted.value));

export const at = (minutes: number) => DateTime.makeUnsafe(1_700_000_000_000 + minutes * 60_000);

export const makeUserId = Schema.decodeUnknownSync(Ids.UserId);
