// @awthaq/cli — CredentialStore
//
// spec/behaviors/26-cli.md BEH-EA-228 (CTA-001, CTA-004; decision 06): where the session commands keep
// the token `awthaq login` obtained. A token is a bearer credential to a user's account, so the
// default is never a plaintext dotfile:
//
//   1. the OS-native store, first — macOS Keychain (`security`), Linux Secret Service (`secret-tool`);
//   2. only when none is reachable (a headless CI runner, a container, Windows until a tested backend
//      lands — see below), `$XDG_CONFIG_HOME/awthaq/credentials.json`, created mode 0600 inside a 0700
//      directory, with one warning per process saying so;
//   3. `AWTHAQ_TOKEN` (and `AWTHAQ_BASE_URL`) always win over whatever is stored, and are never written
//      to any store (`withEnvOverride`) — a CI job needs no store at all.
//
// The secret never travels on a command line, where a process listing shows it: the Keychain backend
// drives `security -i` (commands read from stdin) and `secret-tool store` reads the secret from stdin.
// Only the *lookup* commands carry arguments, and those name the account, not the secret. The token is
// `Redacted` in memory throughout and this module never prints it.
//
// The backends sit behind a small `Exec` port (spawn a process, optionally feeding stdin), so the
// suite drives them with a fake `security`/`secret-tool` and never touches a developer's real keychain.
//
// Not shipped: a Windows Credential Manager backend. Windows falls back to the file (with the warning)
// — mode bits do not restrict a file on Windows, so this is the honest limit of the fallback, recorded
// in the ADR rather than papered over with an untested `cmdkey` call that would put the secret on argv.

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

const nativeFor = (platform: string, exec: ExecShape): NativeBackend | undefined =>
  platform === "darwin" ? keychain(exec) : platform === "linux" ? secretService(exec) : undefined;

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
}

/**
 * The default store: native first, the 0600 file only when the native one is missing or refuses
 * (with one warning per process). `get` looks in both, so a credential written by an earlier fallback
 * is found later even if a keychain has since become available.
 */
export const make = Effect.fnUntraced(function* (options: MakeOptions) {
  const native = nativeFor(options.platform, options.exec);
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
    const file = credentialsFile(path, {
      ...(Option.isSome(xdgConfigHome) ? { xdgConfigHome: xdgConfigHome.value } : {}),
      ...(Option.isSome(home) ? { home: home.value } : {}),
    });
    return CredentialStore.of(yield* make({ platform: process.platform, exec, fs, path, file }));
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
