// Plan 27: the password credential module, tested at its interface. Uniform cost (one real verify,
// against the boot-time dummy hash when there is no credential, held to the timing floor in force)
// and the rehash of a proven credential are tested here once; the endpoints that use them keep
// one wiring test each (`Password.test.ts`, `PasswordStoreOutage.test.ts`).
import { Accounts, Auth, Errors, Users } from "@awthaq/core";
import { createHash } from "node:crypto";
import { PasswordHasher } from "@awthaq/ports";
import { TestAuth } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as Password from "../src/Password.ts";
import * as PasswordCredential from "../src/PasswordCredential.ts";
import {
  httpClientReturning,
  makeTestLayer,
  NoBreachHttpClient,
  UnavailableHttpClient,
} from "./harness.ts";

const DUMMY = "h:awthaq/password/dummy";

/**
 * A hasher that records every hash it is asked to verify. `hash(p)` is `h:<p>`; a stored hash
 * `<anything>:<p>` matches `p`; a hash starting `old:` is below the target (`needsRehash`). Instant,
 * except that the first verify (the boot-time calibration) may advance the test clock.
 */
const recordingHasher = (options: { readonly calibrationCost?: Duration.Duration } = {}) => {
  const verified: Array<string> = [];
  const hashed: Array<string> = [];
  let calibrated = options.calibrationCost === undefined;
  const layer = Layer.succeed(
    PasswordHasher.PasswordHasher,
    PasswordHasher.PasswordHasher.of({
      hash: (plain) =>
        Effect.sync(() => {
          hashed.push(Redacted.value(plain));
          return PasswordHasher.PhcHash(`h:${Redacted.value(plain)}`);
        }),
      verify: (plain, phc) =>
        Effect.gen(function* () {
          verified.push(phc);
          if (!calibrated && options.calibrationCost !== undefined) {
            calibrated = true;
            yield* TestClock.adjust(options.calibrationCost);
          }
          return phc.slice(phc.indexOf(":") + 1) === Redacted.value(plain);
        }),
      needsRehash: (phc) => phc.startsWith("old:"),
    }),
  );
  return { layer, verified, hashed };
};

const secret = Redacted.make("correct horse battery staple");
const wrong = Redacted.make("not the password at all");

const layerWith = (
  hasher: ReturnType<typeof recordingHasher>,
  config: Partial<Password.PasswordConfigShape> = { signInTimingFloor: "off" },
) => makeTestLayer({ config, hasher: hasher.layer });

/** A user, optionally with a password account holding `hash` (no hash at all when `hash` is `null`). */
const userWith = (hash: string | null | undefined) =>
  Effect.gen(function* () {
    const users = yield* Users.Users;
    const accounts = yield* Accounts.Accounts;
    const user = yield* users.create({
      identity: { _tag: "Email", email: "ada@example.com" },
      name: "Ada",
    });
    if (hash !== undefined) {
      yield* accounts.link({
        userId: user.id,
        providerId: Accounts.PASSWORD_PROVIDER_ID,
        subject: user.id,
        ...(hash === null ? {} : { credentialHash: Redacted.make(PasswordHasher.PhcHash(hash)) }),
      });
    }
    return user;
  });

const storedHash = (userId: Users.UserId) =>
  Effect.gen(function* () {
    const accounts = yield* Accounts.Accounts;
    const account = Option.getOrThrow(
      yield* accounts.findByProviderSubject(Accounts.PASSWORD_PROVIDER_ID, userId),
    );
    return Option.map(yield* accounts.findCredentialHash(account.id), Redacted.value);
  });

class LookupFailed extends Data.TaggedError("LookupFailed")<{}> {}

/** The real `Accounts`, with one method replaced. */
const accountsWith = (
  override: (real: Accounts.AccountsShape) => Partial<Accounts.AccountsShape>,
) =>
  Layer.effect(
    Accounts.Accounts,
    Effect.map(Accounts.Accounts, (real) => Accounts.Accounts.of({ ...real, ...override(real) })),
  );

