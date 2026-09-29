// @awthaq/cli — CliErrors
//
// spec/behaviors/26-cli.md BEH-EA-225 (ECS-001, CTA-003): every CLI command
// exits with the code its typed error carries. Each class below sets
// `[Runtime.errorExitCode]` itself, so the mapping is fixed at compile time and
// no command ever sets the process status by hand; the entry point runs the
// root command with `NodeRuntime.runMain`, whose teardown honors the marker.
// `[Runtime.errorReported] = false` because the CLI renders its own message
// (`Output.failure`) — leaving the default would print the whole `Cause` again.
//
// Exit codes (BEH-EA-225):
//   0 success · 1 defect · 2 usage · 3 doctor findings · 4 nothing to apply
//   5 a write failed · 6 refused without confirmation · 7 ledger drift
//   8 authentication required · 9 environment or capability unavailable

import * as Data from "effect/Data";
import * as Runtime from "effect/Runtime";

/** The whole table in one place, so the spec, the tests and the classes read the same numbers. */
export const ExitCode = {
  usage: 2,
  doctorFindings: 3,
  nothingToApply: 4,
  writeFailed: 5,
  confirmationRequired: 6,
  ledgerDrift: 7,
  authenticationRequired: 8,
  unavailable: 9,
} as const;

/** BEH-EA-226: a flag or argument failed its Schema, or `--from` named an adapter that is not validated. */
export class UsageError extends Data.TaggedError("UsageError")<{ readonly message: string }> {
  override readonly [Runtime.errorExitCode] = ExitCode.usage;
  override readonly [Runtime.errorReported] = false;
}

/** BEH-EA-207: `authjs`/`lucia` are registered so `--from` names the whole target, and refuse rather than fabricate a mapping. */
export class NotYetValidated extends Data.TaggedError("NotYetValidated")<{
  readonly source: string;
  readonly message: string;
}> {
  override readonly [Runtime.errorExitCode] = ExitCode.usage;
  override readonly [Runtime.errorReported] = false;
}

/** BEH-EA-201: doctor reported at least one finding. `count` is what the report already printed. */
export class DoctorFindings extends Data.TaggedError("DoctorFindings")<{
  readonly count: number;
  readonly message: string;
}> {
  override readonly [Runtime.errorExitCode] = ExitCode.doctorFindings;
  override readonly [Runtime.errorReported] = false;
}

/** BEH-EA-204: `migration apply` had nothing pending (`--allow-empty` maps this to success). */
export class NothingToApply extends Data.TaggedError("NothingToApply")<{
  readonly message: string;
}> {
  override readonly [Runtime.errorExitCode] = ExitCode.nothingToApply;
  override readonly [Runtime.errorReported] = false;
}

/** BEH-EA-204: the migrator failed mid-apply; the batch is one transaction, so nothing of it is applied. */
export class MigrationFailed extends Data.TaggedError("MigrationFailed")<{
  readonly message: string;
}> {
  override readonly [Runtime.errorExitCode] = ExitCode.writeFailed;
  override readonly [Runtime.errorReported] = false;
}

/** BEH-EA-207: an import stopped on a failed batch; the checkpoint stays at the last committed one. */
export class ImportFailed extends Data.TaggedError("ImportFailed")<{
  readonly runId: string;
  readonly message: string;
}> {
  override readonly [Runtime.errorExitCode] = ExitCode.writeFailed;
  override readonly [Runtime.errorReported] = false;
}

/** BEH-EA-204/206/207: a write was refused because its confirmation (`--yes`, `--force`) was not given. */
export class ConfirmationRequired extends Data.TaggedError("ConfirmationRequired")<{
  readonly command: "migration apply" | "import" | "seed admin";
  readonly message: string;
}> {
  override readonly [Runtime.errorExitCode] = ExitCode.confirmationRequired;
  override readonly [Runtime.errorReported] = false;
}

/** BEH-EA-204: a ledger holds an id or name the linker does not know, or a pending id sorts before an applied one. */
export class LedgerDrift extends Data.TaggedError("LedgerDrift")<{
  readonly message: string;
}> {
  override readonly [Runtime.errorExitCode] = ExitCode.ledgerDrift;
  override readonly [Runtime.errorReported] = false;
}

/** BEH-EA-227: no valid credential (none stored, or the server rejected it). */
export class AuthenticationRequired extends Data.TaggedError("AuthenticationRequired")<{
  readonly message: string;
}> {
  override readonly [Runtime.errorExitCode] = ExitCode.authenticationRequired;
  override readonly [Runtime.errorReported] = false;
}

