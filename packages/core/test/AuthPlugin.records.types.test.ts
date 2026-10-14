// Plan 08 (BEH-EA-T4/T5): the guarantees the type system carries for a plugin's record stores and hook
// points. These are compile-time checks (`tsc -p tsconfig.test.json` is the assertion) with a token
// runtime test so the file is a suite.
import { it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as AuthPlugin from "../src/AuthPlugin.ts";
import * as HookPoint from "../src/HookPoint.ts";

type Includes<Haystack, Needle> = [Needle] extends [Haystack] ? true : false;

class PinRecords extends Context.Service<PinRecords, { readonly count: Effect.Effect<number> }>()(
  "pins/records/PinRecords",
) {}
class PinKinds extends Context.Service<PinKinds, {}>()("pins/records/PinKinds") {}
class PinPort extends Context.Service<PinPort, {}>()("awthaq/ports/PinPort") {}
class Derived extends Context.Service<Derived, {}>()("pins/Derived") {}
class BeforePin extends HookPoint.veto<BeforePin>()(
  "pins.before",
  Schema.Struct({ id: Schema.String }),
) {}

const pinRecords = Layer.succeed(PinRecords, { count: Effect.succeed(0) });
const pinKinds = Layer.succeed(PinKinds, {});

// Without a declaration a plugin reads empty bundles, and the types say so.
class Bare extends AuthPlugin.Service<Bare, {}>()("bare", {
  apiVersion: 1,
  contract: HttpApi.make("auth"),
}) {}
export const bareDeclaresNoRecords: Includes<
  Layer.Success<typeof Bare.records.memory>,
  never
> = true;
export const bareDeclaresNoPoints: Layer.Layer<never> = Bare.hookPoints;

// A declared bundle keeps its exact layer types (no assertion widens them).
export class Pins extends AuthPlugin.Service<Pins, {}>()("pins", {
  apiVersion: 1,
  contract: HttpApi.make("auth"),
  records: { memory: pinRecords, sql: pinRecords },
  hookPoints: BeforePin.layer,
}) {
  static readonly layer = AuthPlugin.layer(Pins, {
    make: Effect.gen(function* () {
      yield* PinRecords;
      yield* BeforePin;
      return {};
    }),
  });
}
export const bundleKeepsItsStores: Includes<
  Layer.Success<typeof Pins.records.memory>,
  PinRecords
> = true;
export const pointsKeepTheirType: Includes<Layer.Success<typeof Pins.hookPoints>, BeforePin> = true;
export type PinsOut = AuthPlugin.RecordsOut<typeof Pins>;
export const recordsOutNamesTheStore: Includes<PinsOut, PinRecords> = true;
export const hookPointsOutNamesThePoint: Includes<
  AuthPlugin.HookPointsOut<typeof Pins>,
  BeforePin
> = true;

// A missing record store is a compile error naming its key.
export class Forgetful extends AuthPlugin.Service<Forgetful, {}>()("forgetful", {
  apiVersion: 1,
  contract: HttpApi.make("auth"),
}) {
  // @ts-expect-error - `pins/records/PinRecords` is required but no bundle declares it
  static readonly layer = AuthPlugin.layer(Forgetful, {
    make: Effect.gen(function* () {
      yield* PinRecords;
      return {};
    }),
  });
}

// A record store a `dependsOn` plugin's bundle provides counts as provided.
export class Borrower extends AuthPlugin.Service<Borrower, {}>()("borrower", {
  apiVersion: 1,
  contract: HttpApi.make("auth"),
}) {
  static readonly layer = AuthPlugin.layer(Borrower, {
    dependsOn: [Pins],
    make: Effect.gen(function* () {
      yield* PinRecords;
      return {};
    }),
  });
}

// An undeclared (non-core) hook point is a compile error naming its key.
export class Careless extends AuthPlugin.Service<Careless, {}>()("careless", {
  apiVersion: 1,
  contract: HttpApi.make("auth"),
}) {
  // @ts-expect-error - `awthaq/hook/pins.before` is required but no `hookPoints` declares it
  static readonly layer = AuthPlugin.layer(Careless, {
    make: Effect.gen(function* () {
      yield* BeforePin;
      return {};
    }),
  });
}

// memory and sql must provide the same stores.
// @ts-expect-error - `pins/records/PinKinds` is in memory but not in sql
export class Lopsided extends AuthPlugin.Service<Lopsided, {}>()("lopsided", {
  apiVersion: 1,
  contract: HttpApi.make("auth"),
  records: { memory: Layer.mergeAll(pinRecords, pinKinds), sql: pinRecords },
}) {}

// A bundle provides record stores and nothing else: a port, or a derived service, is refused.
// @ts-expect-error - a /ports/ service is not a record store
export class Smuggler extends AuthPlugin.Service<Smuggler, {}>()("smuggler", {
  apiVersion: 1,
  contract: HttpApi.make("auth"),
  records: {
    memory: Layer.mergeAll(pinRecords, Layer.succeed(PinPort, {})),
    sql: Layer.mergeAll(pinRecords, Layer.succeed(PinPort, {})),
  },
}) {}
// @ts-expect-error - a derived service is not a record store
export class Deriver extends AuthPlugin.Service<Deriver, {}>()("deriver", {
  apiVersion: 1,
  contract: HttpApi.make("auth"),
  records: {
    memory: Layer.mergeAll(pinRecords, Layer.succeed(Derived, {})),
    sql: Layer.mergeAll(pinRecords, Layer.succeed(Derived, {})),
  },
}) {}

it("the guarantees above are checked by the compiler", () => {});
