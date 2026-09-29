// @awthaq/cli — CredentialStore
//
// spec/behaviors/26-cli.md BEH-EA-228 (CTA-001, CTA-004; decision 06): where the session commands keep
// the token `awthaq login` obtained. A token is a bearer credential to a user's account, so the
// default is never a plaintext dotfile:
//
//   1. the OS-native store, first — macOS Keychain (`security`), Linux Secret Service (`secret-tool`),
//      Windows DPAPI through PowerShell (below);
//   2. only when none is reachable (a headless CI runner, a container, a Windows without PowerShell),
//      `$XDG_CONFIG_HOME/awthaq/credentials.json`, created mode 0600 inside a 0700 directory, with one
//      warning per process saying so;
//   3. `AWTHAQ_TOKEN` (and `AWTHAQ_BASE_URL`) always win over whatever is stored, and are never written
//      to any store (`withEnvOverride`) — a CI job needs no store at all.
//
// The secret never travels on a command line, where a process listing shows it: the Keychain backend
// drives `security -i` (commands read from stdin), `secret-tool store` reads the secret from stdin and
// the Windows backend pipes it to PowerShell's stdin. Only the *lookup* commands carry arguments, and
// those name the account, not the secret. The token is `Redacted` in memory throughout and this module
// never prints it.
//
// Windows: DPAPI (CurrentUser scope) through `powershell.exe` (`pwsh` if that is absent), which ships with
// every Windows and needs no module: `ConvertTo-SecureString -AsPlainText | ConvertFrom-SecureString`
// turns the secret into an opaque blob only this user on this machine can decrypt, kept in
// `%APPDATA%\awthaq\credential.dpapi`. PowerShell 5.1 and 7 produce and read the same blob. Trade-off,
// stated plainly: DPAPI protects against another user and against offline disk theft, not against another
// process running as the same user (the exposure the Keychain has for a process the user approved). Not
// `cmdkey` (it takes the secret as an argument, visible in a process listing) and not Credential Manager
// proper (reading a secret back needs a module or P/Invoke); see ADR-EA-027.
//
// The backends sit behind a small `Exec` port (spawn a process, optionally feeding stdin), so the
// suite drives them with a fake `security`/`secret-tool`/`powershell.exe` and never touches a
// developer's real keychain.

import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { ConfigUnavailable } from "./CliErrors.ts";

export interface Credential {
  /** The auth server the token belongs to. */
  readonly baseUrl: string;
  readonly token: Redacted.Redacted<string>;
}

export interface CredentialStoreShape {
  /** Where the credential lives (`keychain`, `secret-service`, `file`, `environment`), for messages — never the secret. */
  readonly backend: string;
  readonly get: Effect.Effect<Option.Option<Credential>>;
  readonly set: (credential: Credential) => Effect.Effect<void, ConfigUnavailable>;
  readonly clear: Effect.Effect<void>;
}

export class CredentialStore extends Context.Service<CredentialStore, CredentialStoreShape>()(
  "awthaq/cli/CredentialStore",
) {}

// ---- serialization -----------------------------------------------------------

const StoredJson = Schema.fromJsonString(
  Schema.Struct({ baseUrl: Schema.String, token: Schema.String }),
);
const decodeStored = Schema.decodeUnknownOption(StoredJson);

const encode = (credential: Credential) =>
  JSON.stringify({ baseUrl: credential.baseUrl, token: Redacted.value(credential.token) });

const decode = (text: string) =>
  Option.map(decodeStored(text), (stored): Credential => ({
    baseUrl: stored.baseUrl,
    token: Redacted.make(stored.token),
  }));

// ---- the process port --------------------------------------------------------

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
}

/** Spawns `command`, feeding `stdin` when given. A spawn failure (no such binary) is `undefined`, not a defect. */
export interface ExecShape {
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    stdin?: string | undefined,
  ) => Effect.Effect<ExecResult | undefined>;
}

export class Exec extends Context.Service<Exec, ExecShape>()("awthaq/cli/Exec") {}