/** The configuration module could not be found, loaded, or does not export a composition. */
export class ConfigUnavailable extends Data.TaggedError("ConfigUnavailable")<{
  readonly message: string;
}> {
  override readonly [Runtime.errorExitCode] = ExitCode.unavailable;
  override readonly [Runtime.errorReported] = false;
}

/** The database a database-backed command needs could not be reached (or no connection was configured). */
export class DatabaseUnavailable extends Data.TaggedError("DatabaseUnavailable")<{
  readonly message: string;
}> {
  override readonly [Runtime.errorExitCode] = ExitCode.unavailable;
  override readonly [Runtime.errorReported] = false;
}

/** BEH-EA-227: the auth server could not be reached (or answered something that is not the contract). */
export class ServerUnavailable extends Data.TaggedError("ServerUnavailable")<{
  readonly message: string;
}> {
  override readonly [Runtime.errorExitCode] = ExitCode.unavailable;
  override readonly [Runtime.errorReported] = false;
}

/** BEH-EA-307: interactive `login` reached a server that does not serve the device authorization endpoints (the plugin is not installed); `login --token` is the path. */
export class DeviceAuthorizationUnavailable extends Data.TaggedError(
  "DeviceAuthorizationUnavailable",
)<{
  readonly message: string;
}> {
  override readonly [Runtime.errorExitCode] = ExitCode.unavailable;
  override readonly [Runtime.errorReported] = false;
}

/** BEH-EA-207: the import source (a database, an export file) could not be opened or read. */
export class SourceUnavailable extends Data.TaggedError("SourceUnavailable")<{
  readonly message: string;
}> {
  override readonly [Runtime.errorExitCode] = ExitCode.unavailable;
  override readonly [Runtime.errorReported] = false;
}

/** BEH-EA-206: there is no administrative role concept without the Roles plugin installed. */
export class RolesNotInstalled extends Data.TaggedError("RolesNotInstalled")<{
  readonly message: string;
}> {
  override readonly [Runtime.errorExitCode] = ExitCode.unavailable;
  override readonly [Runtime.errorReported] = false;
}

/**
 * BEH-EA-201: `Auth.make` refused the composition while the configuration module was evaluated
 * (a `dependsOn` cycle, a duplicate group id, a route conflict). `doctor` reports it as a
 * finding; any other command cannot run without a composition, so it fails with this.
 */
export class LinkProblem extends Data.TaggedError("LinkProblem")<{
  readonly code: string;
  readonly message: string;
}> {
  override readonly [Runtime.errorExitCode] = ExitCode.unavailable;
  override readonly [Runtime.errorReported] = false;
}

/** The application Layer a command needs was not exported by the configuration module. */
export class ApplicationUnavailable extends Data.TaggedError("ApplicationUnavailable")<{
  readonly message: string;
}> {
  override readonly [Runtime.errorExitCode] = ExitCode.unavailable;
  override readonly [Runtime.errorReported] = false;
}

/** Every typed failure a command can end with — what `Output.failure` renders and `--json` documents. */
export type CliError =
  | UsageError
  | NotYetValidated
  | DoctorFindings
  | NothingToApply
  | MigrationFailed
  | ImportFailed
  | ConfirmationRequired
  | LedgerDrift
  | AuthenticationRequired
  | ConfigUnavailable
  | DatabaseUnavailable
  | RolesNotInstalled
  | SourceUnavailable
  | ServerUnavailable
  | DeviceAuthorizationUnavailable
  | LinkProblem
  | ApplicationUnavailable;

const cliTags: ReadonlySet<string> = new Set([
  "UsageError",
  "NotYetValidated",
  "DoctorFindings",
  "NothingToApply",
  "MigrationFailed",
  "ImportFailed",
  "ConfirmationRequired",
  "LedgerDrift",
  "AuthenticationRequired",
  "ConfigUnavailable",
  "DatabaseUnavailable",
  "RolesNotInstalled",
  "SourceUnavailable",
  "ServerUnavailable",
  "DeviceAuthorizationUnavailable",
  "LinkProblem",
  "ApplicationUnavailable",
]);

/** Narrows an unknown failure to a typed CLI error, so the entry point can render it without a cast. */
export const isCliError = (u: unknown): u is CliError =>
  typeof u === "object" &&
  u !== null &&
  "_tag" in u &&
  typeof u._tag === "string" &&
  cliTags.has(u._tag) &&
  "message" in u &&
  typeof u.message === "string";
