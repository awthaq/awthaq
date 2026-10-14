// BDD-007: the wire-level harness every World was copying. One definition here; each World
// keeps its own Layer composition and actor state, but the plumbing (request cookies, the
// no-op HTTP platform services, a capturing mailer, the cheap KDF layers, the named-actor
// registry) is shared so a fix lands once.
import { Mailer, PasswordHasher } from "@awthaq/ports";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export const STRONG_PASSWORD = "correct horse battery staple";

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
 * A few cooperative scheduler turns, so a detached fiber that does no I/O (e.g. `signUp`'s never-awaited
 * verification mail over the in-memory store, BEH-EA-113) runs to completion. A step that needs a fiber's
 * *result* over a real database should use `awaitCondition` instead: yielding alone does not outwait socket I/O.
 */
export const letForkedFibersRun = Effect.gen(function* () {
  for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
});

const realTick = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

/**
 * A bounded poll for the condition a step is about to read (a mail dispatched by a detached fiber, an event
 * published by a subscriber): cooperative turns first, then a short real tick between checks, so a forked
 * dispatch that crosses Postgres socket I/O is outwaited exactly as long as it takes and no longer. Resolves
 * `true` once `check` holds, `false` at the deadline; the caller keeps its own assertion and message.
 */
export const awaitCondition = <E, R>(
  check: Effect.Effect<boolean, E, R>,
  options?: { readonly timeoutMs?: number },
) =>
  Effect.gen(function* () {
    const deadline = Date.now() + (options?.timeoutMs ?? 5000);
    for (;;) {
      yield* letForkedFibersRun;
      if (yield* check) return true;
      if (Date.now() >= deadline) return false;
      yield* realTick(2);
    }
  });

/** True once a mail matching `predicate` has been captured. */
export const awaitMail = <R>(
  sent: Effect.Effect<ReadonlyArray<Mailer.MailMessage>, never, R>,
  predicate: (message: Mailer.MailMessage) => boolean,
) => awaitCondition(Effect.map(sent, (messages) => messages.some(predicate)));

/**
 * For a read with no known expected value (an audit trail, an event count): polls until two consecutive reads
 * agree, bounded by `timeoutMs`. Over the in-memory store a few cooperative turns already settle it, so only a
 * run against a real Postgres (`AWTHAQ_POSTGRES_URL`) ever takes a real tick.
 */
export const awaitStable = <A, E, R>(
  read: Effect.Effect<A, E, R>,
  options?: { readonly timeoutMs?: number },
) =>
  Effect.gen(function* () {
    yield* letForkedFibersRun;
    if (process.env["AWTHAQ_POSTGRES_URL"] === undefined) return;
    const deadline = Date.now() + (options?.timeoutMs ?? 2000);
    let previous = JSON.stringify(yield* read);
    while (Date.now() < deadline) {
      yield* realTick(5);
      yield* letForkedFibersRun;
      const current = JSON.stringify(yield* read);
      if (current === previous) return;
      previous = current;
    }
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
