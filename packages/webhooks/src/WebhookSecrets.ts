// @awthaq/webhooks — WebhookSecrets
//
// CWM-004 / plan 05: an endpoint's signing secret and custom headers are `SealedColumn`s (see
// `WebhookRecords`); the records hand out `Sealed` values and own the AAD, the legacy spelling and the
// re-seal. What stays here is the call-site policy for a value that does not open (ADR-EA-019
// decision 6): `SealedColumn.option`, which degrades that one value to `None` with a warning. The
// plaintext exists in memory for one signing call and once on the wire to the administrator who
// created or rotated the secret.

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { SealedColumn } from "@awthaq/sql";
import type * as WebhookHeaders from "./WebhookHeaders.ts";
import type { EndpointRecord } from "./WebhookRecords.ts";

/**
 * The custom headers an attempt adds. No headers stored is an empty set; a sealed value that does not open (a retired
 * key, a row copied from another endpoint) or does not decode is `None`: the attempt then fails as `secret` and is not sent.
 */
export const openHeaders = (endpoint: EndpointRecord) =>
  Option.isNone(endpoint.headers)
    ? Effect.succeed(Option.some<WebhookHeaders.CustomHeaders>({}))
    : Effect.map(SealedColumn.option(endpoint.headers.value.open), Option.map(Redacted.value));

/**
 * The secrets an attempt signs with: the current one, and the previous one while its grace window is
 * open (both signatures are sent, so a receiver that has not switched yet still verifies). `None` when
 * the current secret does not open (a retired key, a tampered row) — the attempt then fails as
 * `secret`; a previous secret that does not open is simply dropped.
 */
export const open = (endpoint: EndpointRecord, now: DateTime.Utc) =>
  Effect.gen(function* () {
    const current = yield* SealedColumn.option(endpoint.secret.open);
    if (Option.isNone(current)) return Option.none<ReadonlyArray<Redacted.Redacted<string>>>();
    const secrets: Array<Redacted.Redacted<string>> = [current.value];
    const graceOpen =
      Option.isSome(endpoint.previousSecretExpiresAt) &&
      DateTime.toEpochMillis(endpoint.previousSecretExpiresAt.value) > DateTime.toEpochMillis(now);
    if (graceOpen && Option.isSome(endpoint.previousSecret)) {
      const previous = yield* SealedColumn.option(endpoint.previousSecret.value.open);
      if (Option.isSome(previous)) secrets.push(previous.value);
    }
    return Option.some(secrets);
  });