describe("PasswordCredential.verify: one real verify, one answer (BEH-EA-114)", () => {
  it.effect(
    "V1: an unknown claimant runs one verify, against the dummy hash, and is Refused",
    () => {
      const hasher = recordingHasher();
      return Effect.gen(function* () {
        const credential = yield* PasswordCredential.PasswordCredential;
        const users = yield* Users.Users;
        hasher.verified.length = 0;
        const verdict = yield* credential.verify(users.findByEmail("nobody@example.com"), secret);
        assert.strictEqual(verdict._tag, "Refused");
        assert.deepStrictEqual(hasher.verified, [DUMMY]);
      }).pipe(Effect.provide(layerWith(hasher)));
    },
  );

  it.effect(
    "V2: a claimant with no password account runs one verify against the dummy hash",
    () => {
      const hasher = recordingHasher();
      return Effect.gen(function* () {
        const credential = yield* PasswordCredential.PasswordCredential;
        const user = yield* userWith(undefined);
        hasher.verified.length = 0;
        const verdict = yield* credential.verify(Effect.succeedSome(user), secret);
        assert.strictEqual(verdict._tag, "Refused");
        assert.deepStrictEqual(hasher.verified, [DUMMY]);
      }).pipe(Effect.provide(layerWith(hasher)));
    },
  );

  it.effect(
    "V3: a password account with no hash stored runs one verify against the dummy hash",
    () => {
      const hasher = recordingHasher();
      return Effect.gen(function* () {
        const credential = yield* PasswordCredential.PasswordCredential;
        const user = yield* userWith(null);
        hasher.verified.length = 0;
        const verdict = yield* credential.verify(Effect.succeedSome(user), secret);
        assert.strictEqual(verdict._tag, "Refused");
        assert.deepStrictEqual(hasher.verified, [DUMMY]);
      }).pipe(Effect.provide(layerWith(hasher)));
    },
  );

  it.effect("V4: a wrong password runs one verify, against the stored hash, and is Refused", () => {
    const hasher = recordingHasher();
    return Effect.gen(function* () {
      const credential = yield* PasswordCredential.PasswordCredential;
      const user = yield* userWith(`h:${Redacted.value(secret)}`);
      hasher.verified.length = 0;
      const verdict = yield* credential.verify(Effect.succeedSome(user), wrong);
      assert.strictEqual(verdict._tag, "Refused");
      assert.deepStrictEqual(hasher.verified, [`h:${Redacted.value(secret)}`]);
    }).pipe(Effect.provide(layerWith(hasher)));
  });

  it.effect(
    "V5: the right password is Verified, carrying the claimant and a proof of its account",
    () => {
      const hasher = recordingHasher();
      return Effect.gen(function* () {
        const credential = yield* PasswordCredential.PasswordCredential;
        const accounts = yield* Accounts.Accounts;
        const user = yield* userWith(`h:${Redacted.value(secret)}`);
        const claimant = { id: user.id, label: "the claimant value itself" };
        const verdict = yield* credential.verify(Effect.succeedSome(claimant), secret);
        assert.strictEqual(verdict._tag, "Verified");
        if (verdict._tag !== "Verified") return;
        assert.strictEqual(verdict.claimant, claimant);
        const account = Option.getOrThrow(
          yield* accounts.findByProviderSubject(Accounts.PASSWORD_PROVIDER_ID, user.id),
        );
        assert.strictEqual(verdict.proof.accountId, account.id);
        assert.strictEqual(Redacted.value(verdict.proof.hash), `h:${Redacted.value(secret)}`);
      }).pipe(Effect.provide(layerWith(hasher)));
    },
  );

  it.effect("V6: an account unlinked between the account read and the hash read is Refused", () => {
    const hasher = recordingHasher();
    const unlinkedMidway = accountsWith(() => ({
      findCredentialHash: (id) =>
        Effect.fail(new Accounts.AccountNotFound({ message: "unlinked", id })),
    }));
    return Effect.gen(function* () {
      const credential = yield* PasswordCredential.PasswordCredential;
      const user = yield* userWith(`h:${Redacted.value(secret)}`);
      hasher.verified.length = 0;
      const verdict = yield* credential.verify(Effect.succeedSome(user), secret);
      assert.strictEqual(verdict._tag, "Refused");
      assert.deepStrictEqual(hasher.verified, [DUMMY]);
    }).pipe(
      Effect.provide(
        makeTestLayer({
          config: { signInTimingFloor: "off" },
          hasher: hasher.layer,
          coreOverride: unlinkedMidway,
        }),
      ),
    );
  });

  it.effect("V7: a failing claimant lookup passes its failure through", () => {
    const hasher = recordingHasher();
    return Effect.gen(function* () {
      const credential = yield* PasswordCredential.PasswordCredential;
      const failure = yield* credential
        .verify(Effect.fail(new LookupFailed()), secret)
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "LookupFailed");
    }).pipe(Effect.provide(layerWith(hasher)));
  });

  it.effect("V7: an Accounts outage is StoreUnavailable", () => {
    const hasher = recordingHasher();
    const down = accountsWith(() => ({
      findByProviderSubject: () =>
        Effect.fail(new Errors.StoreUnavailable({ operation: "Accounts.findByProviderSubject" })),
    }));
    return Effect.gen(function* () {
      const credential = yield* PasswordCredential.PasswordCredential;
      const failure = yield* credential
        .verify(Effect.succeedSome({ id: Users.UserId("u-1") }), secret)
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "StoreUnavailable");
    }).pipe(
      Effect.provide(
        makeTestLayer({
          config: { signInTimingFloor: "off" },
          hasher: hasher.layer,
          coreOverride: down,
        }),
      ),
    );
  });
});

