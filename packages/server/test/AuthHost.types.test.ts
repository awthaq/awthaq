// BEH-EA-340 (BEH-EA-014 through `AuthHost`, plan 15): `AuthHost.layer`'s requirements are exactly what the host owns, its
// required options are required, and a tap on an undeclared point stays in `RIn`. Compile-time checks
// (`tsc -p tsconfig.test.json` is the assertion) with a token runtime test so the file is a suite.
import { Auth, AuthPlugin, HookPoint, Users } from "@awthaq/core";
import { ClientAddress, type Encryption, RateLimiter } from "@awthaq/ports";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { it } from "@effect/vitest";
import type * as Digest from "effect/crypto/Digest";
import type * as Mac from "effect/crypto/Mac";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import * as AuthHost from "../src/AuthHost.ts";
import { AfterLedgerEntry, Ledger } from "./support/LedgerPlugin.ts";
import * as HostPorts from "./support/HostPorts.ts";
import * as Wiring from "./support/Wiring.ts";

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Includes<A, B> = [B] extends [A] ? true : false;

const built = Auth.make([Ledger]);
const csrf = Wiring.csrfConfig();

const memory = AuthHost.layer(built, { persistence: { records: "memory" }, csrf });
const sql = AuthHost.layer(built, {
  persistence: {
    records: "sql",
    client: SqliteClient.layer({ filename: ":memory:" }),
    migrations: "apply",
  },
  csrf,
});

/**
 * What core plus `Ledger` leaves to the host: the limiter, the client-address topology (the request context's
 * populator reads it, ADR-EA-047), the platform crypto, the HTTP platform.
 */
type HostOwned =
  | RateLimiter.RateLimiter
  | ClientAddress.ClientAddress
  | SecureRandom.SecureRandom
  | Digest.Digest
  | Mac.Mac
  | AuthHost.Serving;

// 25: memory mode requires exactly the host-owned set.
export const memoryRequiresTheHostOwnedSet: Equals<Layer.Services<typeof memory>, HostOwned> = true;

// 26: sql mode adds only `Encryption` (core's SQL account store seals provider tokens); the client's own requirement is `never`.
export const sqlRequiresTheHostOwnedSetAndEncryption: Equals<
  Layer.Services<typeof sql>,
  HostOwned | Encryption.Encryption
> = true;

// 27: every port but the limiter leaves the limiter, so the layer is not launchable. Never called.
const withoutLimiter = memory.pipe(
  Layer.provide(HostPorts.Platform),
  Layer.provide(HostPorts.Crypto),
);
export const notLaunchable = () =>
  // @ts-expect-error - `RateLimiter` is still required
  // @effect-diagnostics-next-line missingEffectContext:off
  Effect.runPromise(Layer.launch(withoutLimiter));
const withLimiter = withoutLimiter.pipe(
  Layer.provide(Layer.merge(RateLimiter.layerPermissive, ClientAddress.layerDirect)),
);
export const launchable = () => Effect.runPromise(Layer.launch(withLimiter));

// 28: sql mode without `migrations` does not compile. Never called (the options are incomplete on purpose).
export const sqlWithoutMigrations = () =>
  AuthHost.layer(built, {
    // @ts-expect-error `migrations` is required with `records: "sql"`
    persistence: { records: "sql", client: SqliteClient.layer({ filename: ":memory:" }) },
    csrf,
  });

// 29: `csrf` and `persistence` are required. Never called.
export const withoutCsrf = () =>
  // @ts-expect-error `csrf` is required
  AuthHost.layer(built, { persistence: { records: "memory" } });
export const withoutPersistence = () =>
  // @ts-expect-error `persistence` is required
  AuthHost.layer(built, { csrf });

// 30: a tap on a point no composed plugin declares stays in `RIn` (INV-EA-005 through `AuthHost`).
class Foreign extends HookPoint.observe<Foreign>()("foreign.after", Schema.Struct({})) {}
const tappedForeign = AuthHost.layer(built, {
  persistence: { records: "memory" },
  csrf,
  taps: Foreign.tap(() => Effect.void),
});
export const foreignPointStaysRequired: Includes<
  Layer.Services<typeof tappedForeign>,
  Foreign
> = true;
const tappedOwn = AuthHost.layer(built, {
  persistence: { records: "memory" },
  csrf,
  taps: AfterLedgerEntry.tap(() => Effect.void),
});
export const declaredPointIsProvided: Equals<Layer.Services<typeof tappedOwn>, HostOwned> = true;

// 31: the output carries the records, the points, core's services and (sql only) the client.
export const outputCarriesTheComposition: Includes<
  Layer.Success<typeof memory>,
  AuthPlugin.RecordsOut<typeof Ledger> | AuthPlugin.HookPointsOut<typeof Ledger> | Users.Users
> = true;
export const sqlOutputCarriesTheClient: Includes<
  Layer.Success<typeof sql>,
  SqlClient.SqlClient
> = true;
export const memoryOutputHasNoClient: Includes<
  Layer.Success<typeof memory>,
  SqlClient.SqlClient
> = false;

it("the guarantees above are checked by the compiler", () => {});
