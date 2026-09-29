// @awthaq/two-factor — SecondFactor
//
// THS-001 steps 2 and 5-8, THS-004/005/007, BCR-002/006 (BEH-EA-260 to BEH-EA-266): the domain
// service behind both the HTTP plugin (`TwoFactor`) and the two hook gates. It owns everything
// about *a user's second factor* — enrolling it, checking a presented code against it, its recovery
// codes, the failure budget and the sign-in challenge — and nothing about HTTP or sessions, so the
// gates (which must exist before the plugin class does, see `TwoFactor.ts`) and the plugin share one
// implementation instead of two copies.
//
// - **Secrets are encrypted, never hashed** (a TOTP secret must be decryptable to compute the running
//   code): the `Encryption` port (AES-256-GCM over `KeyProvider`) with AAD `two_factor_secret:<userId>`,
//   so a ciphertext copied to another row fails authentication. A read under a retired key re-encrypts
//   lazily (the `Decrypted.staleKid` convention). ADR-EA-020 decision 1.
// - **A code passes at most once** (RFC 6238 §5.2): the matched step is compare-and-set into
//   `lastUsedStep`; a second presentation of the same step — or a concurrent one — is refused.
// - **Recovery codes are hashed with the `PasswordHasher` port** and spent by one compare-and-set.
//   A presented code is checked against every unused hash, so the time taken does not say which
//   (if any) matched.
// - **One shared failure budget per account** (BCR-006, ADR-EA-020 decision 3): five failures across
//   TOTP, recovery codes and every challenge within fifteen minutes lock the second factor, checked
//   *before* a code is evaluated (a locked account gets no free guess), spent only by failures, and
//   not reset by success — so interleaving right and wrong codes cannot stretch the budget.
// - **The challenge** (`Challenge.ts`) is a `Verification` row; `consumeChallenge` spends it, and the
//   `FactorProof` this service mints is the only witness `Challenge.verified` accepts.

import { AuthEvents, Errors, Sessions, Users, Verification, VerificationLink } from "@awthaq/core";
import { Defects, Encryption, PasswordHasher, RateLimiter } from "@awthaq/ports";
import * as Brand from "effect/Brand";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  CHALLENGE_PURPOSE,
  ChallengePayload,
  TwoFactorChallengeId,
  type ConsumedChallenge,
  type FactorProof,
  type TwoFactorMethodUsed,
} from "./Challenge.ts";
import * as RecoveryCodes from "./RecoveryCodes.ts";
import * as Totp from "./Totp.ts";
import { TwoFactorConfig } from "./TwoFactorConfig.ts";
import {
  InvalidTwoFactorCode,
  SecondFactorLocked,
  TwoFactorAlreadyEnabled,
  TwoFactorNotEnabled,
} from "./TwoFactorApi.ts";
import { TwoFactorRecoveryCodes, TwoFactorSecrets, type SecretRecord } from "./TwoFactorStore.ts";

/** What a factor was presented for — carried on the audit events. */
export type Purpose = "enroll" | "signIn" | "credentialReset" | "disable" | "regenerate";

export interface EnrolmentSecret {
  /** The base32 secret, for manual entry. Shown once. */
  readonly secret: Redacted.Redacted<string>;
  /** The `otpauth://` link a QR code carries. Shown once. */
  readonly otpauthUri: Redacted.Redacted<string>;
}

export interface SecondFactorStatus {
  readonly enabled: boolean;
  readonly remainingRecoveryCodes: number;
}