describe("PasswordCredential.verify: the timing floor (TSS-006)", () => {
  const floor100 = { signInTimingFloor: Duration.millis(100) };

  /** Forks `effect`, then proves it is still pending at +60 ms and done by +120 ms. */
  const heldTo100ms = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.exit(effect), { startImmediately: true });
      yield* TestClock.adjust(Duration.millis(60));
      assert.isUndefined(fiber.pollUnsafe(), "answered before the floor");
      yield* TestClock.adjust(Duration.millis(60));
      return yield* Fiber.join(fiber);
    });

  it.effect(
    "F1: a Refused verdict is held to a Duration floor, even when verify is instant",
    () => {
      const hasher = recordingHasher();
      return Effect.gen(function* () {
        const credential = yield* PasswordCredential.PasswordCredential;
        const users = yield* Users.Users;
        const exit = yield* heldTo100ms(
          credential.verify(users.findByEmail("nobody@example.com"), secret),
        );
        assert.isTrue(exit._tag === "Success" && exit.value._tag === "Refused");
      }).pipe(Effect.provide(layerWith(hasher, floor100)));
    },
  );

  it.effect("F2: a Verified verdict is held to the floor too", () => {
    const hasher = recordingHasher();
    return Effect.gen(function* () {
      const credential = yield* PasswordCredential.PasswordCredential;
      const user = yield* userWith(`h:${Redacted.value(secret)}`);
      const exit = yield* heldTo100ms(credential.verify(Effect.succeedSome(user), secret));
      assert.isTrue(exit._tag === "Success" && exit.value._tag === "Verified");
    }).pipe(Effect.provide(layerWith(hasher, floor100)));
  });

  it.effect(
    "F3: a failing claimant lookup is held to the floor (success and failure alike)",
    () => {
      const hasher = recordingHasher();
      return Effect.gen(function* () {
        const credential = yield* PasswordCredential.PasswordCredential;
        const exit = yield* heldTo100ms(credential.verify(Effect.fail(new LookupFailed()), secret));
        assert.strictEqual(exit._tag, "Failure");
      }).pipe(Effect.provide(layerWith(hasher, floor100)));
    },
  );

  it.effect("F4: signInTimingFloor: off adds nothing", () => {
    const hasher = recordingHasher();
    return Effect.gen(function* () {
      const credential = yield* PasswordCredential.PasswordCredential;
      const users = yield* Users.Users;
      // No clock adjustment: under `TestClock`, any sleep would never finish.
      const verdict = yield* credential.verify(users.findByEmail("nobody@example.com"), secret);
      assert.strictEqual(verdict._tag, "Refused");
    }).pipe(Effect.provide(layerWith(hasher, { signInTimingFloor: "off" })));
  });

  it.effect(
    "F5: calibrated pads to 1.25 times the boot-time dummy verify (80 ms to 100 ms)",
    () => {
      const hasher = recordingHasher({ calibrationCost: Duration.millis(80) });
      return Effect.gen(function* () {
        const credential = yield* PasswordCredential.PasswordCredential;
        const users = yield* Users.Users;
        assert.deepStrictEqual(hasher.verified, [DUMMY], "the boot calibration verifies the dummy");
        const fiber = yield* Effect.forkChild(
          credential.verify(users.findByEmail("nobody@example.com"), secret),
          { startImmediately: true },
        );
        yield* TestClock.adjust(Duration.millis(99));
        assert.isUndefined(fiber.pollUnsafe(), "answered before 1.25 x 80 ms");
        yield* TestClock.adjust(Duration.millis(1));
        assert.strictEqual((yield* Fiber.join(fiber))._tag, "Refused");
      }).pipe(Effect.provide(layerWith(hasher, { signInTimingFloor: "calibrated" })));
    },
  );
});

