// @awthaq/saml — SamlSpKeys
//
// BEH-EA-305: the service provider's signing keys, per connection, at rest. A key is generated here (`SamlKeys`) or brought
// by an operator; its PRIVATE half is stored only as an `Encryption` envelope (the `@awthaq/ports` port over the application's
// `KeyProvider`) whose additional authenticated data names the key and the field, so a sealed key copied into another key's
// row does not decrypt, and a database read (a backup, a replica) discloses nothing that signs. The certificate is public: it
// is published in the SP metadata (`KeyDescriptor use="signing"`) so the IdP can verify what this SP signs.
//
// Several keys per connection are a rotation overlap: the NEWEST unexpired one signs, and every unexpired certificate is
// published, so an IdP that has not refreshed the metadata yet still trusts the previous key until it expires.

import { Encryption } from "@awthaq/ports";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SamlConfig from "./SamlConfig.ts";
import * as SamlKeys from "./SamlKeys.ts";
import * as SamlRecords from "./SamlRecords.ts";

export const aad = (keyId: string): string => `saml-sp-key:${keyId}:privateKey`;

/** A stored key as the outside world may see it: never the private half. */
export interface SpKeySummary {
  readonly id: string;
  readonly connectionId: string;
  readonly fingerprint: string;
  readonly certificate: string;
  readonly notBefore: DateTime.Utc;
  readonly notAfter: DateTime.Utc;
  readonly createdAt: DateTime.Utc;
}

const summaryOf = (record: SamlRecords.SpKeyRecord): SpKeySummary => ({
  id: record.id,
  connectionId: record.connectionId,
  fingerprint: record.fingerprint,
  certificate: record.certificate,
  notBefore: record.notBefore,
  notAfter: record.notAfter,
  createdAt: record.createdAt,
});

export interface SamlSpKeysShape {
  /**
   * The key to sign with now: the newest whose window contains the present, private half opened. `None`: the connection
   * has no signing key. A key that is there but does not open is a DEFECT (a die naming the key):
   * a connection that says it signs must never silently send unsigned.
   */
  readonly signingKey: (connectionId: string) => Effect.Effect<
    Option.Option<{
      readonly privateKeyPem: Redacted.Redacted<string>;
      readonly certificate: string;
      readonly fingerprint: string;
    }>
  >;
  /** Every certificate (PEM) of the connection that has not expired: what the SP metadata publishes. */
  readonly certificates: (connectionId: string) => Effect.Effect<ReadonlyArray<string>>;
  /** A fresh key and self-signed certificate, stored sealed. It signs from now on; the previous keeps being published until it expires. */
  readonly generate: (
    connectionId: string,
  ) => Effect.Effect<SpKeySummary, SamlKeys.InvalidSigningKey>;
  /** A key pair the operator brings (validated: RSA >= 2048 bits, the certificate is for the key), stored sealed. */
  readonly importKey: (
    connectionId: string,
    input: { readonly privateKeyPem: Redacted.Redacted<string>; readonly certificatePem: string },
  ) => Effect.Effect<SpKeySummary, SamlKeys.InvalidSigningKey>;
  readonly list: (connectionId: string) => Effect.Effect<ReadonlyArray<SpKeySummary>>;
}

export class SamlSpKeys extends Context.Service<SamlSpKeys, SamlSpKeysShape>()(
  "awthaq/saml/SamlSpKeys",
) {}

const within = (record: SamlRecords.SpKeyRecord, now: DateTime.Utc) =>
  DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(record.notBefore) &&
  DateTime.toEpochMillis(now) < DateTime.toEpochMillis(record.notAfter);

/** Requires `SamlRecords`, `Encryption`, `Crypto` and `SamlConfig`. */
export const layer = Layer.effect(
  SamlSpKeys,
  Effect.gen(function* () {
    const records = yield* SamlRecords.SamlRecords;
    const encryption = yield* Encryption.Encryption;
    const crypto = yield* Crypto.Crypto;
    const settings = yield* SamlConfig.SamlConfig;

    const store = Effect.fnUntraced(function* (connectionId: string, key: SamlKeys.SigningKey) {
      const id = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
      const sealed = yield* encryption
        .encrypt(Redacted.make(key.privateKeyPem), aad(id))
        .pipe(Effect.orDie);
      const saved = yield* records.saveSpKey({
        id,
        connectionId,
        certificate: key.certificatePem,
        privateKey: sealed,
        fingerprint: key.fingerprint,
        notBefore: key.notBefore,
        notAfter: key.notAfter,
      });
      return summaryOf(saved);
    });

    const signingKey: SamlSpKeysShape["signingKey"] = Effect.fnUntraced(function* (connectionId) {
      const now = yield* DateTime.now;
      const chosen = (yield* records.listSpKeys(connectionId)).find((record) =>
        within(record, now),
      );
      if (chosen === undefined) return Option.none();
      const opened = yield* encryption
        .decrypt(chosen.privateKey, aad(chosen.id))
        .pipe(Effect.option);
      if (Option.isNone(opened)) {
        return yield* Effect.die(
          new Error(
            `awthaq/saml: the signing key ${chosen.id} of connection ${connectionId} cannot be opened`,
          ),
        );
      }
      return Option.some({
        privateKeyPem: opened.value.plaintext,
        certificate: chosen.certificate,
        fingerprint: chosen.fingerprint,
      });
    });

    return SamlSpKeys.of({
      signingKey,
      certificates: (connectionId) =>
        Effect.all([records.listSpKeys(connectionId), DateTime.now]).pipe(
          Effect.map(([keys, now]) =>
            keys
              .filter(
                (record) => DateTime.toEpochMillis(now) < DateTime.toEpochMillis(record.notAfter),
              )
              .map((record) => record.certificate),
          ),
        ),
      generate: (connectionId) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const key = yield* SamlKeys.generateSigningKey({
            commonName: `awthaq SAML SP ${connectionId}`,
            // Backdated a minute: an IdP whose clock is slightly behind must not find the key "not yet valid".
            notBefore: DateTime.subtractDuration(now, "1 minute"),
            validityDays: settings.signingKeyValidityDays,
          });
          return yield* store(connectionId, key);
        }),
      importKey: (connectionId, input) =>
        SamlKeys.describeSigningKey(Redacted.value(input.privateKeyPem), input.certificatePem).pipe(
          Effect.flatMap((key) => store(connectionId, key)),
        ),
      list: (connectionId) =>
        records.listSpKeys(connectionId).pipe(Effect.map((keys) => keys.map(summaryOf))),
    });
  }),
);
