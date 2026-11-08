// @awthaq/password — PasswordCredential (plan 27, BEH-EA-114/116)
//
// The password credential of a user is the `accounts` row with `providerId = "password"`,
// `subject = userId` and no issuer (BEH-EA-044), plus its hash. This module is the one place that
// reads it and runs the `PasswordHasher` on it. `Password.layer` exposes it (ADR-EA-040), so it is
// built once, beneath the plugin's own `make`, and a trusted dependent can require it.
//
// Behind the interface: the boot-time dummy hash and its calibration, the timing floor's three
// modes and its per-tenant choice, the account key convention, and races mapped to answers
// instead of defects.

import { Accounts, Errors, Observability, type SignUp, Tenant, type Users } from "@awthaq/core";
import { Hmac, PasswordHasher } from "@awthaq/ports";
import * as Brand from "effect/Brand";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as PasswordApi from "./PasswordApi.ts";
import { PasswordConfig, type PasswordConfigShape } from "./PasswordConfig.ts";

/**
 * A candidate the one policy accepted (BEH-EA-119/120). Only `accept` mints one, and every write
 * takes nothing else, so no password credential is written without the policy.
 */
export type Accepted = {
  readonly candidate: Redacted.Redacted<string>;
} & Brand.Brand<"awthaq/password/Accepted">;
const accepted = Brand.nominal<Accepted>();

/**
 * What a successful `verify` proved: the account, the hash it matched and the candidate. Only
 * `verify` mints one, so `rehashIfStale` cannot target a credential nobody proved.
 */
export type Proof = {
  readonly accountId: Accounts.AccountId;
  readonly hash: Redacted.Redacted<PasswordHasher.PhcHash>;
  readonly candidate: Redacted.Redacted<string>;
} & Brand.Brand<"awthaq/password/Proof">;
const proof = Brand.nominal<Proof>();

/** One answer for "no such user", "no password credential" and "wrong password" (BEH-EA-114). */
export type Verdict<U> =
  | { readonly _tag: "Refused" }
  | { readonly _tag: "Verified"; readonly claimant: U; readonly proof: Proof };

export interface PasswordCredentialShape {
  /**
   * BEH-EA-114/TSS-006: resolves the claimant, reads its password credential and runs exactly one
   * real verify, against the boot-time dummy hash when there is no credential. The whole effect,
   * success or failure, is held to the timing floor in force. Never says which refusal applied.
   */
  readonly verify: <U extends { readonly id: Users.UserId }, E>(
    claimant: Effect.Effect<Option.Option<U>, E>,
    candidate: Redacted.Redacted<string>,
  ) => Effect.Effect<Verdict<U>, E | Errors.StoreUnavailable>;
  /**
   * BEH-EA-116: rewrites the proven credential with current parameters when its hash is below the
   * hasher's target and `rehashOnLogin` holds. Bypasses the policy on purpose: a stale hash of a
   * password the policy would now refuse is still upgraded. An account unlinked since the proof is
   * left alone.
   */
  readonly rehashIfStale: (proven: Proof) => Effect.Effect<void, Errors.StoreUnavailable>;
  /**
   * BEH-EA-119/120: the one policy (minimum length, breach screening) in force for the calling
   * fiber. Its breach check is a network call, so it never runs inside a unit of work (BEH-EA-117).
   */
  readonly accept: (
    candidate: Redacted.Redacted<string>,
  ) => Effect.Effect<Accepted, PasswordApi.WeakPassword>;
  /**
   * The sign-up unit's credential: hashes now, before the unit (TMS-005: equal work in both
   * enumeration branches), and answers the link the unit makes for the new user.
   */
  readonly linkFor: (
    password: Accepted,
  ) => Effect.Effect<(user: Users.UserRecord) => SignUp.LinkInput>;
}

interface Stored {
  readonly accountId: Accounts.AccountId;
  readonly hash: Redacted.Redacted<PasswordHasher.PhcHash>;
}

const refused: Verdict<never> = { _tag: "Refused" };

/** PHS-004: internal only — routed to `onUnavailable` by `isBreached`, never surfaced. */
class MalformedBreachResponse extends Data.TaggedError("MalformedBreachResponse")<{}> {}

/** One HIBP range line: the 35-hex-character SHA-1 suffix and its breach count. */
const HIBP_LINE = /^[0-9A-F]{35}:\d+$/i;