/**
 * PHS-005: the production-cost argon2id hasher (`TestAuth`'s own is deliberately cheap), so R1/R2
 * plant hashes "stored under other parameters" and assert what a proven credential is upgraded to.
 */
const TestLayerProductionHasher = TestAuth.layer(Auth.make([Password.Password]), {
  services: Layer.mergeAll(NoBreachHttpClient, Password.config({ signInTimingFloor: "off" })),
  // `Layer.fresh`: the base already built `layerArgon2id` at the cheap test cost on the shared memo map.
  decorate: Layer.orDie(Layer.fresh(PasswordHasher.layerArgon2id)),
});

const hashAt = (env: Record<string, string>, plain: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const previous = yield* PasswordHasher.PasswordHasher;
    return yield* previous.hash(plain);
  }).pipe(
    Effect.provide(
      Layer.fresh(PasswordHasher.layerArgon2id).pipe(
        Layer.provide(NodeCrypto.layer),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
        Layer.orDie,
      ),
    ),
  );

/** Verifies `candidate` for `userId`, failing the test unless it is Verified, and returns the proof. */
const proven = (userId: Users.UserId, candidate: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const credential = yield* PasswordCredential.PasswordCredential;
    const verdict = yield* credential.verify(Effect.succeedSome({ id: userId }), candidate);
    if (verdict._tag !== "Verified") return assert.fail("the planted credential must verify");
    return verdict.proof;
  });

