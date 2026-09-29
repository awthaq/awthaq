// @awthaq/cli — Sources
//
// spec/behaviors/26-cli.md BEH-EA-207, decision 07 §6 (BAM-001, FAMS-010): the `SourceAdapter`
// interface and the registry `awthaq import --from <source>` is derived from.
//
// An adapter *opens* a source and yields rows, each carrying its own lazily-run mapping onto
// `UserImport.ImportUserInput` (what `UserImport.importUser` takes: an identity, a verified flag, credentials). The
// mapping closes over the row's own decoded type, so the registry is heterogeneous without a cast:
// the CLI never sees a source's row type, only `{ id, map }`. Everything a source needs to be open
// (a database client, a parsed hash config) is acquired in `open` and released with the scope.
//
// Registered: `better-auth` (validated against a real better-auth 1.7.6 export, in
// `@awthaq/migrate-better-auth`) and `firebase` (`@awthaq/migrate-firebase`). `authjs` and `lucia`
// are registered so the command surface — and the `--from` Schema, which is derived from this
// registry — names the whole target, and refuse with `NotYetValidated` rather than fabricate a
// best-effort mapping (BEH-EA-207; the same posture as BEH-EA-039's schema-diff planner).

import type { UserImport } from "@awthaq/core";
import { BetterAuthSource } from "@awthaq/migrate-better-auth";
import { ImportFirebaseUser } from "@awthaq/migrate-firebase";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { NotYetValidated, SourceUnavailable, UsageError } from "./CliErrors.ts";
import * as Database from "./Database.ts";

/** The decoded `--source` and friends: where the export is, plus what only the operator knows. */
export interface ImportSource {
  /** `--source`: a database URL (`better-auth`) or a file path (`firebase`). */
  readonly location: string;
  /** `--source-option key=value`: adapter-specific inputs (`firebase`: `hash-config=<file>`). */
  readonly options: Readonly<Record<string, string>>;
  /** `--issuer provider=issuer`: the BEH-EA-125 issuer per awthaq provider id, which no export contains. */
  readonly issuers: Readonly<Record<string, string>>;
  readonly batchSize: number;
}

/** What one source row becomes: the write shape plus what had no destination. */
export interface MappedInput {
  readonly sourceRowId: string;
  readonly user: UserImport.ImportUserInput;
  /** `table.column` (or `field`) of source data with no awthaq equivalent — reported, never dropped. */
  readonly unmapped: ReadonlyArray<string>;
}

/** A row that can never be imported as it stands (and why): reported, skipped, retried on a later run. */
export class Unmappable extends Data.TaggedError("Unmappable")<{
  readonly sourceRowId: string;
  readonly reason: string;
}> {}

export interface SourceRow {
  readonly id: string;
  readonly map: Effect.Effect<MappedInput, Unmappable>;
}

export interface TableCount {
  readonly rows: number;
  /** `false` for a table that is read for the plan only; `note` says where its data goes instead. */
  readonly imported: boolean;
  readonly note?: string | undefined;
}

export interface OpenSource {
  /** Row counts per source table, for the plan. */
  readonly tables: Effect.Effect<Readonly<Record<string, TableCount>>, SourceUnavailable>;
  readonly rows: Stream.Stream<SourceRow, SourceUnavailable>;
}

export interface SourceAdapter {
  readonly name: string;
  /**
   * `true` once the adapter has been built and tested against a real export from that source. An
   * adapter that is not validated is registered (so `--from` names it) and refused at run time.
   */
  readonly validated: boolean;
  readonly open: (
    source: ImportSource,
  ) => Effect.Effect<
    OpenSource,
    SourceUnavailable | UsageError | NotYetValidated,
    FileSystem.FileSystem | Scope.Scope
  >;
}

const unavailable = (message: string) => () => new SourceUnavailable({ message });