export const layerExec = Layer.effect(
  Exec,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;
    return Exec.of({
      run: (command, args, stdin) =>
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make(command, args, {
                stdin:
                  stdin === undefined ? "ignore" : Stream.make(new TextEncoder().encode(stdin)),
                stderr: "ignore",
              }),
            );
            const stdout = yield* Stream.mkString(Stream.decodeText(handle.stdout));
            const exitCode = yield* handle.exitCode;
            const result: ExecResult = { exitCode, stdout };
            return result;
          }),
        ).pipe(Effect.orElseSucceed(() => undefined)),
    });
  }),
);

// ---- OS-native backends --------------------------------------------------------

const SERVICE = "awthaq";
const ACCOUNT = "awthaq-cli";

/** A backend is `undefined` when the platform has none; `get` reports absence and failure alike as `None`. */
interface NativeBackend {
  readonly name: string;
  readonly get: Effect.Effect<Option.Option<string>>;
  /** `false` when the store could not be written (no keychain daemon, no D-Bus session): the caller falls back. */
  readonly set: (secret: string) => Effect.Effect<boolean>;
  readonly clear: Effect.Effect<void>;
}

const toBase64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const fromBase64 = (text: string) => Buffer.from(text.trim(), "base64").toString("utf8");

/** macOS Keychain. The secret goes to `security -i` on stdin, base64 so no quoting can break the command. */
const keychain = (exec: ExecShape): NativeBackend => ({
  name: "keychain",
  get: exec
    .run("security", ["find-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w"])
    .pipe(
      Effect.map((result) =>
        result !== undefined && result.exitCode === 0 && result.stdout.trim() !== ""
          ? Option.some(fromBase64(result.stdout))
          : Option.none(),
      ),
    ),
  set: (secret) =>
    exec
      .run(
        "security",
        ["-i"],
        `add-generic-password -U -a ${ACCOUNT} -s ${SERVICE} -w ${toBase64(secret)}\n`,
      )
      .pipe(Effect.map((result) => result !== undefined && result.exitCode === 0)),
  clear: exec
    .run("security", ["delete-generic-password", "-a", ACCOUNT, "-s", SERVICE])
    .pipe(Effect.asVoid),
});

/** Linux Secret Service (libsecret). `secret-tool store` reads the secret from stdin. */
const secretService = (exec: ExecShape): NativeBackend => ({
  name: "secret-service",
  get: exec
    .run("secret-tool", ["lookup", "service", SERVICE, "account", ACCOUNT])
    .pipe(
      Effect.map((result) =>
        result !== undefined && result.exitCode === 0 && result.stdout.trim() !== ""
          ? Option.some(result.stdout.trim())
          : Option.none(),
      ),
    ),
  set: (secret) =>
    exec
      .run(
        "secret-tool",
        ["store", "--label=awthaq CLI credential", "service", SERVICE, "account", ACCOUNT],
        secret,
      )
      .pipe(Effect.map((result) => result !== undefined && result.exitCode === 0)),
  clear: exec
    .run("secret-tool", ["clear", "service", SERVICE, "account", ACCOUNT])
    .pipe(Effect.asVoid),
});

/** Where the DPAPI blob lives, and what reads and writes it: the pure logic below never names a Windows API. */
export interface BlobFile {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly file: string;
}

const POWERSHELL_FLAGS = ["-NoProfile", "-NonInteractive", "-Command"];

// The secret (or the blob) is read from stdin, never interpolated into the script, so it cannot reach argv.
// `$ErrorActionPreference = 'Stop'` turns a bad blob into exit 1 instead of an empty success.
const DPAPI_PROTECT =
  "$ErrorActionPreference = 'Stop'; try { $p = [Console]::In.ReadToEnd().Trim(); ConvertTo-SecureString -String $p -AsPlainText -Force | ConvertFrom-SecureString } catch { exit 1 }";
const DPAPI_UNPROTECT =
  "$ErrorActionPreference = 'Stop'; try { $b = [Console]::In.ReadToEnd().Trim(); $s = ConvertTo-SecureString -String $b; [System.Net.NetworkCredential]::new('', $s).Password } catch { exit 1 }";