describe("PasswordCredential.rehashIfStale (BEH-EA-116)", () => {
  it.effect("R1: a hash stored under outdated parameters is rewritten with current ones", () =>
    Effect.gen(function* () {
      const credential = yield* PasswordCredential.PasswordCredential;
      const current = yield* PasswordHasher.PasswordHasher;
      const outdated = yield* hashAt(
        { AUTH_ARGON2_MEMORY_KIB: "1024", AUTH_ARGON2_ITERATIONS: "1" },
        secret,
      );
      assert.isTrue(current.needsRehash(outdated), "the planted hash must be below the floor");
      const user = yield* userWith(outdated);

      yield* credential.rehashIfStale(yield* proven(user.id, secret));

      const stored = Option.getOrThrow(yield* storedHash(user.id));
      assert.notStrictEqual(stored, outdated, "the outdated hash must have been replaced");
      assert.match(stored, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
      assert.isFalse(current.needsRehash(PasswordHasher.PhcHash(stored)));
      assert.isTrue(yield* current.verify(secret, PasswordHasher.PhcHash(stored)));
    }).pipe(Effect.provide(TestLayerProductionHasher)),
  );

  it.effect("R2: a hash stronger than the current parameters is left alone (PHS-002)", () =>
    Effect.gen(function* () {
      const credential = yield* PasswordCredential.PasswordCredential;
      const current = yield* PasswordHasher.PasswordHasher;
      const stronger = yield* hashAt({ AUTH_ARGON2_ITERATIONS: "3" }, secret);
      assert.isFalse(current.needsRehash(stronger), "a stronger hash is above the floor");
      const user = yield* userWith(stronger);

      yield* credential.rehashIfStale(yield* proven(user.id, secret));

      assert.strictEqual(Option.getOrThrow(yield* storedHash(user.id)), stronger);
    }).pipe(Effect.provide(TestLayerProductionHasher)),
  );

  it.effect("R3: rehashOnLogin: false leaves a stale hash", () => {
    const hasher = recordingHasher();
    return Effect.gen(function* () {
      const credential = yield* PasswordCredential.PasswordCredential;
      const user = yield* userWith(`old:${Redacted.value(secret)}`);
      yield* credential.rehashIfStale(yield* proven(user.id, secret));
      assert.strictEqual(
        Option.getOrThrow(yield* storedHash(user.id)),
        `old:${Redacted.value(secret)}`,
      );
      assert.deepStrictEqual(hasher.hashed, ["awthaq/password/dummy"], "no hash beyond the dummy");
    }).pipe(Effect.provide(layerWith(hasher, { signInTimingFloor: "off", rehashOnLogin: false })));
  });

  it.effect("R4: an account unlinked since the proof is left alone, without a defect", () => {
    const hasher = recordingHasher();
    return Effect.gen(function* () {
      const credential = yield* PasswordCredential.PasswordCredential;
      const accounts = yield* Accounts.Accounts;
      const user = yield* userWith(`old:${Redacted.value(secret)}`);
      const proof = yield* proven(user.id, secret);
      yield* accounts.deleteAllByUser(user.id);
      yield* credential.rehashIfStale(proof);
      assert.isTrue(
        Option.isNone(
          yield* accounts.findByProviderSubject(Accounts.PASSWORD_PROVIDER_ID, user.id),
        ),
      );
    }).pipe(Effect.provide(layerWith(hasher)));
  });
});

// ---- accept: the one policy (BEH-EA-119/120, PHS-004, PHS-006, CSD-001) -------------------------

const breached = Redacted.make("pwned-password-123");
const breachedHex = createHash("sha1").update(Redacted.value(breached)).digest("hex").toUpperCase();

/** A range listing that names `breached`'s suffix under its prefix, recording every URL requested. */
const breachCorpus = () => {
  const requested: Array<string> = [];
  const layer = httpClientReturning((url) => {
    requested.push(url);
    return url.endsWith(breachedHex.slice(0, 5))
      ? `${breachedHex.slice(5)}:5`
      : `${"F".repeat(35)}:1`;
  });
  return { layer, requested };
};

/** CSD-001: a resolved non-2xx response, which `HttpClient` does not fail on its own. */
const respondingStatus = (status: number) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status }))),
    ),
  );

const NeverResponds = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.never),
);

/** Runs `accept` under `httpClient` and `config`, answering its hints (empty when accepted). */
const hintsFor = (
  candidate: Redacted.Redacted<string>,
  httpClient: Layer.Layer<HttpClient.HttpClient>,
  config: Partial<Password.PasswordConfigShape>,
) =>
  Effect.gen(function* () {
    const credential = yield* PasswordCredential.PasswordCredential;
    return yield* credential.accept(candidate).pipe(
      Effect.as<ReadonlyArray<string>>([]),
      Effect.catchTag("WeakPassword", (weak) => Effect.succeed(weak.hints)),
    );
  }).pipe(Effect.provide(makeTestLayer({ httpClient, config })));