const betterAuth: SourceAdapter = {
  name: "better-auth",
  validated: true,
  open: (source) =>
    Effect.gen(function* () {
      const decoded = yield* Effect.try({
        try: () => Database.decodeUrl(source.location),
        catch: () =>
          new UsageError({
            message:
              "--source for better-auth must be the better-auth database: sqlite:<path> or postgres://…",
          }),
      });
      const context = yield* Layer.build(Database.layerFor(decoded, { readonly: true })).pipe(
        Effect.mapError(unavailable("could not open the better-auth source database")),
      );
      const tables = BetterAuthSource.counts.pipe(
        Effect.provide(context),
        Effect.map(
          (counts): Readonly<Record<string, TableCount>> => ({
            user: { rows: counts.user, imported: true },
            account: { rows: counts.account, imported: true },
            session: {
              rows: counts.session,
              imported: false,
              note: "live sessions are bridged on their next request by LegacySessionBridgeLive (BAM-003)",
            },
            verification: {
              rows: counts.verification,
              imported: false,
              note: "short-lived verification tokens are not carried over",
            },
          }),
        ),
        Effect.mapError(unavailable("could not read the better-auth source database")),
      );
      const rows = BetterAuthSource.read({ batchSize: source.batchSize }).pipe(
        Stream.provide(context),
        Stream.mapError(unavailable("could not read the better-auth source database")),
        Stream.map(
          (raw): SourceRow => ({
            id: typeof raw.user["id"] === "string" ? raw.user["id"] : "(no id)",
            map: BetterAuthSource.mapUser(raw, { issuers: source.issuers }).pipe(
              Effect.mapError(
                (error) => new Unmappable({ sourceRowId: error.sourceRowId, reason: error.reason }),
              ),
            ),
          }),
        ),
      );
      const open: OpenSource = { tables, rows };
      return open;
    }),
};

const firebase: SourceAdapter = {
  name: "firebase",
  validated: true,
  open: (source) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const hashConfigPath = source.options["hash-config"];
      const config =
        hashConfigPath === undefined
          ? undefined
          : yield* ImportFirebaseUser.readHashConfig(hashConfigPath).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.mapError(
                unavailable("could not read the Firebase hash config (--source-option hash-config=<file>)"),
              ),
            );
      const users = ImportFirebaseUser.readUsers(source.location).pipe(
        Stream.provideService(FileSystem.FileSystem, fs),
        Stream.mapError(unavailable("could not read the Firebase users export")),
      );
      const tables = Stream.runCount(users).pipe(
        Effect.map(
          (rows): Readonly<Record<string, TableCount>> => ({ users: { rows, imported: true } }),
        ),
      );
      const rows = users.pipe(
        Stream.map(
          (raw): SourceRow => ({
            id:
              typeof raw === "object" && raw !== null && "localId" in raw && typeof raw.localId === "string"
                ? raw.localId
                : "(no localId)",
            map: ImportFirebaseUser.mapUser(raw, { config, issuers: source.issuers }).pipe(
              Effect.mapError(
                (error) => new Unmappable({ sourceRowId: error.sourceRowId, reason: error.reason }),
              ),
            ),
          }),
        ),
      );
      const open: OpenSource = { tables, rows };
      return open;
    }),
};

/** Registered but refused: `--from` names the whole target; nothing is fabricated until it is validated. */
const notValidated = (name: string): SourceAdapter => ({
  name,
  validated: false,
  open: () =>
    Effect.fail(
      new NotYetValidated({
        source: name,
        message: `import --from ${name} is registered but not yet validated against a real export (validated: ${validatedNames().join(", ")}); refusing rather than fabricating a mapping`,
      }),
    ),
});

const adapterList: ReadonlyArray<SourceAdapter> = [
  betterAuth,
  firebase,
  notValidated("authjs"),
  notValidated("lucia"),
];

/** The registry, by name. */
export const adapters: ReadonlyMap<string, SourceAdapter> = new Map(
  adapterList.map((adapter) => [adapter.name, adapter]),
);

/** BEH-EA-226: the `--from` Schema's members are exactly the registered adapter names. */
export const sourceNames: ReadonlyArray<string> = adapterList.map((adapter) => adapter.name);

function validatedNames() {
  return adapterList.filter((adapter) => adapter.validated).map((adapter) => adapter.name);
}

