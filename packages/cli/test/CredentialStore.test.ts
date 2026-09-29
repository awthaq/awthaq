// BEH-EA-228 (CTA-001, CTA-004): the CLI's credential store. The OS backends run against a *fake*
// `security` / `secret-tool` behind the `Exec` port — never a developer's real keychain — and the file
// fallback runs against a real temporary directory, so the 0600/0700 modes are read off the disk.
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as CredentialStore from "../src/CredentialStore.ts";

const Platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

const TOKEN = "tok-canary-9f8e7d";
const credential: CredentialStore.Credential = {
  baseUrl: "https://auth.acme.com",
  token: Redacted.make(TOKEN),
};

interface Call {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin: string | undefined;
}

/** A fake OS credential store: `security` (macOS) or `secret-tool` (Linux) semantics over a Map. */
const fakeExec = (kind: "security" | "secret-tool", options?: { readonly refuseWrites?: boolean }) => {
  const calls: Array<Call> = [];
  const secrets = new Map<string, string>();
  const exec: CredentialStore.ExecShape = {
    run: (command, args, stdin) =>
      Effect.sync(() => {
        calls.push({ command, args, stdin });
        if (command !== kind) return undefined;
        const verb = args[0];
        if (kind === "security") {
          if (verb === "-i") {
            if (options?.refuseWrites === true) return { exitCode: 1, stdout: "" };
            const match = /-w (\S+)/.exec(stdin ?? "");
            if (match?.[1] !== undefined) secrets.set("awthaq-cli", match[1]);
            return { exitCode: 0, stdout: "" };
          }
          if (verb === "find-generic-password") {
            const found = secrets.get("awthaq-cli");
            return found === undefined ? { exitCode: 44, stdout: "" } : { exitCode: 0, stdout: `${found}\n` };
          }
          if (verb === "delete-generic-password") {
            secrets.delete("awthaq-cli");
            return { exitCode: 0, stdout: "" };
          }
        } else {
          if (verb === "store") {
            if (options?.refuseWrites === true) return { exitCode: 1, stdout: "" };
            secrets.set("awthaq-cli", stdin ?? "");
            return { exitCode: 0, stdout: "" };
          }
          if (verb === "lookup") {
            const found = secrets.get("awthaq-cli");
            return found === undefined ? { exitCode: 1, stdout: "" } : { exitCode: 0, stdout: found };
          }
          if (verb === "clear") {
            secrets.delete("awthaq-cli");
            return { exitCode: 0, stdout: "" };
          }
        }
        return { exitCode: 1, stdout: "" };
      }),
  };
  return { exec, calls, secrets };
};

/** A temp directory removed with the scope, and the console's stderr captured for the warning. */
const scratch = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "awthaq-cli-cred-" });
  const stderr: Array<string> = [];
  const capturing: Console.Console = {
    ...globalThis.console,
    error: (...values: ReadonlyArray<unknown>) => {
      stderr.push(values.map(String).join(" "));
    },
  };
  return { fs, path, dir, file: path.join(dir, "cfg", "awthaq", "credentials.json"), stderr, capturing };
});

const makeStore = (platform: string, exec: CredentialStore.ExecShape) =>
  Effect.gen(function* () {
    const s = yield* scratch;
    const store = yield* CredentialStore.make({ platform, exec, fs: s.fs, path: s.path, file: s.file }).pipe(
      Effect.provideService(Console.Console, s.capturing),
    );
    return { ...s, store, withConsole: <A, E>(e: Effect.Effect<A, E>) => e.pipe(Effect.provideService(Console.Console, s.capturing)) };
  });

describe("file fallback (no OS store: Windows here)", () => {
  it.effect("writes credentials.json mode 0600 in a 0700 directory and warns once", () =>
    Effect.gen(function* () {
      const { store, fs, file, stderr, withConsole } = yield* makeStore("win32", fakeExec("security").exec);
      yield* withConsole(store.set(credential));
      yield* withConsole(store.set(credential));
      const stat = yield* fs.stat(file);
      assert.strictEqual(stat.mode & 0o777, 0o600);
      const dirStat = yield* fs.stat(file.slice(0, file.lastIndexOf("/")));
      assert.strictEqual(dirStat.mode & 0o777, 0o700);
      assert.strictEqual(stderr.length, 1);
      assert.include(stderr[0] ?? "", "no OS credential store is reachable");
      assert.notInclude(stderr[0] ?? "", TOKEN);
      const back = yield* store.get;
      assert.strictEqual(Option.isSome(back) ? Redacted.value(back.value.token) : "", TOKEN);
    }).pipe(Effect.scoped, Effect.provide(Platform)),
  );

  it.effect("clear removes the file", () =>
    Effect.gen(function* () {
      const { store, fs, file, withConsole } = yield* makeStore("win32", fakeExec("security").exec);
      yield* withConsole(store.set(credential));
      yield* store.clear;
      assert.isFalse(yield* fs.exists(file));
      assert.isTrue(Option.isNone(yield* store.get));
    }).pipe(Effect.scoped, Effect.provide(Platform)),
  );

  it.effect("credentialsFile honors XDG_CONFIG_HOME, else ~/.config", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      assert.strictEqual(
        CredentialStore.credentialsFile(path, { xdgConfigHome: "/x/cfg", home: "/home/u" }),
        "/x/cfg/awthaq/credentials.json",
      );
      assert.strictEqual(
        CredentialStore.credentialsFile(path, { home: "/home/u" }),
        "/home/u/.config/awthaq/credentials.json",
      );
    }).pipe(Effect.provide(Platform)),
  );
});

