// Shared event fixtures (plan 09): one sample per `AuthEvent` tag. The mapped type makes adding an
// event without a sample a compile error, so every suite that walks the registry stays complete.
import type * as AuthEvents from "../../src/AuthEvents.ts";
import { SessionId } from "../../src/Sessions.ts";
import { UserId } from "../../src/Users.ts";

export const userId = UserId("11111111-1111-1111-1111-111111111111");
export const otherUserId = UserId("22222222-2222-2222-2222-222222222222");
export const sessionId = SessionId("33333333-3333-3333-3333-333333333333");

/** One sample per tag; the mapped type makes adding an `AuthEvent` without one a compile error. */
export const samples: { readonly [Tag in AuthEvents.AuthEventTag]: AuthEvents.EventOf<Tag> } = {
  "auth.token.replay": { _tag: "auth.token.replay", identifier: "verify-email:u1" },
  "auth.user.created": { _tag: "auth.user.created", userId },
  "auth.user.signedIn": { _tag: "auth.user.signedIn", userId, strategy: "password" },
  "auth.user.signInFailed": {
    _tag: "auth.user.signInFailed",
    strategy: "password",
    reason: "invalidCredentials",
    clientIp: "203.0.113.5",
    identifierDigest: "ab12",
  },
  "auth.user.deleted": { _tag: "auth.user.deleted", userId, deletedBy: "self" },
  "auth.user.dataExported": { _tag: "auth.user.dataExported", userId, requestedBy: "self" },
  "auth.session.reuse": {
    _tag: "auth.session.reuse",
    sessionId,
    familyId: "fam-1",
    userId,
  },
  "auth.session.issued": {
    _tag: "auth.session.issued",
    sessionId,
    userId,
    familyId: "fam-1",
    actingAs: { type: "user", id: "admin-1" },
  },
  "auth.session.rotated": { _tag: "auth.session.rotated", sessionId, familyId: "fam-1", userId },
  "auth.session.superseded": {
    _tag: "auth.session.superseded",
    sessionId,
    supersededBy: sessionId,
    familyId: "fam-1",
    userId,
  },
  "auth.session.revoked": {
    _tag: "auth.session.revoked",
    userId,
    sessionId: null,
    scope: "all",
    reason: "signOut",
  },
  "auth.session.expired": { _tag: "auth.session.expired", sessionId, userId, kind: "idle" },
  "auth.password.changed": { _tag: "auth.password.changed", userId },
  "auth.passkey.counterAnomaly": {
    _tag: "auth.passkey.counterAnomaly",
    userId,
    credentialId: "cred-1",
  },
  "auth.admin.impersonationDenied": {
    _tag: "auth.admin.impersonationDenied",
    adminUserId: otherUserId,
    operation: "impersonate",
    targetUserId: userId,
  },
  "auth.admin.actionDenied": {
    _tag: "auth.admin.actionDenied",
    adminUserId: otherUserId,
    action: "listUsers",
  },
  "auth.authz.denied": {
    _tag: "auth.authz.denied",
    subjectId: `user:${userId}`,
    evaluationId: "eval-1",
    policyTag: "policy",
    action: "read",
    reason: "no matching permit",
  },
  "auth.rateLimit.exceeded": {
    _tag: "auth.rateLimit.exceeded",
    group: "password",
    endpoint: "signIn",
    rule: "signIn",
    dimension: "ip",
    retryAfterMillis: 1000,
  },
  "auth.mail.failed": { _tag: "auth.mail.failed", template: "verify-email", userId },
  "auth.admin.seeded": {
    _tag: "auth.admin.seeded",
    targetUserId: userId,
    outcome: "created",
    forced: false,
    role: "admin",
    via: "cli",
  },
  "auth.admin.seedRefused": { _tag: "auth.admin.seedRefused", reason: "adminExists" },
  "auth.import.completed": {
    _tag: "auth.import.completed",
    source: "better-auth",
    runId: "run-1",
    imported: 2,
    skipped: 0,
    failed: 0,
    unmapped: 1,
  },
  "auth.import.failed": {
    _tag: "auth.import.failed",
    source: "better-auth",
    runId: "run-1",
    imported: 1,
    skipped: 0,
    failed: 1,
    unmapped: 0,
  },
  "auth.account.linked": {
    _tag: "auth.account.linked",
    userId,
    providerId: "acme",
    via: "emailMatch",
  },
};

export const allSamples: ReadonlyArray<AuthEvents.AuthEvent> = Object.values(samples);