/** `powershell.exe` (5.1, on every Windows), else `pwsh` (7); a spawn failure of both is `undefined`. */
const powershell = (exec: ExecShape, script: string, stdin: string) =>
  exec
    .run("powershell.exe", [...POWERSHELL_FLAGS, script], stdin)
    .pipe(
      Effect.flatMap((result) =>
        result === undefined
          ? exec.run("pwsh", [...POWERSHELL_FLAGS, script], stdin)
          : Effect.succeed(result),
      ),
    );

/**
 * Windows DPAPI (CurrentUser). The secret is base64 first, so the console code page cannot mangle it,
 * protected by PowerShell into an opaque blob and stored in a per-user file; `get` hands the blob back to
 * PowerShell to unprotect. A missing, unreadable or corrupted blob reads as absent.
 */
const dpapi = (exec: ExecShape, blob: BlobFile): NativeBackend => ({
  name: "dpapi",
  get: Effect.gen(function* () {
    const stored = yield* blob.fs.readFileString(blob.file).pipe(Effect.option);
    if (Option.isNone(stored) || stored.value.trim() === "") return Option.none<string>();
    const result = yield* powershell(exec, DPAPI_UNPROTECT, stored.value.trim());
    return result !== undefined && result.exitCode === 0 && result.stdout.trim() !== ""
      ? Option.some(fromBase64(result.stdout))
      : Option.none<string>();
  }),
  set: (secret) =>
    Effect.gen(function* () {
      const result = yield* powershell(exec, DPAPI_PROTECT, toBase64(secret));
      if (result === undefined || result.exitCode !== 0 || result.stdout.trim() === "") {
        return false;
      }
      return yield* blob.fs.makeDirectory(blob.path.dirname(blob.file), { recursive: true }).pipe(
        Effect.andThen(blob.fs.writeFileString(blob.file, result.stdout.trim())),
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
    }),
  clear: blob.fs.remove(blob.file, { force: true }).pipe(Effect.ignore),
});

const nativeFor = (
  platform: string,
  exec: ExecShape,
  blob: BlobFile | undefined,
): NativeBackend | undefined =>
  platform === "darwin"
    ? keychain(exec)
    : platform === "linux"
      ? secretService(exec)
      : platform === "win32" && blob !== undefined
        ? dpapi(exec, blob)
        : undefined;

/** `%APPDATA%\awthaq\credential.dpapi`, else under the profile's `AppData\Roaming`. */
export const dpapiFile = (
  path: Path.Path,
  env: { readonly appData?: string; readonly home?: string },
) =>
  path.join(
    env.appData !== undefined && env.appData !== ""
      ? env.appData
      : path.join(env.home ?? ".", "AppData", "Roaming"),
    "awthaq",
    "credential.dpapi",
  );

// ---- the file fallback -----------------------------------------------------------

export const credentialsFile = (
  path: Path.Path,
  env: { readonly xdgConfigHome?: string; readonly home?: string },
) => {
  const base =
    env.xdgConfigHome !== undefined && env.xdgConfigHome !== ""
      ? env.xdgConfigHome
      : path.join(env.home ?? ".", ".config");
  return path.join(base, "awthaq", "credentials.json");
};

// ---- the store ---------------------------------------------------------------------

export interface MakeOptions {
  readonly platform: string;
  readonly exec: ExecShape;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly file: string;
  /** Windows only: where the DPAPI blob is kept (`dpapiFile`); without it Windows has no native backend. */
  readonly dpapiFile?: string | undefined;
}

/**
 * The default store: native first, the 0600 file only when the native one is missing or refuses
 * (with one warning per process). `get` looks in both, so a credential written by an earlier fallback
 * is found later even if a keychain has since become available.
 */
export const make = Effect.fnUntraced(function* (options: MakeOptions) {
  const native = nativeFor(
    options.platform,
    options.exec,
    options.dpapiFile === undefined
      ? undefined
      : { fs: options.fs, path: options.path, file: options.dpapiFile },
  );
  const warned = yield* Ref.make(false);

  const readFile = options.fs.readFileString(options.file).pipe(
    Effect.map((text) => decode(text)),
    Effect.orElseSucceed(() => Option.none<Credential>()),
  );

  const writeFile = (credential: Credential) =>
    Effect.gen(function* () {
      const dir = options.path.dirname(options.file);
      yield* options.fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
      // `mode` on create is filtered by the umask and ignored for a directory that already existed.
      yield* options.fs.chmod(dir, 0o700);
      yield* options.fs.writeFileString(options.file, encode(credential), { mode: 0o600 });
      yield* options.fs.chmod(options.file, 0o600);
    }).pipe(
      Effect.mapError(
        () =>
          new ConfigUnavailable({
            message:
              "could not write the credentials file: no OS credential store is reachable and the fallback failed",
          }),
      ),
    );

  const warnOnce = Effect.gen(function* () {
    if (yield* Ref.getAndSet(warned, true)) return;
    // Straight to stderr, not through `Output`: the notice is independent of `--json` and of any command.
    yield* Console.error(
      `awthaq: no OS credential store is reachable; the token is stored in ${options.file} (mode 0600). Set AWTHAQ_TOKEN to avoid storing it.`,
    );
  });

  const store: CredentialStoreShape = {
    backend: native?.name ?? "file",
    get: Effect.gen(function* () {
      if (native !== undefined) {
        const secret = yield* native.get;
        if (Option.isSome(secret)) return decode(secret.value);
      }
      return yield* readFile;
    }),
    set: (credential) =>
      Effect.gen(function* () {
        if (native !== undefined && (yield* native.set(encode(credential)))) {
          // A stale fallback file must not outlive the credential it held.
          yield* options.fs.remove(options.file, { force: true }).pipe(Effect.ignore);
          return;
        }
        yield* warnOnce;
        yield* writeFile(credential);
      }),
    clear: Effect.gen(function* () {
      if (native !== undefined) yield* native.clear;
      yield* options.fs.remove(options.file, { force: true }).pipe(Effect.ignore);
    }),
  };
  return store;
});

/** The default store, before the environment override: the platform, the process environment and the platform services decide the backend. */
export const layerBase = Layer.effect(
  CredentialStore,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const exec = yield* Exec;
    const xdgConfigHome = yield* Config.String("XDG_CONFIG_HOME").pipe(Config.option);
    const home = yield* Config.String("HOME").pipe(
      Config.orElse(() => Config.String("USERPROFILE")),
      Config.option,
    );
    const appData = yield* Config.String("APPDATA").pipe(Config.option);
    const file = credentialsFile(path, {
      ...(Option.isSome(xdgConfigHome) ? { xdgConfigHome: xdgConfigHome.value } : {}),
      ...(Option.isSome(home) ? { home: home.value } : {}),
    });
    const blob = dpapiFile(path, {
      ...(Option.isSome(appData) ? { appData: appData.value } : {}),
      ...(Option.isSome(home) ? { home: home.value } : {}),
    });
    return CredentialStore.of(
      yield* make({ platform: process.platform, exec, fs, path, file, dpapiFile: blob }),
    );
  }),
);