export interface SecondFactorShape {
  /** Whether the user has a *confirmed* second factor (a pending, unconfirmed secret does not count). */
  readonly isEnrolled: (userId: Users.UserId) => Effect.Effect<boolean>;
  readonly status: (userId: Users.UserId) => Effect.Effect<SecondFactorStatus>;
  /** Stores a fresh pending secret (replacing an earlier unconfirmed one) and returns it once. */
  readonly beginEnrolment: (
    userId: Users.UserId,
    accountName: string,
  ) => Effect.Effect<EnrolmentSecret, TwoFactorAlreadyEnabled>;
  /**
   * Confirms the pending secret with its first valid code, activates the factor and mints the
   * recovery codes (returned, formatted for display, once). A wrong code spends the failure budget.
   */
  readonly confirmEnrolment: (
    userId: Users.UserId,
    code: Redacted.Redacted<string>,
  ) => Effect.Effect<
    ReadonlyArray<string>,
    InvalidTwoFactorCode | TwoFactorNotEnabled | TwoFactorAlreadyEnabled | SecondFactorLocked
  >;
  /** A TOTP code, checked against the confirmed secret and spent (its step can never verify again). */
  readonly verifyTotp: (
    userId: Users.UserId,
    code: Redacted.Redacted<string>,
    purpose: Purpose,
  ) => Effect.Effect<FactorProof, InvalidTwoFactorCode | SecondFactorLocked>;
  /** A recovery code, checked against every unused hash and spent. */
  readonly verifyRecoveryCode: (
    userId: Users.UserId,
    code: Redacted.Redacted<string>,
    purpose: Purpose,
  ) => Effect.Effect<FactorProof, InvalidTwoFactorCode | SecondFactorLocked>;
  /** Either: a code shaped like a TOTP is checked as one, anything else as a recovery code. For the endpoints that accept both. */
  readonly check: (
    userId: Users.UserId,
    code: Redacted.Redacted<string>,
    purpose: Purpose,
  ) => Effect.Effect<FactorProof, InvalidTwoFactorCode | SecondFactorLocked>;
  /** BCR-002: replaces the whole recovery-code set in one transaction; the caller has already verified the user. */
  readonly regenerateRecoveryCodes: (userId: Users.UserId) => Effect.Effect<ReadonlyArray<string>>;
  /** Removes the secret and every recovery code. The caller has already verified the user. */
  readonly disable: (userId: Users.UserId) => Effect.Effect<void>;
  /** Mints the challenge a divert hands the client (superseding any live one for the account). */
  readonly issueChallenge: (input: {
    readonly userId: Users.UserId;
    readonly strategy: string;
    readonly amr: ReadonlyArray<Sessions.AuthMethod>;
    readonly attempt: number;
  }) => Effect.Effect<TwoFactorChallengeId, Errors.StoreUnavailable>;
  /** Spends a challenge. Every failure — malformed, unknown, expired, replayed, foreign — is the one `InvalidTwoFactorCode`. */
  readonly consumeChallenge: (
    challengeId: Redacted.Redacted<string>,
  ) => Effect.Effect<ConsumedChallenge, InvalidTwoFactorCode | Errors.StoreUnavailable>;
}

export class SecondFactor extends Context.Service<SecondFactor, SecondFactorShape>()(
  "awthaq/two-factor/SecondFactor",
) {}

/** AAD binding a secret's envelope to its owner (ADR-EA-020). */
const secretAad = (userId: Users.UserId): string => `two_factor_secret:${userId}`;

/** BCR-006: the shared per-account failure bucket. */
export const failureKey = (userId: string): string => `two_factor:fail:${userId}`;

// The brand's one constructor — module-private, so a `FactorProof` only ever comes out of `check*` below.
const proofOf = Brand.nominal<FactorProof>();