describe("PasswordCredential.accept: the one policy (BEH-EA-119/120)", () => {
  it.effect("P1: shorter than the minLength in force is WeakPassword with the length hint", () =>
    Effect.gen(function* () {
      const hints = yield* hintsFor(Redacted.make("fifteen chars!!"), NoBreachHttpClient, {
        minLength: 16,
        breachCheck: false,
      });
      assert.deepStrictEqual(hints, ["must be at least 16 characters"]);
    }),
  );

  it.effect("P2: a breached password is refused; only a 5-character SHA-1 prefix leaves", () => {
    const corpus = breachCorpus();
    return Effect.gen(function* () {
      const hints = yield* hintsFor(breached, corpus.layer, { breachCheck: true });
      assert.deepStrictEqual(hints, ["appears in known breaches"]);
      assert.deepStrictEqual(corpus.requested, [
        `https://api.pwnedpasswords.com/range/${breachedHex.slice(0, 5)}`,
      ]);
    });
  });

  // P3-P8: every way the breach check can be unavailable follows `onUnavailable`: "allow" accepts,
  // "reject" refuses as if breached (PHS-004, CSD-001).
  const unavailable: ReadonlyArray<readonly [string, Layer.Layer<HttpClient.HttpClient>]> = [
    ["a transport failure", UnavailableHttpClient],
    ["a 429", respondingStatus(429)],
    ["a 503", respondingStatus(503)],
    ["a 200 HTML body", httpClientReturning(() => "<html><body>Bad gateway</body></html>")],
    ["an empty 200 body", httpClientReturning(() => "")],
  ];
  for (const [failure, httpClient] of unavailable) {
    it.effect(`P3-P8: ${failure} from the breach check fails open by default`, () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* hintsFor(secret, httpClient, { breachCheck: true }), []);
      }),
    );
    it.effect(`P3-P8: ${failure} from the breach check fails closed under reject`, () =>
      Effect.gen(function* () {
        const hints = yield* hintsFor(secret, httpClient, {
          breachCheck: { onUnavailable: "reject" },
        });
        assert.deepStrictEqual(hints, ["appears in known breaches"]);
      }),
    );
  }

  it.effect("P9: a never-responding breach check fails open after breachCheckTimeout", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        hintsFor(secret, NeverResponds, { breachCheckTimeout: Duration.seconds(3) }),
        { startImmediately: true },
      );
      yield* TestClock.adjust(Duration.seconds(2));
      assert.isUndefined(fiber.pollUnsafe(), "gave up before the timeout");
      yield* TestClock.adjust(Duration.seconds(1));
      assert.deepStrictEqual(yield* Fiber.join(fiber), []);
    }),
  );

  it.effect("P9: a never-responding breach check fails closed under reject", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        hintsFor(secret, NeverResponds, {
          breachCheck: { onUnavailable: "reject" },
          breachCheckTimeout: Duration.seconds(3),
        }),
        { startImmediately: true },
      );
      yield* TestClock.adjust(Duration.seconds(3));
      assert.deepStrictEqual(yield* Fiber.join(fiber), ["appears in known breaches"]);
    }),
  );

  it.effect("P10: breachCheck: false makes no request", () => {
    const corpus = breachCorpus();
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* hintsFor(breached, corpus.layer, { breachCheck: false }), []);
      assert.deepStrictEqual(corpus.requested, []);
    });
  });

  it.effect("P11: the default configuration screens (PHS-006)", () => {
    const corpus = breachCorpus();
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* hintsFor(breached, corpus.layer, {}), [
        "appears in known breaches",
      ]);
    });
  });
});

describe("PasswordCredential.linkFor", () => {
  it.effect("W6: hashes now and builds the password LinkInput for the user it is given", () => {
    const hasher = recordingHasher();
    return Effect.gen(function* () {
      const credential = yield* PasswordCredential.PasswordCredential;
      const link = yield* credential.linkFor(yield* credential.accept(secret));
      assert.deepStrictEqual(hasher.hashed, ["awthaq/password/dummy", Redacted.value(secret)]);
      const user = yield* userWith(undefined);
      const input = link(user);
      assert.strictEqual(input.providerId, Accounts.PASSWORD_PROVIDER_ID);
      assert.strictEqual(input.subject, user.id);
      assert.isUndefined(input.issuer);
      assert.strictEqual(
        input.credentialHash === undefined ? undefined : Redacted.value(input.credentialHash),
        `h:${Redacted.value(secret)}`,
      );
    }).pipe(Effect.provide(layerWith(hasher)));
  });
});
