// BDD-007: the wire-level harness every World was copying. One definition here; each World
// keeps its own Layer composition and actor state, but the plumbing (request cookies, the
// no-op HTTP platform services, a capturing mailer, the cheap KDF layers, the named-actor
// registry) is shared so a fix lands once.
import { Mailer, PasswordHasher } from "@awthaq/ports";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";

export const STRONG_PASSWORD = "correct horse battery staple";

/** The `HttpRouter.toWebHandler` services a composition needs and nothing else does: `Path`, a weak `Etag`, `HttpPlatform`, a no-op `FileSystem`. */
export const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

/**
 * P20a: the suite's KDF layers, at the smallest legal cost so hundreds of scenarios do not pay
 * production hashing time (the algorithm, salt, PHC format and rehash path are the real ones;
 * only the cost parameters are lowered — the same shape `@awthaq/test`'s `TestAuth` uses). A
 * `ConfigError` here would be a defect in this fixed table, not a runtime condition.
 */
export const cheapArgon2id = PasswordHasher.layerArgon2id.pipe(
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromEnv({
        env: { AUTH_ARGON2_MEMORY_KIB: "1024", AUTH_ARGON2_ITERATIONS: "1" },
      }),
    ),
  ),
  Layer.orDie,
);

export const cheapScrypt = PasswordHasher.layerScrypt.pipe(
  Layer.provide(
    ConfigProvider.layer(ConfigProvider.fromEnv({ env: { AUTH_SCRYPT_COST_LOG2: "10" } })),
  ),
  Layer.orDie,
);

/** The bare `name=value` pair of a response's `Set-Cookie`, ready to send back as a request's `cookie` header. */
export const cookieFrom = (response: Response): string => {
  const raw = response.headers.get("set-cookie");
  if (raw === null) throw new Error("expected a set-cookie header");
  return raw.split(";")[0] ?? raw;
};

/** The full raw `Set-Cookie` header — carries the attributes (`Secure`, `HttpOnly`, `SameSite`, `Path`, `Domain`) a cookie-hardening scenario inspects. */
export const setCookieFrom = (response: Response): string => {
  const raw = response.headers.get("set-cookie");
  if (raw === null) throw new Error("expected a set-cookie header");
  return raw;
};

/**
 * A few cooperative scheduler turns so a detached fiber (e.g. `signUp`'s never-awaited
 * verification mail, BEH-EA-113) runs to completion, mirroring `AuthHttp.test.ts`'s own
 * `letForkedFibersRun`.
 */
export const letForkedFibersRun = Effect.gen(function* () {
  for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
});

/**
 * A capture cell built *outside* the layer graph, so a step can read what was sent after the
 * graph is sealed into a handler closure.
 */
export const makeCapturingMailer = () => {
  const messages = Effect.runSync(Ref.make<ReadonlyArray<Mailer.MailMessage>>([]));
  const layer = Layer.succeed(
    Mailer.Mailer,
    Mailer.Mailer.of({
      send: (message) => Ref.update(messages, (existing) => [...existing, message]),
      sent: Ref.get(messages),
    }),
  );
  return { layer, sent: Ref.get(messages) };
};

/**
 * A named registry a World keeps per scenario: entities are looked up by the exact name the
 * Gherkin text uses ("alice", "s1"), never a hardcoded stand-in. `current` is the name most
 * recently set or used — what a pronoun/implicit-subject step ("she sees ...") resolves to
 * (BDD-008).
 */
export const makeNamedRegistry = <A>(kind: string) => {
  const entries = Effect.runSync(Ref.make<Readonly<Record<string, A>>>({}));
  const currentCell = Effect.runSync(Ref.make<string | undefined>(undefined));
  const set = (name: string, value: A) =>
    Ref.update(entries, (existing) => ({ ...existing, [name]: value })).pipe(
      Effect.andThen(Ref.set(currentCell, name)),
    );
  const get = (name: string) =>
    Ref.get(entries).pipe(
      Effect.flatMap((all) => {
        const found = all[name];
        return found === undefined
          ? Effect.die(new Error(`no ${kind} named "${name}" has been set up`))
          : Effect.succeed(found);
      }),
    );
  const currentName = Ref.get(currentCell).pipe(
    Effect.flatMap((name) =>
      name === undefined
        ? Effect.die(new Error(`no ${kind} is current yet`))
        : Effect.succeed(name),
    ),
  );
  const use = (name: string) => Ref.set(currentCell, name);
  return { set, get, current: currentName, use };
};
