# ADR-EA-027: The CLI Is Built on `effect/unstable/cli`, With Typed Exit Codes and a Credential Store Port

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-027 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-29 |
> | Status | Accepted — implemented |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-29): Initial release (ECS-004, CTA-001, CTA-003, CCR-EA-006) |

---

## Context

`@awthaq/cli` has to parse commands, render help, prompt, and map failures to process exit statuses, and `research/12-library-strategy.md` still recommends `@effect/cli` for it. That package is Effect-3 only (0.77.1, peers `effect ^3.22`); in Effect v4 the CLI moved into the core package under an unstable export (`effect/unstable/cli`: `Command`, `Flag`, `Argument`, `Prompt`), and `research/19-dbc-to-effect-mapping.md` already records that correction. The repository pins `effect` at an exact v4 release candidate (ADR-EA-007), so the recommendation is not just stale but uninstallable. Decision 07 chose the in-core CLI without recording it; this ADR does.

The CLI also has three cross-cutting properties every command shares and that a framework does not decide for us: how a command's failure becomes an exit code (BEH-EA-225), where a login token is kept (BEH-EA-228), and how the CLI finds the application it operates on.

## Decision

1. **Parsing and help use `effect/unstable/cli`.** Every flag and argument is declared with `Flag`/`Argument` and a Schema (BEH-EA-226); there is no second argument parser and no hand-rolled string splitting.
2. **A command body is a plain Effect function taking typed arguments**, separate from its `Command` declaration. This is the seam that isolates the release-candidate churn of the unstable API: when `Command`/`Flag` change, only the thin declarations do, and the bodies are tested by calling them directly.
3. **Failure is a typed error carrying its exit code.** Each CLI error class sets `[Runtime.errorExitCode]` (the marker Effect's runtime honors), the parser's own failures are remapped to the usage code, and no command sets the process status by hand. The table lives in BEH-EA-225.
4. **The application is found through `awthaq.config.ts`**, a TypeScript module the consuming project exports next to its `Auth.make` composition (resolved like a Vite or drizzle-kit config, `--config <path>` to override). Its default export is the composition (`Built<P>`), an Effect that produces it, or an object `{ auth, config?, sql?, app? }` adding the optional configuration Layer, the SQL client Layer and the fully provided application Layer that the commands of BEH-EA-208's second class need. The loaded value is exactly the static manifest plus optional Layers; loading it never serves anything.
5. **Credentials go through a `CredentialStore` port** (`get`/`set`/`clear`) with OS-native backends first (macOS Keychain, Linux Secret Service, Windows DPAPI) and a 0600 file last (BEH-EA-228); `AWTHAQ_TOKEN` is an overriding Layer that never touches the store. Windows uses DPAPI (CurrentUser scope) through `powershell.exe`, or `pwsh`: `ConvertTo-SecureString | ConvertFrom-SecureString` yields an opaque blob kept in `%APPDATA%\awthaq\credential.dpapi`, and the secret and the blob travel on the child's stdin, never argv. It protects against another user and against offline disk theft, not against another process of the same user (the same exposure the Keychain has for an approved process). `cmdkey` was rejected because it takes the secret as an argument (visible in a process listing), and Credential Manager proper because reading a secret back needs a module or P/Invoke; a Windows with no PowerShell falls back to the file, with the warning. The backend sits behind the injected `Exec` port, so it is unit-tested on any OS against a fake PowerShell. It is CLI-internal, but built the way the plugins are: the command requires the port, the entry point provides an implementation.

## Alternatives considered

**`@effect/cli` (v3 line).** Rejected: it does not install against this repository's Effect and would pin the CLI to a different major than everything it inspects.

**A hand-written argv parser (or `node:util.parseArgs`).** Rejected: it re-implements help, completions, prompts and typed decoding, and cannot carry a Schema per flag, which BEH-EA-226 requires.

**Login through `@awthaq/client`.** Rejected in decision 06: that package is the isomorphic, UI-facing client; a terminal surface borrows its generated `HttpApiClient` transport without moving the login UX into it.

**A serialized manifest file instead of importing the composition.** Rejected: contracts, tables and migrations are static class members already, and a generated artifact would be a second copy that can drift from the composition it describes.

## Consequences

**Positive**: one Effect-native dependency, typed end to end (arguments, errors, exit codes); a CI job can branch on the exit status; the loader's contract (a `Built<P>` or a thunk of one) is small and stable.

**Negative**: `effect/unstable/cli` may change between release candidates (mitigated by decision 2); importing a TypeScript config needs a runtime that can load it (Node's native type stripping, Bun, or `tsx`), so the CLI documents that requirement rather than bundling a loader; OS credential access shells out to `security` / `secret-tool` / PowerShell, which a locked-down environment may not have, in which case the 0600 file fallback (with a warning) applies.
