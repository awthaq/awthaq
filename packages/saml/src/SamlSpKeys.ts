// @awthaq/saml — SamlSpKeys
//
// BEH-EA-314: the service provider's signing keys, per connection, at rest. A key is generated here (`SamlKeys`) or brought
// by an operator; its PRIVATE half is stored only as a sealed column of `SamlRecords` (`SealedColumn`, plan 05: an `Encryption` envelope
// whose additional authenticated data names the table, the key and the column, so a sealed key copied into another key's
// row does not decrypt, and a database read (a backup, a replica) discloses nothing that signs). The certificate is public: it
// is published in the SP metadata (`KeyDescriptor use="signing"`) so the IdP can verify what this SP signs.
//
// Several keys per connection are a rotation overlap: the NEWEST unexpired one signs, and every unexpired certificate is
// published, so an IdP that has not refreshed the metadata yet still trusts the previous key until it expires.

import { SealedColumn, StoreFailure } from "@awthaq/sql";
import type { Api } from "@awthaq/api";
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
   * has no signing key. A key that is there but does not open is a DEFECT (`SealedColumn.orDie`, naming the column and
   * the key): a connection that says it signs must never silently send unsigned.
   */
  readonly signingKey: (connectionId: string) => Effect.Effect<
    Option.Option<{
      readonly privateKeyPem: Redacted.Redacted<string>;
      readonly certificate: string;
      readonly fingerprint: string;
    }>,
    Api.StoreUnavailable
  >;
  /** Every certificate (PEM) of the connection that has not expired: what the SP metadata publishes. */
  readonly certificates: (
    connectionId: string,
  ) => Effect.Effect<ReadonlyArray<string>, Api.StoreUnavailable>;
  /** A fresh key and self-signed certificate, stored sealed. It signs from now on; the previous keeps being published until it expires. */
  readonly generate: (
    connectionId: string,
  ) => Effect.Effect<SpKeySummary, SamlKeys.InvalidSigningKey | Api.StoreUnavailable>;
  /** A key pair the operator brings (validated: RSA >= 2048 bits, the certificate is for the key), stored sealed. */
  readonly importKey: (
    connectionId: string,
    input: { readonly privateKeyPem: Redacted.Redacted<string>; readonly certificatePem: string },
  ) => Effect.Effect<SpKeySummary, SamlKeys.InvalidSigningKey | Api.StoreUnavailable>;
  readonly list: (
    connectionId: string,
  ) => Effect.Effect<ReadonlyArray<SpKeySummary>, Api.StoreUnavailable>;
}

export class SamlSpKeys extends Context.Service<SamlSpKeys, SamlSpKeysShape>()(
  "awthaq/saml/SamlSpKeys",
) {}

const within = (record: SamlRecords.SpKeyRecord, now: DateTime.Utc) =>
  DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(record.notBefore) &&
  DateTime.toEpochMillis(now) < DateTime.toEpochMillis(record.notAfter);

/** Requires `SamlRecords`, `Crypto` and `SamlConfig`. */
export const layer = Layer.effect(
  SamlSpKeys,
  Effect.gen(function* () {
    const records = yield* SamlRecords.SamlRecords;
    const crypto = yield* Crypto.Crypto;
    const settings = yield* SamlConfig.SamlConfig;

    const store = Effect.fnUntraced(function* (connectionId: string, key: SamlKeys.SigningKey) {
      const id = yield* crypto.randomUUIDv7.pipe(
        Effect.catch(StoreFailure.storeUnavailable("SamlSpKeys.store")),
      );
      const saved = yield* records.saveSpKey({
        id,
        connectionId,
        certificate: key.certificatePem,
        privateKey: Redacted.make(key.privateKeyPem),
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
      // A key that is there but does not open is a defect: a connection that says it signs must never send unsigned.
      const opened = yield* SealedColumn.orDie(chosen.privateKey.open);
      return Option.some({
        privateKeyPem: opened,
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