/**
 * BEH-EA-119: the k-anonymity HIBP check — only a 5-character SHA-1 prefix
 * ever leaves the process, per the API's own design; a real network/parse
 * failure resolves to `onUnavailable === "reject"`, never re-raised as a
 * distinguishable error (fail-open is a `false` here, fail-closed is `true`
 * — "assume breached" is what actually blocks sign-up).
 */
const isBreached = (
  httpClient: HttpClient.HttpClient,
  digest: Digest.Digest["Service"],
  password: Redacted.Redacted<string>,
  onUnavailable: "allow" | "reject",
  timeout: Duration.Duration,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const sha1 = yield* digest.digest(
      Digest.sha1,
      new TextEncoder().encode(Redacted.value(password)),
    );
    const hex = Hmac.toHex(sha1).toUpperCase();
    const prefix = hex.slice(0, 5);
    const suffix = hex.slice(5);
    // CSD-001: `HttpClient` resolves for any status — a 429/503 from HIBP
    // (its own aggressive throttling is the most common failure mode at
    // scale) would otherwise read as an ordinary body, fail the suffix
    // match, and silently report "not breached" even under
    // `onUnavailable: "reject"`. `filterStatusOk` turns any non-2xx into a
    // failure, routed to `onUnavailable` by the same catch-all below a
    // transport error already used.
    const response = yield* httpClient
      .get(`https://api.pwnedpasswords.com/range/${prefix}`)
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
    const body = yield* response.text;
    // PHS-004: a 200 that is not a range listing (an HTML error page from a
    // proxy, a truncated body) is no evidence of anything — treat it as
    // unavailable rather than as "not breached". Every real prefix has
    // hundreds of entries, so an empty body is malformed too.
    const lines = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (lines.length === 0 || !lines.every((line) => HIBP_LINE.test(line))) {
      return yield* new MalformedBreachResponse();
    }
    return lines.some((line) => line.split(":")[0]?.toUpperCase() === suffix);
  }).pipe(
    // PHS-004: a black-holed egress follows `onUnavailable` too, not a hang.
    Effect.timeout(timeout),
    Effect.catch(() => Effect.succeed(onUnavailable === "reject")),
  );

/** BEH-EA-119/120: what is wrong with `password` under `config`; empty when nothing is. */
const policyHints = (
  httpClient: HttpClient.HttpClient,
  digest: Digest.Digest["Service"],
  password: Redacted.Redacted<string>,
  config: PasswordConfigShape,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const hints: Array<string> = [];
    if (Redacted.value(password).length < config.minLength) {
      hints.push(`must be at least ${config.minLength} characters`);
    }
    if (config.breachCheck !== false) {
      const onUnavailable =
        config.breachCheck === true ? "allow" : config.breachCheck.onUnavailable;
      if (
        yield* isBreached(httpClient, digest, password, onUnavailable, config.breachCheckTimeout)
      ) {
        hints.push("appears in known breaches");
      }
    }
    return hints;
  });

