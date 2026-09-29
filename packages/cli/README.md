# @awthaq/cli

The `awthaq` command line: inspect and operate an awthaq authentication runtime. It **reads the plugin manifest and never serves the application**: no command starts an HTTP listener or accepts an inbound request ([BEH-EA-208](../../spec/behaviors/26-cli.md)). Built on `effect/unstable/cli` ([ADR-EA-027](../../spec/decisions/027-cli-on-effect-unstable-cli.md)); every command body is a plain Effect function in its own module, taking typed arguments.

```text
awthaq [--config <path>] [--json]
  doctor [--build] [--production]                    link, configuration and insecure-default audit
  config list                                        every declared configuration input, default vs override
  plugin list [--graph | --hooks] [--format text|json|dot]   installed plugins in the linker's order, or each hook point's declared taps
  routes                                             every endpoint, owning plugin, middleware
  openapi [--out <file>]                             the one aggregated OpenAPI document
  migration status | apply [--yes] [--dry-run] [--allow-empty]   (--database-url)
  seed admin --email <email> [--name] [--role] [--force] [--prompt-password]
  import --from better-auth|firebase|authjs|lucia --source <export> [--yes] [--dry-run]
         [--continue-on-error] [--batch-size 100] [--report <file>] [--issuer p=i] [--source-option k=v]
  login [--token <t>] [--base-url <url>] | logout | whoami
```

Three classes of command, by what they may construct ([BEH-EA-208](../../spec/behaviors/26-cli.md)):

| Class          | Commands                                                                 | May build                                                                |
| -------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| manifest-only  | `doctor`, `config list`, `plugin list`, `routes`, `openapi`              | nothing: no Layer, no database                                           |
| database-backed | `migration status\|apply`, `seed admin`, `import`, `doctor --build`     | a `SqlClient`; for the last three the application's domain-service Layer |
| session        | `login`, `logout`, `whoami`                                              | nothing: outbound HTTP client of an already-running auth server          |

## The configuration module

The CLI operates on your application's own composition, which is a TypeScript value, so it imports it: `awthaq.config.ts` in the working directory (or `--config <path>`). The default export is the composition, an Effect producing it, or `defineConfig({...})`:

```ts
// awthaq.config.ts
import { Auth } from "@awthaq/core";
import { defineConfig } from "@awthaq/cli";
import * as Layer from "effect/Layer";
import { Password } from "@awthaq/password";
import { Roles } from "@awthaq/roles";

const auth = Auth.make([Password.Password, Roles.Roles]);

export default defineConfig({
  auth, // required: the static manifest, contract and migrations
  config: Layer.mergeAll(Roles.config([admin]), Password.config({ minLength: 14 })), // optional: your configuration overrides
  sql: SqlLive, // optional: the SQL client for migration/import (else --database-url)
  app: AppLive, // optional: auth.layer with every port and the SQL client provided — for seed/import/doctor --build
  production: true, // optional: overrides NODE_ENV for the audit
});
```

`app` must expose the `SqlClient` (`Layer.provideMerge`) for `import`, which keeps its checkpoint next to the users it writes. A TypeScript config needs a runtime that can load `.ts` (Node with native type stripping, Bun, or `tsx awthaq …`).

## Exit codes ([BEH-EA-225](../../spec/behaviors/26-cli.md))

Every failure is a typed error carrying its code as `[Runtime.errorExitCode]`; `--json` prints the same `_tag` and code on stderr.

| Code | Meaning                                                                     |
| ---- | --------------------------------------------------------------------------- |
| 0    | success / clean report                                                      |
| 1    | unexpected defect                                                           |
| 2    | usage error (bad flag or argument, unknown or not-yet-validated `--from`)   |
| 3    | `doctor` found problems                                                     |
| 4    | `migration apply` had nothing to apply (`--allow-empty` maps it to 0)       |
| 5    | a write failed (migration, import batch)                                    |
| 6    | refused without confirmation (`--yes`, `--force`)                           |
| 7    | migration ledger drift                                                      |
| 8    | authentication required or expired                                          |
| 9    | environment or capability unavailable (no config module, no database, no Roles plugin, server unreachable, no application Layer, device flow) |