describe("OS-native backends (fake security / secret-tool)", () => {
  it.effect("macOS: the credential goes to the keychain over stdin — never on argv — and no file is written", () =>
    Effect.gen(function* () {
      const fake = fakeExec("security");
      const { store, fs, file, stderr, withConsole } = yield* makeStore("darwin", fake.exec);
      yield* withConsole(store.set(credential));
      assert.strictEqual(store.backend, "keychain");
      assert.isFalse(yield* fs.exists(file));
      assert.deepStrictEqual(stderr, []);
      for (const call of fake.calls) {
        assert.notInclude(call.args.join(" "), TOKEN);
        assert.notInclude(Buffer.from(call.args.join(" "), "utf8").toString("base64"), TOKEN);
      }
      const setCall = fake.calls.find((call) => call.args[0] === "-i");
      assert.isDefined(setCall?.stdin);
      const back = yield* store.get;
      assert.strictEqual(Option.isSome(back) ? Redacted.value(back.value.token) : "", TOKEN);
      assert.strictEqual(Option.isSome(back) ? back.value.baseUrl : "", "https://auth.acme.com");
      yield* store.clear;
      assert.isTrue(Option.isNone(yield* store.get));
    }).pipe(Effect.scoped, Effect.provide(Platform)),
  );

  it.effect("Linux: secret-tool store reads the secret from stdin", () =>
    Effect.gen(function* () {
      const fake = fakeExec("secret-tool");
      const { store, fs, file, withConsole } = yield* makeStore("linux", fake.exec);
      yield* withConsole(store.set(credential));
      assert.strictEqual(store.backend, "secret-service");
      assert.isFalse(yield* fs.exists(file));
      assert.isTrue(fake.calls.every((call) => !call.args.join(" ").includes(TOKEN)));
      const back = yield* store.get;
      assert.strictEqual(Option.isSome(back) ? Redacted.value(back.value.token) : "", TOKEN);
    }).pipe(Effect.scoped, Effect.provide(Platform)),
  );

  it.effect("a native store that refuses the write (headless Linux) falls back to the 0600 file, with a warning", () =>
    Effect.gen(function* () {
      const fake = fakeExec("secret-tool", { refuseWrites: true });
      const { store, fs, file, stderr, withConsole } = yield* makeStore("linux", fake.exec);
      yield* withConsole(store.set(credential));
      assert.strictEqual((yield* fs.stat(file)).mode & 0o777, 0o600);
      assert.strictEqual(stderr.length, 1);
      const back = yield* store.get;
      assert.strictEqual(Option.isSome(back) ? Redacted.value(back.value.token) : "", TOKEN);
    }).pipe(Effect.scoped, Effect.provide(Platform)),
  );

  it.effect("a missing native binary (spawn failure) also falls back to the file", () =>
    Effect.gen(function* () {
      const missing: CredentialStore.ExecShape = { run: () => Effect.succeed(undefined) };
      const { store, fs, file, withConsole } = yield* makeStore("linux", missing);
      yield* withConsole(store.set(credential));
      assert.isTrue(yield* fs.exists(file));
    }).pipe(Effect.scoped, Effect.provide(Platform)),
  );
});

describe("AWTHAQ_TOKEN override", () => {
  const withEnv = (env: Record<string, string>) =>
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

  it.effect("wins over the stored credential and never writes any store", () =>
    Effect.gen(function* () {
      const fake = fakeExec("security");
      const { store, fs, file, withConsole } = yield* makeStore("darwin", fake.exec);
      yield* withConsole(store.set({ baseUrl: "https://stored.example.com", token: Redacted.make("stored-token") }));
      const before = fake.calls.length;
      const overridden = yield* CredentialStore.withEnvOverride(store).pipe(
        withEnv({ AWTHAQ_TOKEN: TOKEN, AWTHAQ_BASE_URL: "https://ci.example.com" }),
      );
      const got = yield* overridden.get;
      assert.strictEqual(Option.isSome(got) ? Redacted.value(got.value.token) : "", TOKEN);
      assert.strictEqual(Option.isSome(got) ? got.value.baseUrl : "", "https://ci.example.com");
      assert.strictEqual(overridden.backend, "environment");
      // set and clear are no-ops on the underlying store: the token came from the environment.
      yield* overridden.set(credential);
      yield* overridden.clear;
      assert.strictEqual(fake.calls.length, before + 1); // only the `get` above reached the fake, via the stored-baseUrl lookup
      assert.isFalse(yield* fs.exists(file));
      assert.strictEqual(fake.secrets.size, 1);
    }).pipe(Effect.scoped, Effect.provide(Platform)),
  );

  it.effect("without AWTHAQ_TOKEN the store is returned untouched", () =>
    Effect.gen(function* () {
      const { store } = yield* makeStore("win32", fakeExec("security").exec);
      const same = yield* CredentialStore.withEnvOverride(store).pipe(withEnv({}));
      assert.strictEqual(same, store);
    }).pipe(Effect.scoped, Effect.provide(Platform)),
  );
});