// ---- the environment override -------------------------------------------------------

/**
 * `AWTHAQ_TOKEN` (with `AWTHAQ_BASE_URL`) wins over the stored credential and is never persisted: `get`
 * returns it, `set` and `clear` leave the store alone. A CI job therefore needs no store at all.
 */
export const withEnvOverride = (store: CredentialStoreShape) =>
  Effect.gen(function* () {
    const token = yield* Config.Redacted("AWTHAQ_TOKEN").pipe(Config.option);
    const baseUrl = yield* Config.String("AWTHAQ_BASE_URL").pipe(Config.option);
    if (Option.isNone(token)) return store;
    const overridden: CredentialStoreShape = {
      backend: "environment",
      get: Effect.map(store.get, (stored) =>
        Option.some<Credential>({
          baseUrl: Option.isSome(baseUrl)
            ? baseUrl.value
            : Option.match(stored, { onNone: () => "", onSome: (found) => found.baseUrl }),
          token: token.value,
        }),
      ),
      // Never written: the token came from the environment.
      set: () => Effect.void,
      clear: Effect.void,
    };
    return overridden;
  });

/** What the commands use: the default store with `AWTHAQ_TOKEN` taking precedence and never being persisted. */
export const layer = Layer.effect(
  CredentialStore,
  Effect.gen(function* () {
    const base = yield* CredentialStore;
    return CredentialStore.of(yield* withEnvOverride(base));
  }),
).pipe(Layer.provide(layerBase));
