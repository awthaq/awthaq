// @awthaq/webhooks — WebhookSecrets
//
// CWM-004: an endpoint's signing secret is stored only as an `Encryption` envelope (AES-GCM under the
// application's `KeyProvider`), with the AAD tying the ciphertext to its endpoint *and* its field, so a
// sealed secret copied into another endpoint's row, or the current secret swapped with the previous
// one, no longer decrypts. The plaintext exists in memory for one signing call and once on the wire to
// the administrator who created or rotated it.

import type { Encryption } from "@awthaq/ports";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { EndpointRecord } from "./WebhookRecords.ts";

export type SecretField = "secret" | "previousSecret";

export const aad = (endpointId: string, field: SecretField): string =>
  `webhooks-endpoint:${endpointId}:${field}`;

export const seal = (
  encryption: Encryption.EncryptionShape,
  endpointId: string,
  field: SecretField,
  plaintext: Redacted.Redacted<string>,
) => encryption.encrypt(plaintext, aad(endpointId, field));

/**
 * The secrets an attempt signs with: the current one, and the previous one while its grace window is
 * open (both signatures are sent, so a receiver that has not switched yet still verifies). `None` when
 * the current secret does not decrypt (a retired key, a tampered row) — the attempt then fails as
 * `secret`; a previous secret that does not decrypt is simply dropped.
 */
export const open = (
  encryption: Encryption.EncryptionShape,
  endpoint: EndpointRecord,
  now: DateTime.Utc,
) =>
  Effect.gen(function* () {
    const current = yield* encryption
      .decrypt(endpoint.secret, aad(endpoint.id, "secret"))
      .pipe(Effect.option);
    if (Option.isNone(current)) return Option.none<ReadonlyArray<Redacted.Redacted<string>>>();
    const secrets: Array<Redacted.Redacted<string>> = [current.value.plaintext];
    const graceOpen =
      Option.isSome(endpoint.previousSecretExpiresAt) &&
      DateTime.toEpochMillis(endpoint.previousSecretExpiresAt.value) > DateTime.toEpochMillis(now);
    if (graceOpen && Option.isSome(endpoint.previousSecret)) {
      const previous = yield* encryption
        .decrypt(endpoint.previousSecret.value, aad(endpoint.id, "previousSecret"))
        .pipe(Effect.option);
      if (Option.isSome(previous)) secrets.push(previous.value.plaintext);
    }
    return Option.some(secrets);
  });