## Migrations

Core's tables (`effect_sql_migrations`, ids 1–20) and the plugins' (`awthaq_plugin_migrations`, positions in the linker's order) are **two ledgers and two id spaces** ([BEH-EA-038](../../spec/behaviors/05-persistence-stratum.md)); `status` and `apply` read and advance both. `status` is read-only (it never creates a ledger) and fails with exit 7 on drift: an applied id or name the linker does not know, or a pending id that sorts before an applied one, which `Migrator` would silently skip. `apply` prints the ordered pending plan first, refuses on drift, and needs `--yes`.

On Postgres the CLI registers the client-scoped `regclass` codec `@effect/sql-pg` 4.0.0-rc.116 lacks (see [`packages/sql/README.md`](../sql/README.md)), so a re-run on an already-migrated database works; `?search_path=auth` on the URL picks the schema. Pass the URL through `AWTHAQ_DATABASE_URL` rather than `--database-url` (argv shows in process listings).

## Import

`import --from <source> --source <export>` migrates users through `Users` and `Accounts`, never raw INSERTs. **Plan mode is the default** (and `--dry-run` forces it): the whole export is read and mapped, and it prints per-table counts, the unmapped-field report and conflict counts, and writes nothing. `--yes` writes in bounded batches, **each in one transaction**; a failed batch rolls back only itself, is reported with its source row ids, and stops the run (`--continue-on-error` keeps going). The `awthaq_import_runs` table is the checkpoint: re-run the same command and it resumes, never inserting a row twice. Each `--yes` run publishes `auth.import.completed` / `auth.import.failed` (audited).

| Source        | Status                                                                                                                              |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `better-auth` | validated against a real better-auth 1.7.6 export; `--source sqlite:<path>` or `postgres://…`; password hashes verified by `BetterAuthScryptVerifier` |
| `firebase`    | `--source users.json --source-option hash-config=hash_config.json`; the published firebase/scrypt vector verifies                    |
| `authjs`, `lucia` | registered so `--from` names the whole target; refused with a typed not-yet-validated error (exit 2)                            |

A federated account's issuer ([BEH-EA-125](../../spec/behaviors/16-oauth.md)) is not in any export: pass `--issuer github=https://github.com` with the value your OAuth provider config sets. Rows that cannot be imported as they stand (an email-less Firebase user, a disabled one) are reported, skipped and retried on the next run; `--report <file>` writes the per-row detail.

## Session commands and credentials

`login --token` (or `AWTHAQ_TOKEN` + `AWTHAQ_BASE_URL`) validates the token against `GET /session` through `@awthaq/client`'s generated client and stores it only when the server accepts it. `whoami` prints who it resolves to (exit 8 when not logged in); `logout` clears it and revokes the session server-side (best effort). A token the server rotates is persisted.

The credential goes to the OS store first — macOS Keychain (`security`), Linux Secret Service (`secret-tool`) — and only when none is reachable to `$XDG_CONFIG_HOME/awthaq/credentials.json` (mode 0600 in a 0700 directory) with a one-time warning; the secret never travels on a command line. `AWTHAQ_TOKEN` always wins and is never written anywhere. There is no Windows Credential Manager backend yet: Windows uses the file (whose mode bits do not restrict it there), with the warning.

Interactive `awthaq login` is the device authorization grant (RFC 8628) and needs the `DeviceAuthorization` plugin ([`spec/models/13-device-authorization.md`](../../spec/models/13-device-authorization.md)), which does not exist yet: it fails with exit 9 naming that requirement.

## Not done (and why)

- `plugin list --graph` prints order, `dependsOn`, groups and tables. A plugin's *required ports* are its layer's requirements (a type-level fact), not derivable without evaluating layers, which manifest-only commands may not. `plugin list --hooks` prints each hook point's plugin-declared taps in the order the runtime chain runs them (`manifest.hooks`); application taps registered in the host run after those and are not listed.
- `doctor` reports what descriptors and the built application Layer expose; an override computed dynamically per request or per tenant cannot be validated before deploy ([ADR-EA-006](../../spec/decisions/006-runtime-config-separate-from-installation.md)).
