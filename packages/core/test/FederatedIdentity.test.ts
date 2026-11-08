// ADR-EA-043, BEH-EA-338 over memory. The cases live in `support/federatedIdentitySuite.ts` so
// `FederatedIdentitySql.test.ts` runs the very same ones over SQLite (and Postgres under `pnpm test:pg`).
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { SqlTransaction } from "@awthaq/ports";
import * as Layer from "effect/Layer";
import * as Accounts from "../src/Accounts.ts";
import * as AuditLog from "../src/AuditLog.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import * as Persistence from "../src/Persistence.ts";
import * as Sessions from "../src/Sessions.ts";
import * as Users from "../src/Users.ts";
import { decorate, type EnvOptions, suite, tap } from "./support/federatedIdentitySuite.ts";

const memory = Layer.mergeAll(
  Users.layer.pipe(Layer.provide(Persistence.memory)),
  Accounts.layer.pipe(Layer.provide(Persistence.memory)),
  Sessions.layer.pipe(Layer.provide(Persistence.memory)),
).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layer.pipe(Layer.provide(Persistence.memory))),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(SqlTransaction.layerNoop),
);

suite("memory", (options: EnvOptions = {}) =>
  Layer.provideMerge(tap(options), Layer.provideMerge(decorate(options), memory)),
);
