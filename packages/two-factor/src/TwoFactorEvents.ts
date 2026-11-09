// @awthaq/two-factor — TwoFactorEvents: the events this plugin publishes (ADR-EA-049).
//
// Defined here, in the plugin's own package, declared on the `TwoFactor` class's `events` and published with
// `events.emit(definition, input)` by the package's `SecondFactor` domain module. Core composes them
// (`Auth.make`), records each in the audit log with its actor and attempt lane, and `runPluginContractTests`
// checks each definition. The module imports nothing of the package, so `SecondFactor` publishes through it
// without a cycle.
import { EventDefinition } from "@awthaq/core";
import * as Schema from "effect/Schema";

/**
 * THS-001/AOMS-003/BCR-006 (`@awthaq/two-factor`): the second factor's lifecycle and every
 * failed or successful presentation, so a defender can see enrolment, use of a recovery code
 * (the sign that a device was lost), and lockouts. Identifiers only: no code, secret or hash.
 * `method` names which factor was presented; `purpose` what it was presented for.
 */
export const TwoFactorMethod = Schema.Literals(["totp", "recovery"]);
export type TwoFactorMethod = typeof TwoFactorMethod.Type;

export const TwoFactorPurpose = Schema.Literals([
  "enroll",
  "signIn",
  "credentialReset",
  "disable",
  "regenerate",
]);
export type TwoFactorPurpose = typeof TwoFactorPurpose.Type;

/** Published when a pending secret is confirmed with a first valid code — the factor is now active. */
export const TwoFactorEnabledEvent = EventDefinition.define(
  "auth.twoFactor.enabled",
  {
    userId: EventDefinition.UserId,
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
export type TwoFactorEnabledEvent = typeof TwoFactorEnabledEvent.Type;

/** Published when the factor is removed (secret and recovery codes deleted). */
export const TwoFactorDisabledEvent = EventDefinition.define(
  "auth.twoFactor.disabled",
  {
    userId: EventDefinition.UserId,
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
export type TwoFactorDisabledEvent = typeof TwoFactorDisabledEvent.Type;

/** Published on every successful presentation of a second factor, with the method used. */
export const TwoFactorVerifiedEvent = EventDefinition.define(
  "auth.twoFactor.verified",
  {
    userId: EventDefinition.UserId,
    method: TwoFactorMethod,
    purpose: TwoFactorPurpose,
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
export type TwoFactorVerifiedEvent = typeof TwoFactorVerifiedEvent.Type;

/** Published on every failed presentation (wrong code, replayed step, unknown recovery code). */
export const TwoFactorChallengeFailedEvent = EventDefinition.define(
  "auth.twoFactor.challengeFailed",
  {
    userId: EventDefinition.UserId,
    method: TwoFactorMethod,
    purpose: TwoFactorPurpose,
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
    attempt: true,
  },
);
export type TwoFactorChallengeFailedEvent = typeof TwoFactorChallengeFailedEvent.Type;

/** Published when a recovery code is spent; `remaining` is what is left, for a low-supply warning. */
export const TwoFactorRecoveryCodeUsedEvent = EventDefinition.define(
  "auth.twoFactor.recoveryCodeUsed",
  {
    userId: EventDefinition.UserId,
    remaining: Schema.Number,
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
export type TwoFactorRecoveryCodeUsedEvent = typeof TwoFactorRecoveryCodeUsedEvent.Type;

/** Published when the recovery codes are replaced by a fresh set (the old set is invalid). */
export const TwoFactorRecoveryCodesRegeneratedEvent = EventDefinition.define(
  "auth.twoFactor.recoveryCodesRegenerated",
  { userId: EventDefinition.UserId },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
  },
);
export type TwoFactorRecoveryCodesRegeneratedEvent =
  typeof TwoFactorRecoveryCodesRegeneratedEvent.Type;

/** BCR-006: the shared per-account failure budget was exhausted; the second factor is locked for the window. */
export const TwoFactorLockedEvent = EventDefinition.define(
  "auth.twoFactor.locked",
  {
    userId: EventDefinition.UserId,
  },
  {
    actor: EventDefinition.Actor.field("userId"),
    pii: [],
    attempt: true,
  },
);
export type TwoFactorLockedEvent = typeof TwoFactorLockedEvent.Type;

/** Every event this plugin publishes; the plugin class declares it as `events`. */
export const events = [
  TwoFactorEnabledEvent,
  TwoFactorDisabledEvent,
  TwoFactorVerifiedEvent,
  TwoFactorChallengeFailedEvent,
  TwoFactorRecoveryCodeUsedEvent,
  TwoFactorRecoveryCodesRegeneratedEvent,
  TwoFactorLockedEvent,
];