export const layer = Layer.effect(
  SecondFactor,
  Effect.gen(function* () {
    const secrets = yield* TwoFactorSecrets;
    const codes = yield* TwoFactorRecoveryCodes;
    const encryption = yield* Encryption.Encryption;
    const hasher = yield* PasswordHasher.PasswordHasher;
    const verification = yield* Verification.Verification;
    const crypto = yield* Crypto.Crypto;
    const limiter = yield* RateLimiter.RateLimiter;
    const events = yield* AuthEvents.AuthEvents;
    const config = yield* TwoFactorConfig;

    // ---- the failure budget (BCR-006) ------------------------------------------------------

    const budget = {
      key: (userId: Users.UserId) => failureKey(userId),
      limit: config.failureLimit,
      window: config.failureWindow,
    };

    /** Refuses before anything is evaluated once the budget is spent. */
    const assertNotLocked = (userId: Users.UserId) =>
      limiter
        .check({ key: budget.key(userId), limit: budget.limit, window: budget.window })
        .pipe(
          Effect.catchTag("RateLimitExceeded", (error) =>
            Effect.fail(new SecondFactorLocked({ retryAfterMillis: error.retryAfterMillis })),
          ),
        );

    /** Charges one failure, publishes it, and announces the lock at the moment it takes effect. */
    const recordFailure = Effect.fnUntraced(function* (
      userId: Users.UserId,
      method: TwoFactorMethodUsed,
      purpose: Purpose,
    ) {
      yield* limiter
        .consume({ key: budget.key(userId), limit: budget.limit, window: budget.window })
        .pipe(Effect.ignore);
      yield* events.publish({ _tag: "auth.twoFactor.challengeFailed", userId, method, purpose });
      const nowLocked = yield* limiter
        .check({ key: budget.key(userId), limit: budget.limit, window: budget.window })
        .pipe(
          Effect.as(false),
          Effect.catchTag("RateLimitExceeded", () => Effect.succeed(true)),
        );
      if (nowLocked) yield* events.publish({ _tag: "auth.twoFactor.locked", userId });
    });

    const refuse = Effect.fnUntraced(function* (
      userId: Users.UserId,
      method: TwoFactorMethodUsed,
      purpose: Purpose,
    ) {
      yield* recordFailure(userId, method, purpose);
      return yield* Effect.fail(new InvalidTwoFactorCode({}));
    });

    // ---- the secret ---------------------------------------------------------------------------

    /** Decrypts the stored secret (re-encrypting it under the current key when it was written under a retired one). */
    const readSecret = Effect.fnUntraced(function* (record: SecretRecord) {
      const decrypted = yield* encryption.decrypt(record.envelope, secretAad(record.userId)).pipe(
        Effect.catchTags({
          DecryptionFailed: () =>
            Defects.invariantViolation(
              "TwoFactorSecretUnreadable",
              "awthaq: a stored two-factor secret failed authentication (wrong key or a moved row)",
            ),
          UnknownKeyId: () =>
            Defects.invariantViolation(
              "TwoFactorSecretUnreadable",
              "awthaq: a stored two-factor secret was written under a key the KeyProvider no longer knows",
            ),
        }),
      );
      if (Option.isSome(decrypted.staleKid)) {
        const fresh = yield* encryption.encrypt(decrypted.plaintext, secretAad(record.userId));
        yield* secrets.reencrypt(record.userId, record.envelope, fresh);
      }
      return yield* Option.match(Totp.base32Decode(Redacted.value(decrypted.plaintext)), {
        onNone: () =>
          Defects.invariantViolation(
            "TwoFactorSecretUnreadable",
            "awthaq: a stored two-factor secret is not base32",
          ),
        onSome: Effect.succeed,
      });
    });

    /** The step `code` matches for `record`'s secret, if any (after `lastUsedStep`). */
    const matchStep = Effect.fnUntraced(function* (record: SecretRecord, presented: string) {
      const key = yield* readSecret(record);
      const now = yield* DateTime.now;
      return yield* Totp.verifyTotp(
        crypto,
        key,
        presented.replaceAll(/\s/g, ""),
        Math.floor(DateTime.toEpochMillis(now) / 1000),
        {
          period: config.period,
          digits: config.digits,
          window: config.window,
          lastUsedStep: record.lastUsedStep,
        },
      ).pipe(Effect.orDie);
    });

    const isEnrolled: SecondFactorShape["isEnrolled"] = (userId) =>
      secrets
        .find(userId)
        .pipe(
          Effect.map((record) => Option.isSome(record) && Option.isSome(record.value.confirmedAt)),
        );

    const status: SecondFactorShape["status"] = Effect.fnUntraced(function* (userId) {
      const enabled = yield* isEnrolled(userId);
      return { enabled, remainingRecoveryCodes: enabled ? yield* codes.countUnused(userId) : 0 };
    });

    // ---- recovery codes (BCR-002) -------------------------------------------------------------

    const mintRecoveryCodes = Effect.fnUntraced(function* (userId: Users.UserId) {
      const plain = yield* RecoveryCodes.generate(
        crypto,
        config.recoveryCodeCount,
        config.recoveryCodeLength,
      ).pipe(Effect.orDie);
      const hashes: Array<PasswordHasher.PhcHash> = [];
      for (const code of plain) hashes.push(yield* hasher.hash(Redacted.make(code)));
      yield* codes.replaceAll(userId, hashes);
      return plain.map(RecoveryCodes.display);
    });

    // ---- enrolment ----------------------------------------------------------------------------

    const beginEnrolment: SecondFactorShape["beginEnrolment"] = Effect.fnUntraced(
      function* (userId, accountName) {
        if (yield* isEnrolled(userId)) return yield* Effect.fail(new TwoFactorAlreadyEnabled());
        // 160 bits (RFC 4226 §4 R6: at least 128, 160 recommended).
        const bytes = yield* crypto.randomBytes(20).pipe(Effect.orDie);
        const secret = Totp.base32Encode(bytes);
        const envelope = yield* encryption.encrypt(Redacted.make(secret), secretAad(userId));
        // False = a confirmed row appeared meanwhile: still "already enabled", nothing was written.
        if (!(yield* secrets.upsertPending(userId, envelope))) {
          return yield* Effect.fail(new TwoFactorAlreadyEnabled());
        }
        return {
          secret: Redacted.make(secret),
          otpauthUri: Redacted.make(
            Totp.otpauthUri({
              issuer: config.issuer,
              accountName,
              secret,
              period: config.period,
              digits: config.digits,
            }),
          ),
        };
      },
    );

    const confirmEnrolment: SecondFactorShape["confirmEnrolment"] = Effect.fnUntraced(
      function* (userId, code) {
        yield* assertNotLocked(userId);
        const record = yield* secrets.find(userId);
        if (Option.isNone(record)) return yield* Effect.fail(new TwoFactorNotEnabled());
        if (Option.isSome(record.value.confirmedAt)) {
          return yield* Effect.fail(new TwoFactorAlreadyEnabled());
        }
        const step = yield* matchStep(record.value, Redacted.value(code));
        if (Option.isNone(step)) return yield* refuse(userId, "totp", "enroll");
        // A lost race (a concurrent confirm won) reads exactly like a wrong code.
        if (!(yield* secrets.confirm(userId, step.value)))
          return yield* refuse(userId, "totp", "enroll");
        const display = yield* mintRecoveryCodes(userId);
        yield* events.publish({ _tag: "auth.twoFactor.enabled", userId });
        return display;
      },
    );

    // ---- presenting a factor ---------------------------------------------------------------------

    const verifyTotpCode: SecondFactorShape["verifyTotp"] = Effect.fnUntraced(
      function* (userId, code, purpose) {
        yield* assertNotLocked(userId);
        const record = yield* secrets.find(userId);
        // No confirmed factor (never enrolled, or disabled since the challenge): the same refusal as a wrong code.
        if (Option.isNone(record) || Option.isNone(record.value.confirmedAt)) {
          return yield* refuse(userId, "totp", purpose);
        }
        const step = yield* matchStep(record.value, Redacted.value(code));
        if (Option.isNone(step)) return yield* refuse(userId, "totp", purpose);
        // THS-005: the compare-and-set is what makes the code single-use; losing it is a replay.
        if (!(yield* secrets.advanceLastUsedStep(userId, step.value))) {
          return yield* refuse(userId, "totp", purpose);
        }
        yield* events.publish({ _tag: "auth.twoFactor.verified", userId, method: "totp", purpose });
        return proofOf({ userId, method: "totp" });
      },
    );

    const verifyRecoveryCode: SecondFactorShape["verifyRecoveryCode"] = Effect.fnUntraced(
      function* (userId, code, purpose) {
        yield* assertNotLocked(userId);
        if (!(yield* isEnrolled(userId))) return yield* refuse(userId, "recovery", purpose);
        const candidate = RecoveryCodes.normalize(Redacted.value(code));
        // A code that cannot be one is refused without running a single password hash.
        if (!RecoveryCodes.isWellFormed(candidate, config.recoveryCodeLength)) {
          return yield* refuse(userId, "recovery", purpose);
        }
        const unused = yield* codes.listUnused(userId);
        // Every unused hash is verified — no early exit — so the time does not say which one matched.
        let matched: string | undefined;
        for (const row of unused) {
          const ok = yield* hasher.verify(Redacted.make(candidate), Redacted.value(row.codeHash));
          if (ok && matched === undefined) matched = row.id;
        }
        if (matched === undefined) return yield* refuse(userId, "recovery", purpose);
        // Single-use: the compare-and-set is the spend. Losing it (a concurrent presentation) is a refusal.
        if (!(yield* codes.markUsed(userId, matched)))
          return yield* refuse(userId, "recovery", purpose);
        yield* events.publish({
          _tag: "auth.twoFactor.recoveryCodeUsed",
          userId,
          remaining: yield* codes.countUnused(userId),
        });
        yield* events.publish({
          _tag: "auth.twoFactor.verified",
          userId,
          method: "recovery",
          purpose,
        });
        return proofOf({ userId, method: "recovery" });
      },
    );

    const check: SecondFactorShape["check"] = (userId, code, purpose) => {
      const shaped = Redacted.value(code).replaceAll(/\s/g, "");
      return /^[0-9]+$/.test(shaped) && shaped.length === config.digits
        ? verifyTotpCode(userId, code, purpose)
        : verifyRecoveryCode(userId, code, purpose);
    };

    const regenerateRecoveryCodes: SecondFactorShape["regenerateRecoveryCodes"] = Effect.fnUntraced(
      function* (userId) {
        const display = yield* mintRecoveryCodes(userId);
        yield* events.publish({ _tag: "auth.twoFactor.recoveryCodesRegenerated", userId });
        return display;
      },
    );

    const disable: SecondFactorShape["disable"] = Effect.fnUntraced(function* (userId) {
      yield* secrets.delete(userId);
      yield* codes.deleteAllByUser(userId);
      yield* events.publish({ _tag: "auth.twoFactor.disabled", userId });
    });

    // ---- the challenge (THS-007) ------------------------------------------------------------------

    const issueChallenge: SecondFactorShape["issueChallenge"] = Effect.fnUntraced(
      function* (input) {
        const issued = yield* verification.issue({
          identifier: VerificationLink.identifierOf(CHALLENGE_PURPOSE, input.userId),
          ttl: config.challengeTtl,
          userId: input.userId,
          payload: { strategy: input.strategy, amr: input.amr, attempt: input.attempt },
        });
        return TwoFactorChallengeId(
          Redacted.value(
            VerificationLink.encode({
              purpose: CHALLENGE_PURPOSE,
              publicId: input.userId,
              value: issued.value,
            }),
          ),
        );
      },
    );

    const decodePayload = Schema.decodeUnknownOption(ChallengePayload);

    const consumeChallenge: SecondFactorShape["consumeChallenge"] = Effect.fnUntraced(
      function* (challengeId) {
        const invalid = new InvalidTwoFactorCode({});
        const decoded = VerificationLink.decode(Redacted.value(challengeId), CHALLENGE_PURPOSE);
        if (Option.isNone(decoded)) return yield* Effect.fail(invalid);
        // The identifier is derived from the claimed user, so a challenge cannot be spent as another's.
        const consumed = yield* verification
          .consume(decoded.value.identifier, decoded.value.value)
          .pipe(Effect.catchTag("Verification/TokenConsumed", () => Effect.fail(invalid)));
        const payload = decodePayload(consumed.payload);
        if (Option.isNone(payload) || Option.isNone(consumed.userId))
          return yield* Effect.fail(invalid);
        return {
          userId: consumed.userId.value,
          strategy: payload.value.strategy,
          amr: payload.value.amr.filter(Sessions.isAuthMethod),
          attempt: payload.value.attempt,
        };
      },
    );

    return SecondFactor.of({
      isEnrolled,
      status,
      beginEnrolment,
      confirmEnrolment,
      verifyTotp: verifyTotpCode,
      verifyRecoveryCode,
      check,
      regenerateRecoveryCodes,
      disable,
      issueChallenge,
      consumeChallenge,
    });
  }),
);