const make = Effect.gen(function* () {
  const accounts = yield* Accounts.Accounts;
  const hasher = yield* PasswordHasher.PasswordHasher;
  const httpClient = yield* HttpClient.HttpClient;
  const digest = yield* Digest.Digest;
  // EP-007: the floor and `rehashOnLogin` are decided per operation, so a tenant's
  // `Password.config(...)` in the calling fiber applies; the built value is boot-scoped only for
  // the calibration below.
  const builtConfig = yield* PasswordConfig;
  const configNow = Tenant.configInForce(PasswordConfig, builtConfig);

  /**
   * EOTS-001: the hash check is its own span (`awthaq.password.verify`), so a trace shows where
   * sign-in latency goes. No attribute is derived from the password, the hash or the identifier.
   */
  const verifyHash = (
    candidate: Redacted.Redacted<string>,
    hash: Redacted.Redacted<PasswordHasher.PhcHash>,
  ) =>
    hasher.verify(candidate, Redacted.value(hash)).pipe(
      Observability.authSpan(Observability.Span.passwordVerify, {
        [Observability.Field.strategy]: "password",
      }),
    );

  // BEH-EA-114: paid once at boot, not once per refused attempt: a real hash this application's
  // own hasher produced, so a verify does the same real work whether or not a credential exists.
  const dummyPassword = Redacted.make("awthaq/password/dummy");
  const dummyHash = Redacted.make(yield* hasher.hash(dummyPassword));

  // TSS-006: `hasher.hash` above has already warmed the KDF, so this timing is the steady-state
  // verify cost. Measured even when the built value fixes the floor, because a tenant may ask for
  // `"calibrated"`; skipped only when the built value is `"off"` (a posture that never calibrates).
  const calibratedFloorMillis = yield* Effect.gen(function* () {
    if (builtConfig.signInTimingFloor === "off") return 0;
    const start = DateTime.toEpochMillis(yield* DateTime.now);
    yield* hasher.verify(dummyPassword, Redacted.value(dummyHash));
    return 1.25 * (DateTime.toEpochMillis(yield* DateTime.now) - start);
  });
  const floorMillis = (floor: PasswordConfigShape["signInTimingFloor"]) =>
    floor === "off"
      ? 0
      : Duration.isDuration(floor)
        ? Duration.toMillis(floor)
        : calibratedFloorMillis;

  /** TSS-006: the exit, success or failure alike, is held back until the floor in force has elapsed. */
  const withTimingFloor = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(configNow, (config) => {
      const floor = floorMillis(config.signInTimingFloor);
      return floor <= 0
        ? effect
        : Effect.gen(function* () {
            const start = DateTime.toEpochMillis(yield* DateTime.now);
            const exit = yield* Effect.exit(effect);
            const elapsed = DateTime.toEpochMillis(yield* DateTime.now) - start;
            if (elapsed < floor) yield* Effect.sleep(Duration.millis(floor - elapsed));
            return yield* exit;
          });
    });

  /** The password account and its hash. An account unlinked between the two reads is no credential: a race, not a defect. */
  const stored = (userId: Users.UserId) =>
    Effect.gen(function* () {
      const account = yield* accounts.findByProviderSubject(Accounts.PASSWORD_PROVIDER_ID, userId);
      if (Option.isNone(account)) return Option.none<Stored>();
      const accountId = account.value.id;
      const hash = yield* accounts
        .findCredentialHash(accountId)
        .pipe(Effect.catchTag("AccountNotFound", () => Effect.succeedNone));
      return Option.map(hash, (value): Stored => ({ accountId, hash: value }));
    });

  const verify: PasswordCredentialShape["verify"] = (claimant, candidate) =>
    withTimingFloor(
      Effect.gen(function* () {
        const found = yield* claimant;
        const credential = Option.isSome(found)
          ? yield* stored(found.value.id)
          : Option.none<Stored>();
        // BEH-EA-114: one real verify on every attempt, against the dummy when there is nothing to match.
        const matched = yield* verifyHash(
          candidate,
          Option.match(credential, { onNone: () => dummyHash, onSome: (c) => c.hash }),
        );
        if (!matched || Option.isNone(found) || Option.isNone(credential)) return refused;
        const verdict: Verdict<typeof found.value> = {
          _tag: "Verified",
          claimant: found.value,
          proof: proof({ ...credential.value, candidate }),
        };
        return verdict;
      }),
    );

  const rehashIfStale: PasswordCredentialShape["rehashIfStale"] = Effect.fnUntraced(
    function* (proven) {
      const config = yield* configNow;
      if (!config.rehashOnLogin || !hasher.needsRehash(Redacted.value(proven.hash))) return;
      const rehashed = yield* hasher.hash(proven.candidate);
      yield* accounts
        .updateCredentialHash(proven.accountId, Redacted.make(rehashed))
        // Unlinked since the proof: nothing left to upgrade.
        .pipe(Effect.catchTag("AccountNotFound", () => Effect.void));
    },
  );

  const accept: PasswordCredentialShape["accept"] = Effect.fnUntraced(function* (candidate) {
    const hints = yield* policyHints(httpClient, digest, candidate, yield* configNow);
    if (hints.length > 0) return yield* Effect.fail(new PasswordApi.WeakPassword({ hints }));
    return accepted({ candidate });
  });

  const linkFor: PasswordCredentialShape["linkFor"] = (password) =>
    Effect.map(hasher.hash(password.candidate), (hash) => (user: Users.UserRecord) => ({
      providerId: Accounts.PASSWORD_PROVIDER_ID,
      subject: user.id,
      credentialHash: Redacted.make(hash),
    }));

  return { verify, rehashIfStale, accept, linkFor };
});

/** The password credential module, exposed by `Password.layer` (ADR-EA-040) under the plugin's namespace. */
export class PasswordCredential extends Context.Service<
  PasswordCredential,
  PasswordCredentialShape
>()("awthaq/plugin/password/Credential") {
  static readonly layer = Layer.effect(PasswordCredential, make);
}
